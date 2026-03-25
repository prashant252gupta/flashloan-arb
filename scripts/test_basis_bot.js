const assert = require("assert");

const { loadConfig } = require("../src/config");
const { replaySnapshots } = require("../src/replay");
const { buildMonthlyPerformanceReport } = require("../src/reporting/performanceReport");

const config = loadConfig({
    EXCHANGES: "binance",
    SYMBOLS: "BTCUSDT",
    BASIS_RECORD_SNAPSHOTS: "0",
    BASIS_RECORD_TRADE_LOGS: "0",
    BASIS_STARTING_CAPITAL_USD: "5000",
    BASIS_CAPITAL_PER_TRADE_USD: "1000",
    BASIS_MAX_ACTIVE_POSITIONS: "1",
    BASIS_MIN_FUNDING_RATE_BPS: "2",
    BASIS_EXIT_FUNDING_RATE_BPS: "1",
    BASIS_MIN_NET_EDGE_BPS: "1",
    BASIS_CAPTURE_FACTOR: "0.25",
    BASIS_SPOT_TAKER_FEE_BPS: "5",
    BASIS_PERP_TAKER_FEE_BPS: "5",
    BASIS_SLIPPAGE_BPS: "1",
    BASIS_SAFETY_BUFFER_BPS: "1",
    BASIS_STOP_LOSS_BPS: "100",
    BASIS_TAKE_PROFIT_BPS: "200",
    BASIS_MAX_HOLD_HOURS: "48"
});

const t0 = Date.parse("2026-03-25T00:00:00.000Z");
const fundingTime = t0 + (60 * 60 * 1000);
const t1 = fundingTime + (5 * 60 * 1000);
const t2 = t1 + (2 * 60 * 60 * 1000);

function marketAt(timestamp, fundingRate, spotBid, spotAsk, perpBid, perpAsk, nextFundingTime) {
    return {
        timestamp,
        markets: [{
            exchange: "binance",
            symbol: "BTCUSDT",
            baseAsset: "BTC",
            quoteAsset: "USDT",
            spotSymbol: "BTCUSDT",
            perpSymbol: "BTCUSDT",
            spotBid,
            spotAsk,
            perpBid,
            perpAsk,
            spotMid: (spotBid + spotAsk) / 2,
            perpMid: (perpBid + perpAsk) / 2,
            markPrice: (perpBid + perpAsk) / 2,
            indexPrice: (spotBid + spotAsk) / 2,
            fundingRate,
            nextFundingTime,
            fundingIntervalHours: 8,
            basisBps: ((perpBid - spotAsk) / spotAsk) * 10000,
            entryBasisBps: ((perpBid - spotAsk) / spotAsk) * 10000,
            exitBasisBps: ((perpAsk - spotBid) / spotBid) * 10000,
            sourceTimestamp: timestamp
        }],
        errors: []
    };
}

const snapshots = [
    marketAt(t0, 0.0008, 100, 100.2, 100.8, 101, fundingTime),
    marketAt(t1, 0.0012, 100.1, 100.3, 100.75, 100.95, fundingTime + (8 * 60 * 60 * 1000)),
    marketAt(t2, 0.00005, 100.4, 100.6, 100.45, 100.65, fundingTime + (8 * 60 * 60 * 1000))
];

const summary = replaySnapshots(config, snapshots);
const report = buildMonthlyPerformanceReport(summary, snapshots);

assert.strictEqual(summary.closedTrades, 1, "expected one completed trade");
assert(summary.realizedPnlUsd > 0, "expected positive realized PnL");
assert(summary.fundingPnlUsd > 0, "expected positive funding PnL");
assert.strictEqual(summary.closedTradeRecords.length, 1, "expected one serialized closed trade");
assert(summary.fundingEventRecords.length > 0, "expected funding events during replay");
assert.strictEqual(report.months.length, 1, "expected one month in report");
assert(report.months[0].netPnlUsd > 0, "expected monthly report to show positive net pnl");

console.log("basis bot self-test passed");
