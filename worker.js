const { parentPort, workerData } = require("worker_threads");
const { ethers } = require("ethers");

const provider = new ethers.providers.JsonRpcProvider(workerData.rpcUrl);

const pairAbi = [
    "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)",
    "function token0() view returns (address)"
];
const quoterAbi = [
    "function quoteExactInputSingle(address,address,uint24,uint256,uint160) view returns (uint256)"
];
const multicallAbi = [
    "function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)",
    "function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)"
];

const DEX = {
    V2: 0,
    V3: 2
};

const COARSE_SAMPLES = Number.isFinite(Number(workerData.coarseSamples)) ? Math.max(3, Number(workerData.coarseSamples)) : 6;
const V3_PLANS_PER_PAIR = Number.isFinite(Number(workerData.v3PlansPerPair)) ? Math.max(1, Number(workerData.v3PlansPerPair)) : 2;
const MIN_V2_EDGE_BPS_FOR_V3 = Number.isFinite(Number(workerData.minV2EdgeBpsForV3)) ? Number(workerData.minV2EdgeBpsForV3) : -50;

const pairIface = new ethers.utils.Interface(pairAbi);
const quoterIface = new ethers.utils.Interface(quoterAbi);
const getReservesData = pairIface.encodeFunctionData("getReserves", []);

function getAmountOut(amountIn, reserveIn, reserveOut) {
    const inWithFee = amountIn.mul(997);
    const num = inWithFee.mul(reserveOut);
    const den = reserveIn.mul(1000).add(inWithFee);
    return num.div(den);
}

function owedWithPremium(loan) {
    return loan.mul(10009).div(10000);
}

function parseFeeList(input) {
    if (!Array.isArray(input)) return [500, 3000, 10000];
    const out = input.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
    return out.length ? out : [500, 3000, 10000];
}

const v3Fees = parseFeeList(workerData.v3Fees);
const quoter = new ethers.Contract(
    (workerData.quoter || "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6").toLowerCase(),
    quoterAbi,
    provider
);
const multicall = new ethers.Contract(
    (workerData.multicall2 || "0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696").toLowerCase(),
    multicallAbi,
    provider
);

const uniRouter = (workerData.uniV2Router || "").toLowerCase();
const sushiRouter = (workerData.sushiV2Router || "").toLowerCase();
const altRouter = (workerData.altV2Router || "").toLowerCase();

const pairs = workerData.tokens.map((t) => {
    const out = {
        symbol: t.symbol,
        token: t.token.toLowerCase(),
        uni: new ethers.Contract(t.uniPair.toLowerCase(), pairAbi, provider),
        sushi: new ethers.Contract(t.sushiPair.toLowerCase(), pairAbi, provider),
        uniTok0: null,
        sushiTok0: null,
        alt: null,
        altTok0: null,
        altRouter: altRouter || ""
    };
    if (t.altPair) {
        out.alt = new ethers.Contract(t.altPair.toLowerCase(), pairAbi, provider);
    }
    return out;
});

let token0Initialized = false;
async function ensureToken0() {
    if (token0Initialized) return;
    await Promise.all(
        pairs.map(async (p) => {
            const calls = [p.uni.token0(), p.sushi.token0()];
            if (p.alt) calls.push(p.alt.token0());
            const res = await Promise.all(calls);
            p.uniTok0 = res[0].toLowerCase();
            p.sushiTok0 = res[1].toLowerCase();
            if (p.alt) p.altTok0 = res[2].toLowerCase();
        })
    );
    token0Initialized = true;
}

async function batchV3Quotes(token, weth, loan, outV2Amounts) {
    if (!v3Fees.length) return { buy: [], sell: [] };

    const calls = [];
    for (const fee of v3Fees) {
        calls.push({
            target: quoter.address,
            callData: quoterIface.encodeFunctionData("quoteExactInputSingle", [weth, token, fee, loan, 0])
        });
        for (const outAmt of outV2Amounts) {
            calls.push({
                target: quoter.address,
                callData: quoterIface.encodeFunctionData("quoteExactInputSingle", [token, weth, fee, outAmt, 0])
            });
        }
    }

    const ret = await multicall.tryAggregate(false, calls);
    const buy = [];
    const sell = [];
    let idx = 0;
    for (let i = 0; i < v3Fees.length; i++) {
        const b = ret[idx++];
        buy.push(b.success ? quoterIface.decodeFunctionResult("quoteExactInputSingle", b.returnData)[0] : null);

        const feeSells = [];
        for (let j = 0; j < outV2Amounts.length; j++) {
            const s = ret[idx++];
            feeSells.push(s.success ? quoterIface.decodeFunctionResult("quoteExactInputSingle", s.returnData)[0] : null);
        }
        sell.push(feeSells);
    }

    return { buy, sell };
}

