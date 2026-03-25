const { indexMarkets } = require("./lib/markets");
const { PaperPortfolio } = require("./core/paperPortfolio");
const { createFundingCarryStrategy } = require("./strategy/fundingCarry");

function serializeClosedTrade(trade) {
    const holdHours = trade.closedAt && trade.openedAt
        ? (trade.closedAt - trade.openedAt) / 3600000
        : 0;

    return {
        id: trade.id,
        key: trade.key,
        exchange: trade.exchange,
        symbol: trade.symbol,
        direction: trade.direction,
        openedAt: trade.openedAt,
        closedAt: trade.closedAt || null,
        holdHours,
        reservedCapitalUsd: trade.reservedCapitalUsd,
        quantity: trade.quantity,
        spotEntry: trade.spotEntry,
        perpEntry: trade.perpEntry,
        spotExit: trade.closeMarket ? trade.closeMarket.spotBid : null,
        perpExit: trade.closeMarket ? trade.closeMarket.perpAsk : null,
        closeFundingRate: trade.closeMarket ? trade.closeMarket.fundingRate : null,
        closeReasons: trade.closeReasons || [],
        fundingEvents: trade.fundingEvents || 0,
        fundingPnlUsd: trade.realizedFundingUsd || 0,
        grossPnlUsd: trade.grossPnlUsd || 0,
        netPnlUsd: trade.netPnlUsd || 0,
        netReturnBps: trade.netReturnBps || 0
    };
}

function replaySnapshots(config, snapshots) {
    const portfolio = new PaperPortfolio(config);
    const strategy = createFundingCarryStrategy(config);
    const fundingEventRecords = [];

    for (const snapshot of snapshots) {
        const marketIndex = indexMarkets(snapshot.markets || []);
        fundingEventRecords.push(...portfolio.processFunding(snapshot.timestamp, marketIndex));

        const decisions = strategy.decide(snapshot, portfolio);
        for (const item of decisions.closeCandidates) {
            portfolio.closePosition(item.position, item.market, snapshot.timestamp, item.reasons);
        }

        for (const opportunity of decisions.openCandidates) {
            portfolio.openPosition(opportunity, snapshot.timestamp);
        }
    }

    const finalSummary = portfolio.summary(new Map());
    return {
        cycles: snapshots.length,
        openPositions: finalSummary.openPositions,
        closedTrades: finalSummary.closedTrades,
        equityUsd: finalSummary.equityUsd,
        realizedPnlUsd: finalSummary.realizedPnlUsd,
        fundingPnlUsd: finalSummary.fundingPnlUsd,
        closedTradeRecords: portfolio.closedTrades.map((trade) => serializeClosedTrade(trade)),
        fundingEventRecords
    };
}

module.exports = {
    replaySnapshots
};
