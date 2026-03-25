require("dotenv").config();

const { loadConfig } = require("../src/config");
const { buildConnectors } = require("../src/exchanges");
const { fetchMarketSnapshot } = require("../src/core/marketScanner");
const { appendJsonLine } = require("../src/lib/jsonl");

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--cycles") options.cycles = Number(args[++i]);
        if (args[i] === "--interval-ms") options.intervalMs = Number(args[++i]);
    }
    return options;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
    const args = parseArgs();
    const config = loadConfig(args.intervalMs ? { BASIS_LOOP_INTERVAL_MS: String(args.intervalMs) } : {});
    const connectors = buildConnectors(config);
    const cycles = Number.isFinite(args.cycles) ? args.cycles : 10;

    for (let i = 0; i < cycles; i++) {
        const snapshot = await fetchMarketSnapshot(connectors);
        appendJsonLine(config.snapshotPath, snapshot);
        console.log(`recorded snapshot ${i + 1}/${cycles} with ${snapshot.markets.length} markets`);
        if (i < cycles - 1) await sleep(config.loopIntervalMs);
    }
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
