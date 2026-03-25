require("dotenv").config();

const { loadConfig } = require("../src/config");
const { buildConnectors } = require("../src/exchanges");
const { fetchMarketSnapshot } = require("../src/core/marketScanner");
const { createFundingCarryStrategy } = require("../src/strategy/fundingCarry");
const { fmtUsd, fmtBps } = require("../src/lib/format");

(async () => {
    const config = loadConfig({ BASIS_RECORD_SNAPSHOTS: "0" });
    const connectors = buildConnectors(config);
    const strategy = createFundingCarryStrategy(config);
    const snapshot = await fetchMarketSnapshot(connectors);
    const scored = strategy.scoreMarkets(snapshot.markets, snapshot.timestamp).slice(0, config.reportTopN);

    console.log(JSON.stringify({
        timestamp: new Date(snapshot.timestamp).toISOString(),
        markets: snapshot.markets.length,
        errors: snapshot.errors,
        topSignals: scored.map((item) => ({
            exchange: item.exchange,
            symbol: item.symbol,
            fundingBps: fmtBps(item.fundingBps),
            entryBasisBps: fmtBps(item.entryBasisBps || 0),
            netEdgeBps: fmtBps(item.netEdgeBps),
            expectedNetUsd: fmtUsd(item.expectedNetUsd),
            minutesToFunding: Math.round(item.minutesToFunding),
            qualifies: item.qualifies
        }))
    }, null, 2));
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
