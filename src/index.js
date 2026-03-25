const { loadConfig } = require("./config");
const { createScanner } = require("../worker");
const { createConsoleReporter } = require("./reporting/consoleReporter");
const { createCandidateLogger } = require("./reporting/candidateLogger");
const { createPrivateExecutor } = require("./execution/privateOrderflow");

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runBot(options = {}) {
    const config = loadConfig(options.overrides);
    const reporter = createConsoleReporter(config);
    const logger = createCandidateLogger(config);
    const scanner = await createScanner(config);
    const executor = await createPrivateExecutor(config, scanner.provider);
    const once = Boolean(options.once);
    const maxCycles = Number.isFinite(options.maxCycles) ? options.maxCycles : null;
    let cycles = 0;

    if (config.privateExecution && executor && executor.enabled === false) {
        console.log(`[private-orderflow] disabled: ${executor.reason}`);
    }

    while (true) {
        const report = await scanner.scanOnce();
        reporter.report(report);
        logger.log(report);

        if (executor && executor.enabled && report.profitableCandidates.length) {
            const candidate = report.profitableCandidates.find((row) => executor.canExecuteCandidate(row));
            if (candidate) {
                const execution = await executor.submitCandidate(candidate);
                const targetRelayCount = execution.relayResults ? execution.relayResults.length : 0;
                console.log(
                    `[private-orderflow] ${execution.dryRun ? "simulated" : "submitted"} ` +
                    `${candidate.baseSymbol}->${candidate.midSymbol}->${candidate.baseSymbol} ` +
                    `across ${targetRelayCount} relay targets`
                );
            }
        }

        cycles += 1;
        if (once || (maxCycles !== null && cycles >= maxCycles)) break;
        await sleep(config.loopIntervalMs);
    }

    try {
        scanner.provider.destroy();
    } catch (_) {
        // No-op.
    }
}

module.exports = {
    runBot
};
