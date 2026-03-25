const { fetchJson } = require("../lib/http");
const { toNumber, toMid, stripQuoteAsset, basisBps } = require("../lib/markets");

class BybitConnector {
    constructor(config) {
        this.config = config;
        this.name = "bybit";
        this.baseUrl = "https://api.bybit.com";
    }

    async fetchMarkets() {
        const [spotTickers, linearTickers] = await Promise.all([
            fetchJson(`${this.baseUrl}/v5/market/tickers`, {
                params: { category: "spot" },
                timeoutMs: this.config.requestTimeoutMs,
                retries: this.config.requestRetries
            }),
            fetchJson(`${this.baseUrl}/v5/market/tickers`, {
                params: { category: "linear" },
                timeoutMs: this.config.requestTimeoutMs,
                retries: this.config.requestRetries
            })
        ]);

        const spotList = spotTickers && spotTickers.result && Array.isArray(spotTickers.result.list)
            ? spotTickers.result.list
            : [];
        const linearList = linearTickers && linearTickers.result && Array.isArray(linearTickers.result.list)
            ? linearTickers.result.list
            : [];

        const spotBySymbol = new Map(spotList.map((item) => [item.symbol, item]));
        const wanted = new Set(this.config.symbols);

        return linearList
            .filter((item) => wanted.has(item.symbol))
            .map((item) => {
                const spot = spotBySymbol.get(item.symbol);
                if (!spot) return null;

                const spotBid = toNumber(spot.bid1Price);
                const spotAsk = toNumber(spot.ask1Price);
                const perpBid = toNumber(item.bid1Price);
                const perpAsk = toNumber(item.ask1Price);
                const markPrice = toNumber(item.markPrice);
                const indexPrice = toNumber(item.indexPrice);
                const spotMid = toMid(spotBid, spotAsk, toNumber(spot.lastPrice));
                const perpMid = toMid(perpBid, perpAsk, markPrice);

                if (!spotBid || !spotAsk || !perpBid || !perpAsk || !spotMid || !perpMid) return null;

                return {
                    exchange: this.name,
                    symbol: item.symbol,
                    baseAsset: stripQuoteAsset(item.symbol, this.config.quoteAsset),
                    quoteAsset: this.config.quoteAsset,
                    spotSymbol: item.symbol,
                    perpSymbol: item.symbol,
                    spotBid,
                    spotAsk,
                    perpBid,
                    perpAsk,
                    spotMid,
                    perpMid,
                    markPrice,
                    indexPrice,
                    fundingRate: toNumber(item.fundingRate),
                    nextFundingTime: Number(item.nextFundingTime || 0),
                    fundingIntervalHours: Number(item.fundingIntervalHour || 8),
                    basisBps: basisBps(perpMid, spotMid),
                    entryBasisBps: basisBps(perpBid, spotAsk),
                    exitBasisBps: basisBps(perpAsk, spotBid),
                    openInterestUsd: toNumber(item.openInterestValue),
                    turnover24hUsd: toNumber(item.turnover24h),
                    sourceTimestamp: Number(linearTickers.time || Date.now())
                };
            })
            .filter(Boolean);
    }
}

module.exports = {
    BybitConnector
};