parentPort.on("message", async ({ blockNumber, amount }) => {
    try {
        await ensureToken0();

        const AMT = ethers.BigNumber.from(amount);
        const WETH = workerData.WETH.toLowerCase();
        const minLoan = ethers.utils.parseEther("0.1");
        if (AMT.lt(minLoan)) {
            parentPort.postMessage({ blockNumber, profit: "-1", loan: "0", symbol: null });
            return;
        }

        const reserveCalls = [];
        for (const p of pairs) {
            reserveCalls.push({ target: p.uni.address, callData: getReservesData });
            reserveCalls.push({ target: p.sushi.address, callData: getReservesData });
            if (p.alt) reserveCalls.push({ target: p.alt.address, callData: getReservesData });
        }
        const reserveData = (await multicall.aggregate(reserveCalls)).returnData;

        const span = AMT.sub(minLoan);
        let idx = 0;

        let best = {
            profit: ethers.constants.NegativeOne,
            loan: ethers.constants.Zero,
            symbol: null,
            firstDex: DEX.V2,
            secondDex: DEX.V2,
            firstV2Router: uniRouter,
            secondV2Router: sushiRouter,
            firstFee: 0,
            secondFee: 0
        };

        for (const p of pairs) {
            const [u0, u1] = pairIface.decodeFunctionResult("getReserves", reserveData[idx++]);
            const [s0, s1] = pairIface.decodeFunctionResult("getReserves", reserveData[idx++]);

            const venues = [];
            const [uW, uT] = p.uniTok0 === WETH ? [u0, u1] : [u1, u0];
            const [sW, sT] = p.sushiTok0 === WETH ? [s0, s1] : [s1, s0];
            if (uniRouter) venues.push({ router: uniRouter, w: uW, t: uT });
            if (sushiRouter) venues.push({ router: sushiRouter, w: sW, t: sT });

            if (p.alt) {
                const [a0, a1] = pairIface.decodeFunctionResult("getReserves", reserveData[idx++]);
                const [aW, aT] = p.altTok0 === WETH ? [a0, a1] : [a1, a0];
                if (p.altRouter) venues.push({ router: p.altRouter, w: aW, t: aT });
            }

            if (venues.length < 2) continue;

            const plans = [];
            let localBestV2 = ethers.constants.NegativeOne;
            let localBestIdx = 0;

            for (let si = 0; si <= COARSE_SAMPLES; si++) {
                const loan = minLoan.add(span.mul(si).div(COARSE_SAMPLES));
                const owed = owedWithPremium(loan);

                const outByVenue = venues.map((v) => getAmountOut(loan, v.w, v.t));

                for (let i = 0; i < venues.length; i++) {
                    for (let j = 0; j < venues.length; j++) {
                        if (i === j) continue;
                        const back = getAmountOut(outByVenue[i], venues[j].t, venues[j].w);
                        const pV2 = back.sub(owed);
                        if (pV2.gt(best.profit)) {
                            best = {
                                profit: pV2,
                                loan,
                                symbol: p.symbol,
                                firstDex: DEX.V2,
                                secondDex: DEX.V2,
                                firstV2Router: venues[i].router,
                                secondV2Router: venues[j].router,
                                firstFee: 0,
                                secondFee: 0
                            };
                        }
                        if (pV2.gt(localBestV2)) {
                            localBestV2 = pV2;
                            localBestIdx = si;
                        }
                    }
                }

                plans.push({ loan, owed, outByVenue });
            }

            const gate = plans[localBestIdx].loan.mul(MIN_V2_EDGE_BPS_FOR_V3).div(10000);
            if (localBestV2.lt(gate)) continue;

            const candidateIdx = [localBestIdx, localBestIdx - 1, localBestIdx + 1]
                .filter((x) => x >= 0 && x < plans.length);
            const dedupIdx = [...new Set(candidateIdx)].slice(0, V3_PLANS_PER_PAIR);

            for (const pi of dedupIdx) {
                const plan = plans[pi];
                const v3 = await batchV3Quotes(p.token, WETH, plan.loan, plan.outByVenue);

                for (let f = 0; f < v3Fees.length; f++) {
                    const fee = v3Fees[f];
                    const buyOut = v3.buy[f];

                    if (buyOut) {
                        for (let j = 0; j < venues.length; j++) {
                            const back = getAmountOut(buyOut, venues[j].t, venues[j].w);
                            const pV3ThenV2 = back.sub(plan.owed);
                            if (pV3ThenV2.gt(best.profit)) {
                                best = {
                                    profit: pV3ThenV2,
                                    loan: plan.loan,
                                    symbol: p.symbol,
                                    firstDex: DEX.V3,
                                    secondDex: DEX.V2,
                                    firstV2Router: ethers.constants.AddressZero,
                                    secondV2Router: venues[j].router,
                                    firstFee: fee,
                                    secondFee: 0
                                };
                            }
                        }
                    }

                    const sellRow = v3.sell[f] || [];
                    for (let i = 0; i < sellRow.length; i++) {
                        const sell = sellRow[i];
                        if (!sell) continue;
                        const pV2ThenV3 = sell.sub(plan.owed);
                        if (pV2ThenV3.gt(best.profit)) {
                            best = {
                                profit: pV2ThenV3,
                                loan: plan.loan,
                                symbol: p.symbol,
                                firstDex: DEX.V2,
                                secondDex: DEX.V3,
                                firstV2Router: venues[i].router,
                                secondV2Router: ethers.constants.AddressZero,
                                firstFee: 0,
                                secondFee: fee
                            };
                        }
                    }
                }
            }
        }

        parentPort.postMessage({
            blockNumber,
            profit: best.profit.toString(),
            loan: best.loan.toString(),
            symbol: best.symbol,
            firstDex: best.firstDex,
            secondDex: best.secondDex,
            firstV2Router: best.firstV2Router,
            secondV2Router: best.secondV2Router,
            firstFee: best.firstFee,
            secondFee: best.secondFee
        });
    } catch (e) {
        parentPort.postMessage({ error: e.message });
    }
});
