require("dotenv").config();

const { ethers } = require("ethers");

const { loadConfig } = require("../src/config");
const { createScanner } = require("../worker");

function round(value) {
    return Number(value.toFixed(4));
}

function pickBestSample(samples) {
    let best = null;
    for (const sample of samples) {
        const candidate = sample.bestObservedCandidate;
        if (!candidate) continue;
        if (!best || candidate.netProfitUsd > best.candidate.netProfitUsd) {
            best = {
                blockNumber: sample.blockNumber,
                isoTime: sample.isoTime,
                candidate
            };
        }
    }
    return best;
}

function pickDominantRoute(samples) {
    const counts = new Map();
    for (const sample of samples) {
        const candidate = sample.bestObservedCandidate;
        if (!candidate) continue;
        const key = `${candidate.baseSymbol}->${candidate.midSymbol} | ${candidate.firstVenue} -> ${candidate.secondVenue}`;
        counts.set(key, (counts.get(key) || 0) + 1);
    }

    let best = null;
    for (const [route, count] of counts.entries()) {
        if (!best || count > best.count) {
            best = { route, count };
        }
    }
    return best;
}

async function runProfile(profile, blockSamples) {
    const config = loadConfig(profile.overrides);
    const scanner = await createScanner(config);
    const priorityFee = ethers.utils.parseUnits(String(config.backtestPriorityFeeGwei), "gwei");
    const samples = [];

    for (const block of blockSamples) {
        const gasPriceWei = (block.baseFeePerGas || ethers.utils.parseUnits(String(config.defaultGasGwei), "gwei")).add(priorityFee);
        const report = await scanner.scanOnce({
            blockTag: block.number,
            includeBalancer: false,
            gasPriceWeiOverride: gasPriceWei,
            timestampOverride: block.timestamp * 1000,
            block
        });

        const sample = {
            blockNumber: block.number,
            isoTime: new Date(block.timestamp * 1000).toISOString(),
            bestObservedCandidate: report.bestObservedCandidate,
            profitableCount: report.profitableCandidates.length,
            evaluatedRoutes: report.evaluatedRoutes
        };
        samples.push(sample);
        console.log(
            `[${profile.id}] ${sample.isoTime} block=${sample.blockNumber} ` +
            `routes=${sample.evaluatedRoutes} profitable=${sample.profitableCount} ` +
            `bestNet=${sample.bestObservedCandidate ? round(sample.bestObservedCandidate.netProfitUsd) : "n/a"}`
        );
    }

    const profitableSamples = samples.filter((sample) => sample.profitableCount > 0);
    const positiveNetSamples = samples.filter(
        (sample) => sample.bestObservedCandidate && sample.bestObservedCandidate.netProfitUsd > 0
    );
    const positiveGrossSamples = samples.filter(
        (sample) => sample.bestObservedCandidate && sample.bestObservedCandidate.grossProfitUsd > 0
    );
    const bestSample = pickBestSample(samples);
    const dominantRoute = pickDominantRoute(samples);

    try {
        scanner.provider.destroy();
    } catch (_) {
        // No-op.
    }

    return {
        id: profile.id,
        label: profile.label,
        assumptions: profile.assumptions,
        sampledBlocks: samples.length,
        profitableSamples: profitableSamples.length,
        profitableSampleRatePct: samples.length ? round((profitableSamples.length / samples.length) * 100) : 0,
        positiveNetSamples: positiveNetSamples.length,
        positiveNetSampleRatePct: samples.length ? round((positiveNetSamples.length / samples.length) * 100) : 0,
        positiveGrossSamples: positiveGrossSamples.length,
        positiveGrossSampleRatePct: samples.length ? round((positiveGrossSamples.length / samples.length) * 100) : 0,
        averageBestNetUsd: samples.length
            ? round(samples.reduce((sum, sample) => sum + (sample.bestObservedCandidate ? sample.bestObservedCandidate.netProfitUsd : 0), 0) / samples.length)
            : 0,
        averageBestGrossUsd: samples.length
            ? round(samples.reduce((sum, sample) => sum + (sample.bestObservedCandidate ? sample.bestObservedCandidate.grossProfitUsd : 0), 0) / samples.length)
            : 0,
        bestSample,
        dominantRoute
    };
}

