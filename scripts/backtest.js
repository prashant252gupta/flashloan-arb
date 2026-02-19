require("dotenv").config();
const { ethers } = require("ethers");

const pairAbi = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)",
  "function token0() view returns (address)"
];
const multicallAbi = [
  "function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)",
  "function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)"
];
const quoterAbi = [
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) view returns (uint256)"
];

const DEX = {
  UNI_V2: 0,
  SUSHI_V2: 1,
  UNI_V3: 2
};

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--blocks") out.blocks = Number(args[++i]);
    else if (a === "--step") out.step = Number(args[++i]);
    else if (a === "--samples") out.samples = Number(args[++i]);
    else if (a === "--min-loan") out.minLoan = args[++i];
    else if (a === "--gas-limit") out.gasLimit = Number(args[++i]);
    else if (a === "--tip-gwei") out.tipGwei = args[++i];
    else if (a === "--gas-price-gwei") out.gasPriceGwei = args[++i];
    else if (a === "--chunk") out.chunk = Number(args[++i]);
  }
  return out;
}

function parseFeeList(input) {
  if (!input) return [500, 3000, 10000];
  const out = input.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return out.length ? out : [500, 3000, 10000];
}

function getAmountOut(amountIn, reserveIn, reserveOut) {
  const inWithFee = amountIn.mul(997);
  const num = inWithFee.mul(reserveOut);
  const den = reserveIn.mul(1000).add(inWithFee);
  return num.div(den);
}

function owedWithPremium(loan) {
  return loan.mul(10009).div(10000);
}

function fmtEth(bn) {
  return Number(ethers.utils.formatEther(bn));
}

async function getTokenConfigs(provider, weth) {
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const defaults = {
    DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    USDC: "0xA0b86991C6218b36c1d19D4a2e9Eb0cE3606eB48",
    WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    LINK: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    UNI: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984"
  };

  const UNI_FACTORY = (process.env.UNI_FACTORY || "0x5C69bEe701ef814A2B6a3EDD4B1652CB9cc5aA6f").toLowerCase();
  const SUSHI_FACTORY = (process.env.SUSHI_FACTORY || "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac").toLowerCase();
  const factoryAbi = ["function getPair(address,address) view returns (address)"];
  const uniFactory = new ethers.Contract(UNI_FACTORY, factoryAbi, provider);
  const sushiFactory = new ethers.Contract(SUSHI_FACTORY, factoryAbi, provider);

  const symbols = new Set();
  const tokenList = (process.env.TOKEN_LIST || "DAI,USDC,WBTC,USDT,LINK,UNI")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  tokenList.forEach((s) => symbols.add(s));
  for (const k of Object.keys(process.env)) {
    const m = /^UNI_([A-Z0-9]+)_PAIR$/.exec(k);
    if (m && process.env[k]) symbols.add(m[1]);
  }

  const out = [];
  for (const symbol of symbols) {
    const token = (process.env[`${symbol}_ADDRESS`] || defaults[symbol] || "").toLowerCase();
    if (!token) continue;

    let uniPair = (process.env[`UNI_${symbol}_PAIR`] || "").toLowerCase();
    let sushiPair = (process.env[`SUSHI_${symbol}_PAIR`] || "").toLowerCase();
    if (!uniPair) uniPair = (await uniFactory.getPair(weth, token)).toLowerCase();
    if (!sushiPair) sushiPair = (await sushiFactory.getPair(weth, token)).toLowerCase();
    if (uniPair === ZERO_ADDR || sushiPair === ZERO_ADDR) continue;

    const uni = new ethers.Contract(uniPair, pairAbi, provider);
    const sushi = new ethers.Contract(sushiPair, pairAbi, provider);
    const [uniTok0, sushiTok0] = await Promise.all([uni.token0(), sushi.token0()]);

    out.push({
      symbol,
      token,
      uniPair,
      sushiPair,
      uniTok0: uniTok0.toLowerCase(),
      sushiTok0: sushiTok0.toLowerCase()
    });
  }

  return out;
}

