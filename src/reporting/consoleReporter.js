const { fmtBps, fmtUsd } = require("../lib/format");

function createConsoleReporter(config) {
    return {
        report(report) {
            console.log(
                `[${new Date(report.timestamp).toISOString()}] ` +
                `routes=${report.evaluatedRoutes} gas=${report.gasPriceGwei.toFixed(2)}gwei ` +
                `ethUsd=${report.ethUsd.toFixed(2)} profitable=${report.profitableCandidates.length}`
            );

            const rows = report.profitableCandidates.length
                ? report.profitableCandidates.slice(0, config.topCandidates)
                : (report.bestObservedCandidate ? [report.bestObservedCandidate] : []);

            if (!rows.length) {
                console.log("no quoteable routes found");
                return;
            }

            const prefix = report.profitableCandidates.length ? "top profitable:" : "best observed:";
            console.log(prefix);
            for (const candidate of rows) {
                console.log(
                    `${candidate.baseSymbol}->${candidate.midSymbol}->${candidate.baseSymbol} ` +
                    `${candidate.firstVenue} then ${candidate.secondVenue} ` +
                    `gross=${fmtUsd(candidate.grossProfitUsd)} net=${fmtUsd(candidate.netProfitUsd)} ` +
                    `spread=${fmtBps(candidate.spreadBps)}`
                );
            }
        }
    };
}

module.exports = {
    createConsoleReporter
};
