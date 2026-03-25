const { fetchJson } = require("../lib/http");
const { toNumber, toMid, stripQuoteAsset, basisBps } = require("../lib/markets");

class BinanceConnector {
    constructor(config) {
        this.config = config;
        this.name = "binance";
        this.spotBaseUrl = "https://api.binance.com";
        this.perpBaseUrl = "https://fapi.binance.com";
    }

    async fetchMarkets() {
        const [spotBooks, perpPremium, perpBooks] = await Promise.all([
            fetchJson(`${this.spotBaseUrl}/api/v3/ticker/bookTicker`, {
                timeoutMs: this.config.requestTimeoutMs,
                retries: this.config.requestRetries
            }),
            fetchJson(`${this.perpBaseUrl}/fapi/v1/premiumIndex`, {
                timeoutMs: this.config.requestTimeoutMs,
                retries: this.config.requestRetries
            }),
            fetchJson(`${this.perpBaseUrl}/fapi/v1/ticker/bookTicker`, {
                timeoutMs: this.config.requestTimeoutMs,
                retries: this.config.requestRetries
            })
        ]);

        const spotBySymbol = new Map((Array.isArray(spotBooks) ? spotBooks : []).map((item) => [item.symbol, item]));
        const perpBookBySymbol = new Map((Array.isArray(perpBooks) ? perpBooks : []).map((item) => [item.symbol, item]));
        const wanted = new Set(this.config.symbols);

        return (Array.isArray(perpPremium) ? perpPremium : [])
            .filter((item) => wanted.has(item.symbol))
            .map((item) => {
                const spot = spotBySymbol.get(item.symbol);
                const perpBook = perpBookBySymbol.get(item.symbol);
                if (!spot || !perpBook) return null;

                const spotBid = toNumber(spot.bidPrice);
                const spotAsk = toNumber(spot.askPrice);
                const markPrice = toNumber(item.markPrice);
                const indexPrice = toNumber(item.indexPrice);
                const perpBid = toNumber(perpBook.bidPrice);
                const perpAsk = toNumber(perpBook.askPrice);
                const spotMid = toMid(spotBid, spotAsk, null);
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
                    fundingRate: toNumber(item.lastFundingRate),
                    nextFundingTime: Number(item.nextFundingTime || 0),
                    fundingIntervalHours: 8,
                    basisBps: basisBps(perpMid, spotMid),
                    entryBasisBps: basisBps(perpBid, spotAsk),
                    exitBasisBps: basisBps(perpAsk, spotBid),
                    sourceTimestamp: Number(item.time || Date.now())
                };
            })
            .filter(Boolean);
    }
}

module.exports = {
    BinanceConnector
};
