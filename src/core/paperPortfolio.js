const { marketKey } = require("../lib/markets");

class PaperPortfolio {
    constructor(config) {
        this.config = config;
        this.availableCapitalUsd = config.startingCapitalUsd;
        this.positions = [];
        this.closedTrades = [];
    }

    getOpenPositions() {
        return this.positions.filter((position) => !position.closedAt);
    }

    openPosition(opportunity, openedAt) {
        if (this.getOpenPositions().length >= this.config.maxActivePositions) return null;

        const reservedCapitalUsd = Math.min(this.config.capitalPerTradeUsd, this.availableCapitalUsd);
        if (reservedCapitalUsd <= 0) return null;

        const quantity = reservedCapitalUsd / opportunity.spotAsk;
        const entryFeesUsd = reservedCapitalUsd * ((this.config.spotTakerFeeBps + this.config.perpTakerFeeBps) / 10000);

        this.availableCapitalUsd -= reservedCapitalUsd + entryFeesUsd;

        const position = {
            id: `${opportunity.key}:${openedAt}`,
            key: marketKey(opportunity),
            exchange: opportunity.exchange,
            symbol: opportunity.symbol,
            direction: opportunity.direction,
            openedAt,
            reservedCapitalUsd,
            quantity,
            spotEntry: opportunity.spotAsk,
            perpEntry: opportunity.perpBid,
            entryFeesUsd,
            accruedFundingUsd: 0,
            realizedFundingUsd: 0,
            fundingEvents: 0,
            expectedFundingRate: opportunity.fundingRate || 0,
            nextFundingTime: opportunity.nextFundingTime || 0,
            fundingIntervalHours: opportunity.fundingIntervalHours || 8
        };

        this.positions.push(position);
        return position;
    }

    estimatePosition(position, market) {
        const spotPnlUsd = position.quantity * (market.spotBid - position.spotEntry);
        const perpPnlUsd = position.quantity * (position.perpEntry - market.perpAsk);
        const exitFeesUsd = position.reservedCapitalUsd * ((this.config.spotTakerFeeBps + this.config.perpTakerFeeBps) / 10000);
        const grossPnlUsd = spotPnlUsd + perpPnlUsd + position.accruedFundingUsd;
        const netPnlUsd = grossPnlUsd - position.entryFeesUsd - exitFeesUsd;
        const netReturnBps = position.reservedCapitalUsd > 0
            ? (netPnlUsd / position.reservedCapitalUsd) * 10000
            : 0;

        return {
            spotPnlUsd,
            perpPnlUsd,
            exitFeesUsd,
            grossPnlUsd,
            netPnlUsd,
            netReturnBps
        };
    }

    processFunding(snapshotTimestamp, marketIndex) {
        const fundingEvents = [];
        for (const position of this.getOpenPositions()) {
            const market = marketIndex.get(position.key);
            if (!market) continue;

            if (position.expectedFundingRate !== market.fundingRate && snapshotTimestamp < position.nextFundingTime) {
                position.expectedFundingRate = market.fundingRate || 0;
            }

            while (position.nextFundingTime && snapshotTimestamp >= position.nextFundingTime) {
                const fundingPnlUsd = position.reservedCapitalUsd * (position.expectedFundingRate || 0);
                position.accruedFundingUsd += fundingPnlUsd;
                position.realizedFundingUsd += fundingPnlUsd;
                position.fundingEvents += 1;

                fundingEvents.push({
                    positionId: position.id,
                    exchange: position.exchange,
                    symbol: position.symbol,
                    timestamp: position.nextFundingTime,
                    fundingRate: position.expectedFundingRate || 0,
                    fundingPnlUsd,
                    fundingEvents: position.fundingEvents,
                    accruedFundingUsd: position.accruedFundingUsd
                });

                const nextTime = market.nextFundingTime && market.nextFundingTime > position.nextFundingTime
                    ? market.nextFundingTime
                    : position.nextFundingTime + (position.fundingIntervalHours * 3600000);

                position.nextFundingTime = nextTime;
                position.expectedFundingRate = market.fundingRate || 0;
            }
        }
        return fundingEvents;
    }

    closePosition(position, market, closedAt, reasons) {
        const estimate = this.estimatePosition(position, market);
        position.closedAt = closedAt;
        position.closeReasons = reasons.slice();
        position.closeMarket = {
            spotBid: market.spotBid,
            perpAsk: market.perpAsk,
            fundingRate: market.fundingRate
        };
        position.netPnlUsd = estimate.netPnlUsd;
        position.grossPnlUsd = estimate.grossPnlUsd;
        position.netReturnBps = estimate.netReturnBps;

        this.availableCapitalUsd += position.reservedCapitalUsd + estimate.grossPnlUsd - estimate.exitFeesUsd;
        this.closedTrades.push(position);

        return position;
    }

    summary(marketIndex) {
        const openPositions = this.getOpenPositions();
        const openEquityUsd = openPositions.reduce((total, position) => {
            const market = marketIndex.get(position.key);
            if (!market) return total + position.reservedCapitalUsd;
            const estimate = this.estimatePosition(position, market);
            return total + position.reservedCapitalUsd + estimate.grossPnlUsd - estimate.exitFeesUsd;
        }, 0);

        const realizedPnlUsd = this.closedTrades.reduce((sum, trade) => sum + (trade.netPnlUsd || 0), 0);
        const fundingPnlUsd = this.closedTrades.reduce((sum, trade) => sum + (trade.realizedFundingUsd || 0), 0)
            + openPositions.reduce((sum, trade) => sum + (trade.realizedFundingUsd || 0), 0);

        return {
            availableCapitalUsd: this.availableCapitalUsd,
            openPositions: openPositions.length,
            closedTrades: this.closedTrades.length,
            realizedPnlUsd,
            fundingPnlUsd,
            equityUsd: this.availableCapitalUsd + openEquityUsd
        };
    }
}

module.exports = {
    PaperPortfolio
};
