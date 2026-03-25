require("dotenv").config();

const { loadConfig } = require("../src/config");
const { readJsonLines } = require("../src/lib/jsonl");
const { replaySnapshots } = require("../src/replay");
const { buildMonthlyPerformanceReport } = require("../src/reporting/performanceReport");

function parseArgs() {
    const args = process.argv.slice(2);
    const out = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--file") out.file = args[++i];
    }
    return out;
}

(async () => {
    const args = parseArgs();
    const config = loadConfig();
    const filePath = args.file || config.snapshotPath;
    const snapshots = readJsonLines(filePath);
    const replayResult = replaySnapshots(config, snapshots);
    const report = buildMonthlyPerformanceReport(replayResult, snapshots);
    console.log(JSON.stringify(report, null, 2));
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
