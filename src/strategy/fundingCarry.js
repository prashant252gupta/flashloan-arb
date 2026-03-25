const { marketKey } = require("../lib/markets");

function evaluateMarket(market, config, now) {
    const fundingBps = (market.fundingRate || 0) * 10000;
    const minutesToFunding = market.nextFundingTime
        ? (market.nextFundingTime - now) / 60000
        : Number.POSITIVE_INFINITY;
    const entryCostBps = config.spotTakerFeeBps + config.perpTakerFeeBps + config.slippageBps + config.safetyBufferBps;
    const basisTailwindBps = Math.max(0, market.entryBasisBps || 0) * config.basisCaptureFactor;
    const netEdgeBps = fundingBps + basisTailwindBps - entryCostBps;
    const expectedNetUsd = config.capitalPerTradeUsd * (netEdgeBps / 10000);

    return {
        ...market,
        key: marketKey(market),
        direction: "long_spot_short_perp",
        fundingBps,
        minutesToFunding,
        entryCostBps,
        basisTailwindBps,
        netEdgeBps,
        expectedNetUsd,
        qualifies:
            fundingBps >= config.minFundingRateBps &&
            netEdgeBps >= config.minNetEdgeBps &&
            minutesToFunding >= 0 &&
            minutesToFunding <= config.maxTimeToFundingMinutes
    };
}

function createFundingCarryStrategy(config) {
    return {
        scoreMarkets(markets, now = Date.now()) {
            return markets
                .map((market) => evaluateMarket(market, config, now))
                .sort((left, right) => right.netEdgeBps - left.netEdgeBps);
        },

        decide(snapshot, portfolio) {
            const scored = this.scoreMarkets(snapshot.markets, snapshot.timestamp);
            const openKeys = new Set(portfolio.getOpenPositions().map((position) => position.key));

            const openCandidates = scored
                .filter((opportunity) => opportunity.qualifies && !openKeys.has(opportunity.key))
                .slice(0, Math.max(0, config.maxActivePositions - portfolio.getOpenPositions().length));

            const closeCandidates = portfolio.getOpenPositions().flatMap((position) => {
                const market = scored.find((item) => item.key === position.key);
                if (!market) return [];

                const estimated = portfolio.estimatePosition(position, market);
                const reasons = [];
                const hoursHeld = (snapshot.timestamp - position.openedAt) / 3600000;

                if (estimated.netReturnBps <= -config.stopLossBps) reasons.push("stop_loss");
                if (estimated.netReturnBps >= config.takeProfitBps) reasons.push("take_profit");
                if (hoursHeld >= config.maxHoldHours) reasons.push("max_hold");
                if (market.fundingBps < config.exitFundingRateBps) reasons.push("funding_decay");
                if (market.netEdgeBps < 0) reasons.push("edge_lost");

                return reasons.length ? [{ position, market, reasons }] : [];
            });

            return {
                scored,
                openCandidates,
                closeCandidates
            };
        }
    };
}

module.exports = {
    createFundingCarryStrategy
};
