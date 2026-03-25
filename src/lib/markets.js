function toNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function toMid(bid, ask, fallback) {
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
        return (bid + ask) / 2;
    }
    return Number.isFinite(fallback) ? fallback : null;
}

function stripQuoteAsset(symbol, quoteAsset) {
    if (!symbol || !quoteAsset) return symbol;
    return symbol.endsWith(quoteAsset) ? symbol.slice(0, -quoteAsset.length) : symbol;
}

function basisBps(perpPrice, spotPrice) {
    if (!Number.isFinite(perpPrice) || !Number.isFinite(spotPrice) || spotPrice <= 0) return null;
    return ((perpPrice - spotPrice) / spotPrice) * 10000;
}

function marketKey(market) {
    return `${market.exchange}:${market.symbol}`;
}

function indexMarkets(markets) {
    return new Map(markets.map((market) => [marketKey(market), market]));
}

module.exports = {
    toNumber,
    toMid,
    stripQuoteAsset,
    basisBps,
    marketKey,
    indexMarkets
};
