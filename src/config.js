const path = require("path");

function parseCsv(value, fallback) {
    const raw = value || fallback || "";
    return raw
        .split(",")
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean);
}

function parseNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parseFeeList(value, fallback) {
    return (value || fallback || "")
        .split(",")
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isFinite(item) && item > 0);
}

function parseTradeSizes(value, fallback) {
    const entries = (value || fallback || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

    const out = {};
    for (const entry of entries) {
        const [symbol, size] = entry.split(":");
        if (!symbol || !size) continue;
        out[symbol.trim().toUpperCase()] = size.trim();
    }
    return out;
}

function loadConfig(overrides = {}) {
    const env = { ...process.env, ...overrides };
    const baseAssets = parseCsv(env.ARB_BASE_ASSETS, "WETH,USDC,USDT");
    const scanAssets = parseCsv(env.ARB_SCAN_ASSETS, "WETH,USDC,USDT,WBTC,DAI,WSTETH");

    return {
        rpcUrl: env.ARB_RPC_URL || env.RPC_URL || env.LOCAL_RPC || "",
        wssUrl: env.ARB_WSS_URL || env.WSS_URL || "",
        chain: env.ARB_CHAIN || "ethereum",
        loopIntervalMs: parseNumber(env.ARB_LOOP_INTERVAL_MS, 30000),
        minNetProfitUsd: parseNumber(env.ARB_MIN_NET_PROFIT_USD, 15),
        estimatedGasUnits: parseNumber(env.ARB_ESTIMATED_GAS_UNITS, 450000),
        gasBufferBps: parseNumber(env.ARB_GAS_BUFFER_BPS, 2000),
        defaultGasGwei: parseNumber(env.ARB_DEFAULT_GAS_GWEI, 30),
        topCandidates: parseNumber(env.ARB_TOP_CANDIDATES, 5),
        baseAssets,
        scanAssets,
        tradeSizes: parseTradeSizes(env.ARB_TRADE_SIZES, "WETH:2,USDC:5000,USDT:5000,WBTC:0.05,DAI:5000,WSTETH:1"),
        uniFees: parseFeeList(env.ARB_UNI_FEES, "500,3000"),
        pancakeFees: parseFeeList(env.ARB_PANCAKE_FEES, "500,2500"),
        uniswapQuoter: (env.ARB_UNISWAP_QUOTER || "0xB27308f9F90D607463bb33eA1BeBb41C27CE5AB6").toLowerCase(),
        uniswapRouter: (env.ARB_UNISWAP_ROUTER || "0x68b3465833FB72A70ecDF485E0e4C7bD8665Fc45").toLowerCase(),
        pancakeQuoter: (env.ARB_PANCAKE_QUOTER || "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997").toLowerCase(),
        pancakeRouter: (env.ARB_PANCAKE_ROUTER || "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4").toLowerCase(),
        balancerApiUrl: env.ARB_BALANCER_API_URL || "https://api-v3.balancer.fi/",
        multicallAddress: (env.ARB_MULTICALL2 || env.MULTICALL2 || "0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696").toLowerCase(),
        enableUniswap: parseBoolean(env.ARB_ENABLE_UNISWAP, true),
        enablePancake: parseBoolean(env.ARB_ENABLE_PANCAKE, true),
        enableBalancer: parseBoolean(env.ARB_ENABLE_BALANCER, true),
        enableMulticallBatching: parseBoolean(env.ARB_ENABLE_MULTICALL_BATCHING, true),
        recordCandidates: parseBoolean(env.ARB_RECORD_CANDIDATES, true),
        candidateLogPath: path.resolve(env.ARB_CANDIDATE_LOG_PATH || "./data/arb_candidates.jsonl"),
        privateExecution: parseBoolean(env.ARB_ENABLE_PRIVATE_EXECUTION, false),
        privateExecutionDryRun: parseBoolean(env.ARB_PRIVATE_EXECUTION_DRY_RUN, true),
        privateKey: env.ARB_PRIVATE_KEY || env.PRIVATE_KEY || "",
        flashbotsAuthKey: env.ARB_FLASHBOTS_AUTH_KEY || env.FLASHBOTS_AUTH_KEY || "",
        contractAddress: (env.ARB_CONTRACT_ADDRESS || env.CONTRACT_ADDRESS || "").toLowerCase(),
        relayUrls: (env.ARB_RELAY_URLS || env.RELAYS || "https://relay.flashbots.net")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        executionSlippageBps: parseNumber(env.ARB_EXECUTION_SLIPPAGE_BPS, 40),
        bundleBlocks: parseNumber(env.ARB_BUNDLE_BLOCKS, 2),
        bundleGasLimit: parseNumber(env.ARB_BUNDLE_GAS_LIMIT, 700000),
        privateTipGwei: parseNumber(env.ARB_PRIVATE_TIP_GWEI, 2),
        maxBundleGasPriceGwei: parseNumber(env.ARB_MAX_BUNDLE_GAS_PRICE_GWEI, 80),
        backtestDays: parseNumber(env.ARB_BACKTEST_DAYS, 60),
        backtestStepBlocks: parseNumber(env.ARB_BACKTEST_STEP_BLOCKS, 14400),
        backtestBlocksPerDay: parseNumber(env.ARB_BACKTEST_BLOCKS_PER_DAY, 7200),
        backtestPriorityFeeGwei: parseNumber(env.ARB_BACKTEST_PRIORITY_FEE_GWEI, 2),
        backtestLogPath: path.resolve(env.ARB_BACKTEST_LOG_PATH || "./data/arb_backtest_samples.jsonl")
    };
}

module.exports = {
    loadConfig
};