(async () => {
    const baseConfig = loadConfig({
        ARB_BACKTEST_DAYS: "180",
        ARB_BACKTEST_STEP_BLOCKS: "43200"
    });
    if (!baseConfig.rpcUrl) {
        throw new Error("Missing ARB_RPC_URL or RPC_URL/LOCAL_RPC in .env");
    }

    const provider = new ethers.providers.JsonRpcProvider(baseConfig.rpcUrl);
    const latestBlock = await provider.getBlockNumber();
    const blocksBack = Math.max(1, Math.floor(baseConfig.backtestDays * baseConfig.backtestBlocksPerDay));
    const startBlock = Math.max(1, latestBlock - blocksBack);
    const blockNumbers = [];
    for (let blockNumber = startBlock; blockNumber <= latestBlock; blockNumber += baseConfig.backtestStepBlocks) {
        blockNumbers.push(blockNumber);
    }
    const blockSamples = [];
    for (const blockNumber of blockNumbers) {
        blockSamples.push(await provider.getBlock(blockNumber));
    }

    const profiles = [
        {
            id: "baseline_mainnet",
            label: "Current bot defaults on mainnet",
            assumptions: "Fixed trade sizes, 450k gas estimate, 20% gas buffer, WETH/USDC/USDT bases.",
            overrides: {
                ARB_BACKTEST_DAYS: "180",
                ARB_BACKTEST_STEP_BLOCKS: "43200"
            }
        },
        {
            id: "lean_private",
            label: "Lean private execution",
            assumptions: "Smaller sizes, tighter asset set, 260k gas estimate, 5% gas buffer, assumes private capture on two-leg V3 routes.",
            overrides: {
                ARB_BACKTEST_DAYS: "180",
                ARB_BACKTEST_STEP_BLOCKS: "43200",
                ARB_BASE_ASSETS: "WETH,USDC,USDT",
                ARB_SCAN_ASSETS: "WETH,USDC,USDT,DAI",
                ARB_TRADE_SIZES: "WETH:0.5,USDC:1500,USDT:1500,DAI:1500",
                ARB_ESTIMATED_GAS_UNITS: "260000",
                ARB_GAS_BUFFER_BPS: "500"
            }
        },
        {
            id: "low_impact",
            label: "Very small size / low impact",
            assumptions: "Very small sizes, 190k gas estimate, no gas buffer, meant to test whether price impact is the main problem.",
            overrides: {
                ARB_BACKTEST_DAYS: "180",
                ARB_BACKTEST_STEP_BLOCKS: "43200",
                ARB_BASE_ASSETS: "WETH,USDC,USDT",
                ARB_SCAN_ASSETS: "WETH,USDC,USDT,DAI",
                ARB_TRADE_SIZES: "WETH:0.25,USDC:750,USDT:750,DAI:750",
                ARB_ESTIMATED_GAS_UNITS: "190000",
                ARB_GAS_BUFFER_BPS: "0"
            }
        },
        {
            id: "spread_only",
            label: "Spread-only stress test",
            assumptions: "Same very small sizes, but zero gas cost to measure whether raw spread exists before execution friction.",
            overrides: {
                ARB_BACKTEST_DAYS: "180",
                ARB_BACKTEST_STEP_BLOCKS: "43200",
                ARB_BASE_ASSETS: "WETH,USDC,USDT",
                ARB_SCAN_ASSETS: "WETH,USDC,USDT,DAI",
                ARB_TRADE_SIZES: "WETH:0.25,USDC:750,USDT:750,DAI:750",
                ARB_ESTIMATED_GAS_UNITS: "0",
                ARB_GAS_BUFFER_BPS: "0"
            }
        }
    ];

    const summaries = [];
    for (const profile of profiles) {
        console.log(`\n=== Running profile: ${profile.id} ===`);
        summaries.push(await runProfile(profile, blockSamples));
    }

    const output = {
        generatedAt: new Date().toISOString(),
        window: {
            days: baseConfig.backtestDays,
            latestBlock,
            startBlock,
            sampledBlocks: blockSamples.length,
            sampleStepBlocks: baseConfig.backtestStepBlocks,
            firstSampleTime: blockSamples[0] ? new Date(blockSamples[0].timestamp * 1000).toISOString() : null,
            lastSampleTime: blockSamples[blockSamples.length - 1] ? new Date(blockSamples[blockSamples.length - 1].timestamp * 1000).toISOString() : null,
            balancerIncluded: false
        },
        profiles: summaries
    };

    console.log("\n=== 6-Month Strategy Research Summary ===");
    console.log(JSON.stringify(output, null, 2));

    try {
        provider.destroy();
    } catch (_) {
        // No-op.
    }
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