async function batchV3Quotes(multicall, quoterIface, quoterAddr, token, weth, loanPlans, fees, blockTag) {
  if (!fees.length || !loanPlans.length) return [];

  const calls = [];
  for (const lp of loanPlans) {
    for (const fee of fees) {
      calls.push({
        target: quoterAddr,
        callData: quoterIface.encodeFunctionData("quoteExactInputSingle", [weth, token, fee, lp.loan, 0])
      });
      calls.push({
        target: quoterAddr,
        callData: quoterIface.encodeFunctionData("quoteExactInputSingle", [token, weth, fee, lp.outUni, 0])
      });
      calls.push({
        target: quoterAddr,
        callData: quoterIface.encodeFunctionData("quoteExactInputSingle", [token, weth, fee, lp.outSushi, 0])
      });
    }
  }

  const rows = await multicall.tryAggregate(false, calls, { blockTag });
  let idx = 0;
  const out = [];
  for (let i = 0; i < loanPlans.length; i++) {
    const row = { buy: [], sellFromUni: [], sellFromSushi: [] };
    for (let f = 0; f < fees.length; f++) {
      const b = rows[idx++];
      const su = rows[idx++];
      const ss = rows[idx++];
      row.buy.push(b.success ? quoterIface.decodeFunctionResult("quoteExactInputSingle", b.returnData)[0] : null);
      row.sellFromUni.push(su.success ? quoterIface.decodeFunctionResult("quoteExactInputSingle", su.returnData)[0] : null);
      row.sellFromSushi.push(ss.success ? quoterIface.decodeFunctionResult("quoteExactInputSingle", ss.returnData)[0] : null);
    }
    out.push(row);
  }
  return out;
}

