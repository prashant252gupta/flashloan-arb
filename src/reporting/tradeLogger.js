const { appendJsonLine } = require("../lib/jsonl");

function createTradeLogger(config) {
    function log(event) {
        if (!config.recordTradeLogs) return;
        appendJsonLine(config.tradeLogPath, event);
    }

    return {
        logOpenEvent(position, opportunity) {
            log({
                eventType: "open",
                timestamp: position.openedAt,
                positionId: position.id,
                exchange: position.exchange,
                symbol: position.symbol,
                direction: position.direction,
                reservedCapitalUsd: position.reservedCapitalUsd,
                quantity: position.quantity,
                spotEntry: position.spotEntry,
                perpEntry: position.perpEntry,
                fundingRate: opportunity.fundingRate || 0,
                fundingBps: opportunity.fundingBps || 0,
                netEdgeBps: opportunity.netEdgeBps || 0,
                expectedNetUsd: opportunity.expectedNetUsd || 0,
                minutesToFunding: opportunity.minutesToFunding
            });
        },

        logFundingEvent(event) {
            log({
                eventType: "funding",
                timestamp: event.timestamp,
                positionId: event.positionId,
                exchange: event.exchange,
                symbol: event.symbol,
                fundingRate: event.fundingRate,
                fundingPnlUsd: event.fundingPnlUsd,
                fundingEvents: event.fundingEvents,
                accruedFundingUsd: event.accruedFundingUsd
            });
        },

        logCloseEvent(position) {
            log({
                eventType: "close",
                timestamp: position.closedAt,
                positionId: position.id,
                exchange: position.exchange,
                symbol: position.symbol,
                direction: position.direction,
                reservedCapitalUsd: position.reservedCapitalUsd,
                quantity: position.quantity,
                fundingEvents: position.fundingEvents || 0,
                fundingPnlUsd: position.realizedFundingUsd || 0,
                grossPnlUsd: position.grossPnlUsd || 0,
                netPnlUsd: position.netPnlUsd || 0,
                netReturnBps: position.netReturnBps || 0,
                closeReasons: position.closeReasons || [],
                spotExit: position.closeMarket ? position.closeMarket.spotBid : null,
                perpExit: position.closeMarket ? position.closeMarket.perpAsk : null,
                closeFundingRate: position.closeMarket ? position.closeMarket.fundingRate : null
            });
        }
    };
}

module.exports = {
    createTradeLogger
};
