require('dotenv').config();
const { Worker } = require('worker_threads');
const { ethers } = require('ethers');

(async () => {
  const wss = process.env.WSS_URL;
  const rpc = process.env.RPC_URL || process.env.LOCAL_RPC;
  const WETH = (process.env.WETH_ADDRESS || '').toLowerCase();
  const AMOUNT = ethers.utils.parseEther(process.env.AMOUNT || '10').toString();
  const MINP = ethers.utils.parseEther(process.env.MIN_PROFIT || '0.01');
  const MONITOR_MINUTES = Number(process.env.MONITOR_MINUTES || '5');
  const WORKER_COARSE_SAMPLES = Number(process.env.WORKER_COARSE_SAMPLES || '6');
  const WORKER_V3_PLANS_PER_PAIR = Number(process.env.WORKER_V3_PLANS_PER_PAIR || '2');
  const WORKER_MIN_V2_EDGE_BPS_FOR_V3 = Number(process.env.WORKER_MIN_V2_EDGE_BPS_FOR_V3 || '-50');

  const tokens = [
    { symbol: 'DAI', token: (process.env.DAI_ADDRESS || '').toLowerCase(), uniPair: (process.env.UNI_DAI_PAIR || '').toLowerCase(), sushiPair: (process.env.SUSHI_DAI_PAIR || '').toLowerCase(), altPair: (process.env.ALT_DAI_PAIR || '').toLowerCase() },
    { symbol: 'USDC', token: (process.env.USDC_ADDRESS || '').toLowerCase(), uniPair: (process.env.UNI_USDC_PAIR || '').toLowerCase(), sushiPair: (process.env.SUSHI_USDC_PAIR || '').toLowerCase(), altPair: (process.env.ALT_USDC_PAIR || '').toLowerCase() },
    { symbol: 'WBTC', token: (process.env.WBTC_ADDRESS || '').toLowerCase(), uniPair: (process.env.UNI_WBTC_PAIR || '').toLowerCase(), sushiPair: (process.env.SUSHI_WBTC_PAIR || '').toLowerCase(), altPair: (process.env.ALT_WBTC_PAIR || '').toLowerCase() },
    { symbol: 'USDT', token: (process.env.USDT_ADDRESS || '0xdac17f958d2ee523a2206206994597c13d831ec7').toLowerCase(), uniPair: (process.env.UNI_USDT_PAIR || '').toLowerCase(), sushiPair: (process.env.SUSHI_USDT_PAIR || '').toLowerCase(), altPair: (process.env.ALT_USDT_PAIR || '').toLowerCase() },
    { symbol: 'LINK', token: (process.env.LINK_ADDRESS || '0x514910771AF9Ca656af840dff83E8264EcF986CA').toLowerCase(), uniPair: (process.env.UNI_LINK_PAIR || '').toLowerCase(), sushiPair: (process.env.SUSHI_LINK_PAIR || '').toLowerCase(), altPair: (process.env.ALT_LINK_PAIR || '').toLowerCase() },
    { symbol: 'UNI', token: (process.env.UNI_ADDRESS || '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984').toLowerCase(), uniPair: (process.env.UNI_UNI_PAIR || '').toLowerCase(), sushiPair: (process.env.SUSHI_UNI_PAIR || '').toLowerCase(), altPair: (process.env.ALT_UNI_PAIR || '').toLowerCase() }
  ].filter(t => t.uniPair && t.sushiPair);

  const provider = new ethers.providers.WebSocketProvider(wss);
  const worker = new Worker('./worker.js', {
    workerData: {
      rpcUrl: rpc,
      WETH,
      tokens,
      quoter: process.env.UNI_V3_QUOTER,
      v3Fees: (process.env.V3_FEES || '500,3000,10000').split(',').map(x => Number(x.trim())).filter(Boolean),
      multicall2: process.env.MULTICALL2,
      uniV2Router: process.env.UNI_V2_ROUTER || '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      sushiV2Router: process.env.SUSHI_V2_ROUTER || '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
      altV2Router: process.env.ALT_V2_ROUTER || '',
      coarseSamples: WORKER_COARSE_SAMPLES,
      v3PlansPerPair: WORKER_V3_PLANS_PER_PAIR,
      minV2EdgeBpsForV3: WORKER_MIN_V2_EDGE_BPS_FOR_V3
    }
  });

  const stats = {
    blocks: 0,
    responses: 0,
    errors: 0,
    positive: 0,
    aboveMinProfit: 0,
    nullSymbol: 0,
    bestProfitWei: ethers.constants.NegativeOne.toString(),
    best: {}
  };
  const routeCounts = {};
  const latency = [];
  const sentAt = new Map();
  let workerBusy = false;
  let pendingBlock = null;

  function routeKey(m) {
    return String(m.firstDex) + '->' + String(m.secondDex) + '(' + String(m.firstFee || 0) + ',' + String(m.secondFee || 0) + ')';
  }

  worker.on('message', (m) => {
    workerBusy = false;
    stats.responses++;
    if (m.error) {
      stats.errors++;
      return;
    }

    const key = String(m.blockNumber);
    const t0 = sentAt.get(key);
    if (t0) {
      latency.push(Date.now() - t0);
      sentAt.delete(key);
    }

    const p = ethers.BigNumber.from(m.profit || '0');
    if (!m.symbol) stats.nullSymbol++;
    if (p.gt(0)) stats.positive++;
    if (p.gt(MINP)) stats.aboveMinProfit++;

    if (p.gt(ethers.BigNumber.from(stats.bestProfitWei))) {
      stats.bestProfitWei = p.toString();
      stats.best = m;
    }

    const rk = routeKey(m);
    routeCounts[rk] = (routeCounts[rk] || 0) + 1;

    if (pendingBlock !== null) {
      const bn = pendingBlock;
      pendingBlock = null;
      workerBusy = true;
      const k2 = String(bn);
      sentAt.set(k2, Date.now());
      worker.postMessage({ blockNumber: bn, amount: AMOUNT });
    }
  });

  worker.on('error', (e) => {
    workerBusy = false;
    stats.errors++;
    console.error('worker crash', e.message);
  });

  provider.on('block', (bn) => {
    stats.blocks++;
    if (workerBusy) {
      pendingBlock = bn;
      return;
    }
    workerBusy = true;
    const k = String(bn);
    sentAt.set(k, Date.now());
    worker.postMessage({ blockNumber: bn, amount: AMOUNT });
  });

  const start = Date.now();
  const durationMs = Math.max(1, MONITOR_MINUTES) * 60 * 1000;
  const interval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    console.log(JSON.stringify({
      progressSec: elapsed,
      blocks: stats.blocks,
      responses: stats.responses,
      positive: stats.positive,
      aboveMinProfit: stats.aboveMinProfit,
      errors: stats.errors
    }));
  }, 60000);

  setTimeout(async () => {
    clearInterval(interval);
    provider.removeAllListeners('block');
    await worker.terminate();
    try { provider.destroy(); } catch (_) {}

    const avgLat = latency.length ? latency.reduce((a, b) => a + b, 0) / latency.length : 0;
    const sorted = latency.slice().sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
    const bestEth = stats.bestProfitWei === '-1' ? 'N/A' : ethers.utils.formatEther(stats.bestProfitWei);

    console.log('\n=== LIVE DRY-RUN SUMMARY (5m) ===');
    console.log(JSON.stringify({
      windowMinutes: MONITOR_MINUTES,
      workerTuning: {
        coarseSamples: WORKER_COARSE_SAMPLES,
        v3PlansPerPair: WORKER_V3_PLANS_PER_PAIR,
        minV2EdgeBpsForV3: WORKER_MIN_V2_EDGE_BPS_FOR_V3
      },
      trackedTokens: tokens.map(t => t.symbol),
      blocksObserved: stats.blocks,
      workerResponses: stats.responses,
      errorCount: stats.errors,
      positiveGrossCount: stats.positive,
      aboveMinProfitCount: stats.aboveMinProfit,
      nullSymbolCount: stats.nullSymbol,
      positiveRatePct: stats.responses ? Number((stats.positive * 100 / stats.responses).toFixed(2)) : 0,
      aboveMinProfitRatePct: stats.responses ? Number((stats.aboveMinProfit * 100 / stats.responses).toFixed(2)) : 0,
      bestProfitEth: bestEth,
      bestCandidate: stats.best,
      latencyMs: { avg: Number(avgLat.toFixed(1)), p95 },
      routeCounts
    }, null, 2));

    process.exit(0);
  }, durationMs);
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