(async () => {
  const argv = parseArgs();
  const rpcUrl = process.env.RPC_URL || process.env.LOCAL_RPC;
  if (!rpcUrl) throw new Error("Missing RPC_URL/LOCAL_RPC in .env");

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const pairIface = new ethers.utils.Interface(pairAbi);
  const quoterIface = new ethers.utils.Interface(quoterAbi);
  const quoterAddr = (process.env.UNI_V3_QUOTER || "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6").toLowerCase();
  const multicall = new ethers.Contract(
    (process.env.MULTICALL2 || "0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696").toLowerCase(),
    multicallAbi,
    provider
  );

  const WETH = (process.env.WETH_ADDRESS || "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2").toLowerCase();
  const AMOUNT = ethers.utils.parseEther(process.env.AMOUNT || "10");
  const MIN_PROFIT = ethers.utils.parseEther(process.env.MIN_PROFIT || "0.01");
  const MAX_GAS = ethers.utils.parseUnits(process.env.MAX_GAS_GWEI || "100", "gwei");
  const FEES = parseFeeList(process.env.V3_FEES || "500,3000,10000");

  const BLOCKS = Number.isFinite(argv.blocks) ? argv.blocks : 1200;
  const STEP = Number.isFinite(argv.step) ? argv.step : 4;
  const SAMPLES = Number.isFinite(argv.samples) ? argv.samples : 12;
  const CHUNK = Number.isFinite(argv.chunk) ? Math.max(40, argv.chunk) : 120;
  const MIN_LOAN = ethers.utils.parseEther(argv.minLoan || "0.1");
  const GAS_LIMIT = ethers.BigNumber.from(Number.isFinite(argv.gasLimit) ? argv.gasLimit : 350000);
  const TIP_GWEI = ethers.utils.parseUnits(argv.tipGwei || "1.5", "gwei");
  const FIXED_GAS_PRICE = argv.gasPriceGwei ? ethers.utils.parseUnits(argv.gasPriceGwei, "gwei") : null;

  const tokens = await getTokenConfigs(provider, WETH);
  if (!tokens.length) throw new Error("No valid token/pair configuration found in .env");

  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(1, latest - BLOCKS + 1);
  const blockList = [];
  for (let b = fromBlock; b <= latest; b += STEP) blockList.push(b);

  const getReservesData = pairIface.encodeFunctionData("getReserves", []);
  const span = AMOUNT.sub(MIN_LOAN);

  let checkedBlocks = 0;
  let opportunityBlocks = 0;
  let executableBlocks = 0;
  let totalGross = ethers.constants.Zero;
  let totalNet = ethers.constants.Zero;
  let firstTs = null;
  let lastTs = null;

  for (let start = 0; start < blockList.length; start += CHUNK) {
    const chunk = blockList.slice(start, start + CHUNK);
    for (const b of chunk) {
      const reserveCalls = [];
      for (const t of tokens) {
        reserveCalls.push({ target: t.uniPair, callData: getReservesData });
        reserveCalls.push({ target: t.sushiPair, callData: getReservesData });
      }

      const [agg, blockObj] = await Promise.all([
        multicall.aggregate(reserveCalls, { blockTag: b }),
        FIXED_GAS_PRICE ? Promise.resolve(null) : provider.getBlock(b)
      ]);
      const reserveData = agg.returnData;

      if (!FIXED_GAS_PRICE && blockObj) {
        if (firstTs === null) firstTs = blockObj.timestamp;
        lastTs = blockObj.timestamp;
      }

      checkedBlocks += 1;
      let idx = 0;
      let best = {
        symbol: null,
        loan: MIN_LOAN,
        gross: ethers.constants.NegativeOne,
        firstDex: DEX.UNI_V2,
        secondDex: DEX.SUSHI_V2,
        firstFee: 0,
        secondFee: 0
      };

      for (const t of tokens) {
        const [u0, u1] = pairIface.decodeFunctionResult("getReserves", reserveData[idx++]);
        const [s0, s1] = pairIface.decodeFunctionResult("getReserves", reserveData[idx++]);
        const [uW, uT] = t.uniTok0 === WETH ? [u0, u1] : [u1, u0];
        const [sW, sT] = t.sushiTok0 === WETH ? [s0, s1] : [s1, s0];

        const loanPlans = [];
        for (let i = 0; i <= SAMPLES; i++) {
          const loan = MIN_LOAN.add(span.mul(i).div(SAMPLES));
          loanPlans.push({
            loan,
            outUni: getAmountOut(loan, uW, uT),
            outSushi: getAmountOut(loan, sW, sT)
          });
        }

        const v3Rows = await batchV3Quotes(
          multicall,
          quoterIface,
          quoterAddr,
          t.token,
          WETH,
          loanPlans,
          FEES,
          b
        );

        for (let i = 0; i < loanPlans.length; i++) {
          const lp = loanPlans[i];
          const owed = owedWithPremium(lp.loan);
          const backUniFromSushi = getAmountOut(lp.outSushi, uT, uW);
          const backSushiFromUni = getAmountOut(lp.outUni, sT, sW);

          const pUniThenSushi = backSushiFromUni.sub(owed);
          if (pUniThenSushi.gt(best.gross)) {
            best = { symbol: t.symbol, loan: lp.loan, gross: pUniThenSushi, firstDex: DEX.UNI_V2, secondDex: DEX.SUSHI_V2, firstFee: 0, secondFee: 0 };
          }

          const pSushiThenUni = backUniFromSushi.sub(owed);
          if (pSushiThenUni.gt(best.gross)) {
            best = { symbol: t.symbol, loan: lp.loan, gross: pSushiThenUni, firstDex: DEX.SUSHI_V2, secondDex: DEX.UNI_V2, firstFee: 0, secondFee: 0 };
          }

          const vr = v3Rows[i] || { buy: [], sellFromUni: [], sellFromSushi: [] };
          for (let f = 0; f < FEES.length; f++) {
            const fee = FEES[f];
            const buy = vr.buy[f];
            if (buy) {
              const backViaUni = getAmountOut(buy, uT, uW);
              const backViaSushi = getAmountOut(buy, sT, sW);
              const pV3ThenUni = backViaUni.sub(owed);
              if (pV3ThenUni.gt(best.gross)) {
                best = { symbol: t.symbol, loan: lp.loan, gross: pV3ThenUni, firstDex: DEX.UNI_V3, secondDex: DEX.UNI_V2, firstFee: fee, secondFee: 0 };
              }
              const pV3ThenSushi = backViaSushi.sub(owed);
              if (pV3ThenSushi.gt(best.gross)) {
                best = { symbol: t.symbol, loan: lp.loan, gross: pV3ThenSushi, firstDex: DEX.UNI_V3, secondDex: DEX.SUSHI_V2, firstFee: fee, secondFee: 0 };
              }
            }

            const sellUni = vr.sellFromUni[f];
            if (sellUni) {
              const pUniThenV3 = sellUni.sub(owed);
              if (pUniThenV3.gt(best.gross)) {
                best = { symbol: t.symbol, loan: lp.loan, gross: pUniThenV3, firstDex: DEX.UNI_V2, secondDex: DEX.UNI_V3, firstFee: 0, secondFee: fee };
              }
            }

            const sellSushi = vr.sellFromSushi[f];
            if (sellSushi) {
              const pSushiThenV3 = sellSushi.sub(owed);
              if (pSushiThenV3.gt(best.gross)) {
                best = { symbol: t.symbol, loan: lp.loan, gross: pSushiThenV3, firstDex: DEX.SUSHI_V2, secondDex: DEX.UNI_V3, firstFee: 0, secondFee: fee };
              }
            }
          }
        }
      }

      if (best.gross.gt(0)) opportunityBlocks += 1;

      const effectiveGasPrice = FIXED_GAS_PRICE
        ? (FIXED_GAS_PRICE.gt(MAX_GAS) ? MAX_GAS : FIXED_GAS_PRICE)
        : (((blockObj.baseFeePerGas || ethers.constants.Zero).mul(2).add(TIP_GWEI)).gt(MAX_GAS)
          ? MAX_GAS
          : (blockObj.baseFeePerGas || ethers.constants.Zero).mul(2).add(TIP_GWEI));

      const gasCost = effectiveGasPrice.mul(GAS_LIMIT);
      const net = best.gross.sub(gasCost);

      if (best.gross.gt(MIN_PROFIT) && net.gt(MIN_PROFIT)) {
        executableBlocks += 1;
        totalGross = totalGross.add(best.gross);
        totalNet = totalNet.add(net);
      }

      if (checkedBlocks % 50 === 0) {
        console.log(`progress: ${checkedBlocks} sampled blocks (latest checked: ${b})`);
      }
    }
  }

  const sampledSpanSeconds = FIXED_GAS_PRICE
    ? Math.max(1, checkedBlocks * 12)
    : (firstTs && lastTs ? Math.max(1, lastTs - firstTs) : 1);
  const sampledSpanDays = sampledSpanSeconds / 86400;
  const tradesPerDay = executableBlocks / sampledSpanDays;
  const netEthPerDay = fmtEth(totalNet) / sampledSpanDays;
  const grossEthPerDay = fmtEth(totalGross) / sampledSpanDays;
  const avgLoanEth = Number(ethers.utils.formatEther(AMOUNT));
  const dailyRoiOnLoanPct = avgLoanEth > 0 ? (netEthPerDay / avgLoanEth) * 100 : 0;

  const summary = {
    config: {
      blocksRequested: BLOCKS,
      step: STEP,
      sampledBlocks: checkedBlocks,
      sampledBlockRange: [fromBlock, latest],
      tokens: tokens.map((t) => t.symbol),
      v3Fees: FEES,
      amountEth: Number(ethers.utils.formatEther(AMOUNT)),
      minLoanEth: Number(ethers.utils.formatEther(MIN_LOAN)),
      minProfitEth: Number(ethers.utils.formatEther(MIN_PROFIT)),
      gasLimit: GAS_LIMIT.toString(),
      maxGasGwei: Number(ethers.utils.formatUnits(MAX_GAS, "gwei")),
      tipGwei: Number(ethers.utils.formatUnits(TIP_GWEI, "gwei")),
      fixedGasPriceGwei: FIXED_GAS_PRICE ? Number(ethers.utils.formatUnits(FIXED_GAS_PRICE, "gwei")) : null,
      samplesPerPair: SAMPLES,
      chunkSize: CHUNK,
      multicall2: multicall.address,
      quoter: quoterAddr
    },
    results: {
      opportunityBlockRatePct: checkedBlocks > 0 ? (opportunityBlocks / checkedBlocks) * 100 : 0,
      executableBlockRatePct: checkedBlocks > 0 ? (executableBlocks / checkedBlocks) * 100 : 0,
      executableTrades: executableBlocks,
      totalGrossEth: fmtEth(totalGross),
      totalNetEth: fmtEth(totalNet),
      estTradesPerDay: tradesPerDay,
      estGrossEthPerDay: grossEthPerDay,
      estNetEthPerDay: netEthPerDay,
      estDailyRoiPctOnLoanCap: dailyRoiOnLoanPct
    }
  };

  console.log("\n=== Backtest Summary ===");
  console.log(JSON.stringify(summary, null, 2));
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
