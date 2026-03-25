require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const { loadConfig } = require("../src/config");
const { appendJsonLine } = require("../src/lib/jsonl");
const { createScanner } = require("../worker");

function parseArgs() {
    const args = process.argv.slice(2);
    const out = {};

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--days") out.days = Number(args[index + 1]);
        if (arg === "--step-blocks") out.stepBlocks = Number(args[index + 1]);
    }

    return out;
}

function roundUsd(value) {
    return Number(value.toFixed(4));
}

function pickBestSample(samples) {
    let best = null;
    for (const sample of samples) {
        const candidate = sample.topProfitableCandidate || sample.bestObservedCandidate;
        if (!candidate) continue;
        if (!best || candidate.netProfitUsd > best.candidate.netProfitUsd) {
            best = { blockNumber: sample.blockNumber, isoTime: sample.isoTime, candidate };
        }
    }
    return best;
}

(async () => {
    const argv = parseArgs();
    const overrides = {};
    if (Number.isFinite(argv.days) && argv.days > 0) {
        overrides.ARB_BACKTEST_DAYS = String(argv.days);
    }
    if (Number.isFinite(argv.stepBlocks) && argv.stepBlocks > 0) {
        overrides.ARB_BACKTEST_STEP_BLOCKS = String(argv.stepBlocks);
    }

    const config = loadConfig(overrides);
    const scanner = await createScanner(config);
    const provider = scanner.provider;
    const latestBlock = await provider.getBlockNumber();
    const blocksBack = Math.max(1, Math.floor(config.backtestDays * config.backtestBlocksPerDay));
    const startBlock = Math.max(1, latestBlock - blocksBack);
    const priorityFee = ethers.utils.parseUnits(String(config.backtestPriorityFeeGwei), "gwei");
    const stepBlocks = Math.max(1, config.backtestStepBlocks);
    const samples = [];

    fs.mkdirSync(path.dirname(config.backtestLogPath), { recursive: true });
    fs.writeFileSync(config.backtestLogPath, "");

    for (let blockNumber = startBlock; blockNumber <= latestBlock; blockNumber += stepBlocks) {
        const block = await provider.getBlock(blockNumber);
        const gasPriceWei = (block.baseFeePerGas || ethers.utils.parseUnits(String(config.defaultGasGwei), "gwei")).add(priorityFee);
        const report = await scanner.scanOnce({
            blockTag: blockNumber,
            includeBalancer: false,
            gasPriceWeiOverride: gasPriceWei,
            timestampOverride: block.timestamp * 1000,
            block
        });
        const topProfitableCandidate = report.profitableCandidates[0] || null;
        const sample = {
            blockNumber,
            isoTime: new Date(report.timestamp).toISOString(),
            gasPriceGwei: roundUsd(report.gasPriceGwei),
            ethUsd: roundUsd(report.ethUsd),
            evaluatedRoutes: report.evaluatedRoutes,
            profitableCount: report.profitableCandidates.length,
            topProfitableCandidate,
            bestObservedCandidate: report.bestObservedCandidate
        };

        appendJsonLine(config.backtestLogPath, sample);
        samples.push(sample);
        console.log(
            `[sample ${samples.length}] block=${blockNumber} date=${sample.isoTime} ` +
            `routes=${sample.evaluatedRoutes} profitable=${sample.profitableCount} ` +
            `bestNet=${sample.bestObservedCandidate ? roundUsd(sample.bestObservedCandidate.netProfitUsd) : "n/a"}`
        );
    }

    const profitableSamples = samples.filter((sample) => sample.topProfitableCandidate);
    const positiveObservedSamples = samples.filter(
        (sample) => sample.bestObservedCandidate && sample.bestObservedCandidate.netProfitUsd > 0
    );
    const bestSample = pickBestSample(samples);
    const summary = {
        generatedAt: new Date().toISOString(),
        replayWindow: {
            days: config.backtestDays,
            latestBlock,
            startBlock,
            sampleStepBlocks: stepBlocks,
            sampledBlocks: samples.length,
            balancerIncluded: false,
            note: "Sampled historical quote replay. This is an opportunity scan, not realized capture PnL."
        },
        profitability: {
            profitableSamples: profitableSamples.length,
            profitableSampleRatePct: samples.length ? roundUsd((profitableSamples.length / samples.length) * 100) : 0,
            positiveBestObservedSamples: positiveObservedSamples.length,
            positiveBestObservedRatePct: samples.length ? roundUsd((positiveObservedSamples.length / samples.length) * 100) : 0,
            totalTopProfitableNetUsd: roundUsd(profitableSamples.reduce((sum, sample) => sum + sample.topProfitableCandidate.netProfitUsd, 0)),
            totalPositiveBestObservedNetUsd: roundUsd(positiveObservedSamples.reduce((sum, sample) => sum + sample.bestObservedCandidate.netProfitUsd, 0)),
            averageBestObservedNetUsd: samples.length
                ? roundUsd(samples.reduce((sum, sample) => sum + (sample.bestObservedCandidate ? sample.bestObservedCandidate.netProfitUsd : 0), 0) / samples.length)
                : 0
        },
        bestSample
    };

    console.log("\n=== 2-Month Arbitrage Replay Summary ===");
    console.log(JSON.stringify(summary, null, 2));

    try {
        provider.destroy();
    } catch (_) {
        // No-op.
    }
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
