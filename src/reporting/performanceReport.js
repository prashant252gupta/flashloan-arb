function round(value, digits = 2) {
    if (!Number.isFinite(value)) return value;
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}

function toMonthKey(timestamp) {
    return new Date(timestamp).toISOString().slice(0, 7);
}

function summarizeTrades(trades) {
    const count = trades.length;
    const wins = trades.filter((trade) => trade.netPnlUsd > 0).length;
    const losses = trades.filter((trade) => trade.netPnlUsd < 0).length;
    const netPnlUsd = trades.reduce((sum, trade) => sum + trade.netPnlUsd, 0);
    const grossPnlUsd = trades.reduce((sum, trade) => sum + trade.grossPnlUsd, 0);
    const fundingPnlUsd = trades.reduce((sum, trade) => sum + trade.fundingPnlUsd, 0);
    const avgNetReturnBps = count
        ? trades.reduce((sum, trade) => sum + trade.netReturnBps, 0) / count
        : 0;
    const avgHoldHours = count
        ? trades.reduce((sum, trade) => sum + trade.holdHours, 0) / count
        : 0;
    const totalCapitalUsd = trades.reduce((sum, trade) => sum + trade.reservedCapitalUsd, 0);
    const bestTrade = trades.reduce((best, trade) => (!best || trade.netPnlUsd > best.netPnlUsd ? trade : best), null);
    const worstTrade = trades.reduce((worst, trade) => (!worst || trade.netPnlUsd < worst.netPnlUsd ? trade : worst), null);

    return {
        tradeCount: count,
        winRatePct: count ? round((wins / count) * 100, 2) : 0,
        wins,
        losses,
        netPnlUsd: round(netPnlUsd, 2),
        grossPnlUsd: round(grossPnlUsd, 2),
        fundingPnlUsd: round(fundingPnlUsd, 2),
        avgNetReturnBps: round(avgNetReturnBps, 2),
        avgHoldHours: round(avgHoldHours, 2),
        totalCapitalUsd: round(totalCapitalUsd, 2),
        bestTradeUsd: bestTrade ? round(bestTrade.netPnlUsd, 2) : 0,
        worstTradeUsd: worstTrade ? round(worstTrade.netPnlUsd, 2) : 0
    };
}

function buildMonthlyPerformanceReport(replayResult, snapshots = []) {
    const closedTrades = replayResult.closedTradeRecords || [];
    const monthly = new Map();

    for (const trade of closedTrades) {
        const key = toMonthKey(trade.closedAt || trade.openedAt);
        if (!monthly.has(key)) monthly.set(key, []);
        monthly.get(key).push(trade);
    }

    return {
        dataset: {
            snapshots: snapshots.length,
            from: snapshots.length ? new Date(snapshots[0].timestamp).toISOString() : null,
            to: snapshots.length ? new Date(snapshots[snapshots.length - 1].timestamp).toISOString() : null,
            closedTrades: replayResult.closedTrades,
            openPositions: replayResult.openPositions
        },
        overall: summarizeTrades(closedTrades),
        months: Array.from(monthly.entries())
            .sort((left, right) => left[0].localeCompare(right[0]))
            .map(([month, trades]) => ({
                month,
                ...summarizeTrades(trades)
            }))
    };
}

module.exports = {
    buildMonthlyPerformanceReport
};
