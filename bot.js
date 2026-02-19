require("dotenv").config();
const { Worker } = require("worker_threads");
const { ethers } = require("ethers");
const { FlashbotsBundleProvider } = require("@flashbots/ethers-provider-bundle");
const arbJson = require("./artifacts/contracts/ArbExecutor.sol/ArbExecutor.json");

(async () => {
    const {
        PRIVATE_KEY,
        WSS_URL,
        CONTRACT_ADDRESS,
        AMOUNT = "10",
        MIN_PROFIT = "0.01",
        MAX_GAS_GWEI = "100",
        RPC_URL,
        LOCAL_RPC,
        SLIPPAGE_BPS = "50",
        RETRY_BLOCKS = "2",
        V3_FEES = "500,3000,10000",
        RELAYS = "https://relay.flashbots.net",
        UNI_V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
        UNI_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
        SUSHI_V2_ROUTER = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
        ALT_V2_ROUTER = "",
        ALT_V2_FACTORY = ""
    } = process.env;

    const DRY_RUN = !PRIVATE_KEY || !CONTRACT_ADDRESS;
    const ZERO_ADDR = ethers.constants.AddressZero;

    if (!WSS_URL) {
        console.error("Missing WSS_URL in .env");
        process.exit(1);
    }

    const WETH = (process.env.WETH_ADDRESS || "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2").toLowerCase();
    const DEFAULT_TOKEN_ADDR = {
        DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        USDC: "0xA0b86991C6218b36c1d19D4a2e9Eb0cE3606eB48",
        WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
        USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        LINK: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
        UNI: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984"
    };

    const DEX = { V2: 0, V3: 2 };

    const AMT = ethers.utils.parseEther(AMOUNT);
    const MINP = ethers.utils.parseEther(MIN_PROFIT);
    const MAX_GAS = ethers.utils.parseUnits(MAX_GAS_GWEI, "gwei");
    const FALLBACK_GAS_LIMIT = ethers.BigNumber.from("1200000");
    const SLIPP_BPS = parseInt(SLIPPAGE_BPS, 10);
    const RETRY = Math.max(1, parseInt(RETRY_BLOCKS, 10));
    const FEES = V3_FEES.split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));

    const WORKER_COARSE_SAMPLES = Number(process.env.WORKER_COARSE_SAMPLES || 5);
    const WORKER_V3_PLANS_PER_PAIR = Number(process.env.WORKER_V3_PLANS_PER_PAIR || 1);
    const WORKER_MIN_V2_EDGE_BPS_FOR_V3 = Number(process.env.WORKER_MIN_V2_EDGE_BPS_FOR_V3 || 20);

    const pairAbi = [
        "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)",
        "function token0() view returns (address)"
    ];
    const quoterAbi = [
        "function quoteExactInputSingle(address,address,uint24,uint256,uint160) view returns (uint256)"
    ];

    function getAmountOut(amountIn, reserveIn, reserveOut) {
        const inWithFee = amountIn.mul(997);
        const num = inWithFee.mul(reserveOut);
        const den = reserveIn.mul(1000).add(inWithFee);
        return num.div(den);
    }

    async function getTokenConfigs(provider) {
        const UNI_FACTORY = (process.env.UNI_FACTORY || "0x5C69bEe701ef814A2B6a3EDD4B1652CB9cc5aA6f").toLowerCase();
        const SUSHI_FACTORY = (process.env.SUSHI_FACTORY || "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac").toLowerCase();
        const ALT_FACTORY = ALT_V2_FACTORY ? ALT_V2_FACTORY.toLowerCase() : "";
        const factoryAbi = ["function getPair(address,address) view returns (address)"];

        const uniFactory = new ethers.Contract(UNI_FACTORY, factoryAbi, provider);
        const sushiFactory = new ethers.Contract(SUSHI_FACTORY, factoryAbi, provider);
        const altFactory = ALT_FACTORY ? new ethers.Contract(ALT_FACTORY, factoryAbi, provider) : null;

        const symbols = new Set();
        const tokenList = (process.env.TOKEN_LIST || "DAI,USDC,WBTC")
            .split(",")
            .map(s => s.trim().toUpperCase())
            .filter(Boolean);
        tokenList.forEach(s => symbols.add(s));

        const out = [];
        for (const symbol of symbols) {
            const tokenAddr = (process.env[`${symbol}_ADDRESS`] || DEFAULT_TOKEN_ADDR[symbol] || "").toLowerCase();
            if (!tokenAddr) continue;

            let uniPair = (process.env[`UNI_${symbol}_PAIR`] || "").toLowerCase();
            let sushiPair = (process.env[`SUSHI_${symbol}_PAIR`] || "").toLowerCase();
            let altPair = (process.env[`ALT_${symbol}_PAIR`] || "").toLowerCase();

            if (!uniPair) uniPair = (await uniFactory.getPair(WETH, tokenAddr)).toLowerCase();
            if (!sushiPair) sushiPair = (await sushiFactory.getPair(WETH, tokenAddr)).toLowerCase();
            if (!altPair && altFactory) altPair = (await altFactory.getPair(WETH, tokenAddr)).toLowerCase();

            if (uniPair === ZERO_ADDR || sushiPair === ZERO_ADDR) continue;
            if (altPair === ZERO_ADDR) altPair = "";

            out.push({ symbol, token: tokenAddr, uniPair, sushiPair, altPair });
        }
        return out;
    }

    const provider = new ethers.providers.WebSocketProvider(WSS_URL);
    const quoter = new ethers.Contract(UNI_V3_QUOTER.toLowerCase(), quoterAbi, provider);

    const TOKENS = await getTokenConfigs(provider);
    if (!TOKENS.length) {
        console.error("No valid token/pair configuration found in .env");
        process.exit(1);
    }

    const TOKEN_BY_SYMBOL = Object.fromEntries(TOKENS.map(t => [t.symbol, t]));
    const pairCache = {};
    for (const t of TOKENS) {
        const uni = new ethers.Contract(t.uniPair, pairAbi, provider);
        const sushi = new ethers.Contract(t.sushiPair, pairAbi, provider);
        const [u0, s0] = await Promise.all([uni.token0(), sushi.token0()]);

        let alt = null;
        let altTok0 = null;
        if (t.altPair) {
            alt = new ethers.Contract(t.altPair, pairAbi, provider);
            altTok0 = (await alt.token0()).toLowerCase();
        }

        pairCache[t.symbol] = {
            uni,
            sushi,
            alt,
            uniTok0: u0.toLowerCase(),
            sushiTok0: s0.toLowerCase(),
            altTok0
        };
    }

    let wallet;
    let arb;
    let relays = [];

    if (!DRY_RUN) {
        wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        arb = new ethers.Contract(CONTRACT_ADDRESS, arbJson.abi, wallet);

        const authSigner = ethers.Wallet.createRandom();
        const relayUrls = RELAYS.split(",").map(s => s.trim()).filter(Boolean);
        relays = await Promise.all(
            relayUrls.map(async (url) => ({
                url,
                provider: await FlashbotsBundleProvider.create(provider, authSigner, url)
            }))
        );
    }

    console.log(`Arb bot live ${DRY_RUN ? "(dry-run)" : ""} tracking ${TOKENS.length} pairs`);

    const worker = new Worker("./worker.js", {
        workerData: {
            rpcUrl: RPC_URL || LOCAL_RPC,
            WETH,
            tokens: TOKENS,
            quoter: UNI_V3_QUOTER,
            v3Fees: FEES,
            multicall2: process.env.MULTICALL2,
            coarseSamples: WORKER_COARSE_SAMPLES,
            v3PlansPerPair: WORKER_V3_PLANS_PER_PAIR,
            minV2EdgeBpsForV3: WORKER_MIN_V2_EDGE_BPS_FOR_V3,
            uniV2Router: UNI_V2_ROUTER,
            sushiV2Router: SUSHI_V2_ROUTER,
            altV2Router: ALT_V2_ROUTER
        }
    });

    function mapV2Reserves(symbol, routerAddr, reservesObj) {
        const router = (routerAddr || "").toLowerCase();
        if (router === UNI_V2_ROUTER.toLowerCase()) return reservesObj.uni;
        if (router === SUSHI_V2_ROUTER.toLowerCase()) return reservesObj.sushi;
        if (ALT_V2_ROUTER && router === ALT_V2_ROUTER.toLowerCase()) return reservesObj.alt;
        return null;
    }

    async function quoteDex(amountIn, tokenIn, tokenOut, dex, fee, v2Router, reserves) {
        if (dex === DEX.V3) {
            return quoter.quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, 0);
        }

        const r = mapV2Reserves(tokenIn === WETH ? tokenOut : tokenIn, v2Router, reserves);
        if (!r) return null;
        const [w, t] = r;
        return tokenIn === WETH ? getAmountOut(amountIn, w, t) : getAmountOut(amountIn, t, w);
    }

    let workerBusy = false;
    let pendingBlock = null;

    function dispatchWork(blockNumber) {
        workerBusy = true;
        worker.postMessage({ blockNumber, amount: AMT.toString() });
    }

    function drainPending() {
        if (!workerBusy && pendingBlock !== null) {
            const b = pendingBlock;
            pendingBlock = null;
            dispatchWork(b);
        }
    }

    provider.on("block", (blockNumber) => {
        if (workerBusy) {
            pendingBlock = blockNumber;
            return;
        }
        dispatchWork(blockNumber);
    });

    worker.on("message", async (result) => {
        workerBusy = false;
        drainPending();

        if (result.error) {
            console.error("Worker error:", result.error);
            return;
        }

        const {
            blockNumber,
            profit: pStr,
            loan: lStr,
            symbol,
            firstDex,
            secondDex,
            firstV2Router,
            secondV2Router,
            firstFee,
            secondFee
        } = result;

        const tokenCfg = TOKEN_BY_SYMBOL[symbol];
        if (!tokenCfg) return;

        const profit = ethers.BigNumber.from(pStr);
        const loan = ethers.BigNumber.from(lStr);
        if (profit.lte(MINP)) return;

        const feeData = await provider.getFeeData();
        const maxFeePerGas = feeData.maxFeePerGas || feeData.gasPrice;
        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.utils.parseUnits("2", "gwei");
        if (!maxFeePerGas || maxFeePerGas.gt(MAX_GAS)) return;

        const c = pairCache[symbol];
        const calls = [c.uni.getReserves(), c.sushi.getReserves()];
        if (c.alt) calls.push(c.alt.getReserves());
        const res = await Promise.all(calls);

        const uniRes = res[0];
        const sushiRes = res[1];
        const altRes = c.alt ? res[2] : null;

        const reserves = {
            uni: c.uniTok0 === WETH ? [uniRes.reserve0, uniRes.reserve1] : [uniRes.reserve1, uniRes.reserve0],
            sushi: c.sushiTok0 === WETH ? [sushiRes.reserve0, sushiRes.reserve1] : [sushiRes.reserve1, sushiRes.reserve0],
            alt: c.alt && altRes
                ? (c.altTok0 === WETH ? [altRes.reserve0, altRes.reserve1] : [altRes.reserve1, altRes.reserve0])
                : null
        };

        const midOut = await quoteDex(
            loan,
            WETH,
            tokenCfg.token,
            firstDex,
            firstFee,
            firstV2Router,
            reserves
        );
        if (!midOut) return;

        const backOut = await quoteDex(
            midOut,
            tokenCfg.token,
            WETH,
            secondDex,
            secondFee,
            secondV2Router,
            reserves
        );
        if (!backOut) return;

        const minOutFirst = midOut.mul(10000 - SLIPP_BPS).div(10000);
        const minOutSecond = backOut.mul(10000 - SLIPP_BPS).div(10000);

        let estimatedGas = FALLBACK_GAS_LIMIT;
        if (!DRY_RUN) {
            try {
                estimatedGas = await arb.estimateGas.executeFlashLoanFlexible(
                    loan,
                    WETH,
                    tokenCfg.token,
                    firstDex,
                    secondDex,
                    firstV2Router || ZERO_ADDR,
                    secondV2Router || ZERO_ADDR,
                    firstFee,
                    secondFee,
                    minOutFirst,
                    minOutSecond
                );
            } catch (_) {
                return;
            }
        }

        const gasCost = maxFeePerGas.mul(estimatedGas);
        const profitNet = profit.sub(gasCost);
        if (profitNet.lt(MINP)) return;

        if (DRY_RUN) {
            console.log(`Dry-run candidate ${symbol}: net ${ethers.utils.formatEther(profitNet)} ETH`);
            return;
        }

        try {
            await arb.callStatic.executeFlashLoanFlexible(
                loan,
                WETH,
                tokenCfg.token,
                firstDex,
                secondDex,
                firstV2Router || ZERO_ADDR,
                secondV2Router || ZERO_ADDR,
                firstFee,
                secondFee,
                minOutFirst,
                minOutSecond
            );
        } catch (e) {
            console.log(`callStatic rejected ${symbol}: ${e.message}`);
            return;
        }

        const bundleTx = {
            signer: wallet,
            transaction: {
                to: CONTRACT_ADDRESS,
                data: arb.interface.encodeFunctionData("executeFlashLoanFlexible", [
                    loan,
                    WETH,
                    tokenCfg.token,
                    firstDex,
                    secondDex,
                    firstV2Router || ZERO_ADDR,
                    secondV2Router || ZERO_ADDR,
                    firstFee,
                    secondFee,
                    minOutFirst,
                    minOutSecond
                ]),
                gasLimit: estimatedGas,
                maxFeePerGas,
                maxPriorityFeePerGas
            }
        };

        for (const relay of relays) {
            try {
                const signed = await relay.provider.signBundle([bundleTx]);
                for (let k = 1; k <= RETRY; k++) {
                    const r = await relay.provider.sendRawBundle(signed, blockNumber + k);
                    if (r.error) console.log(`relay ${relay.url} block+${k} error: ${r.error.message}`);
                }
            } catch (e) {
                console.log(`relay ${relay.url} failed: ${e.message}`);
            }
        }

        console.log(`submitted ${symbol} net=${ethers.utils.formatEther(profitNet)} ETH`);
    });

    worker.on("error", (err) => {
        workerBusy = false;
        drainPending();
        console.error("Worker crashed:", err);
    });
})();
