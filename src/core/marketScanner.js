async function fetchMarketSnapshot(connectors) {
    const settled = await Promise.allSettled(connectors.map((connector) => connector.fetchMarkets()));
    const timestamp = Date.now();
    const markets = [];
    const errors = [];

    settled.forEach((result, index) => {
        if (result.status === "fulfilled") {
            markets.push(...result.value);
            return;
        }
        errors.push({
            exchange: connectors[index].name,
            message: result.reason ? result.reason.message : "Unknown fetch error"
        });
    });

    return {
        timestamp,
        markets,
        errors
    };
}

module.exports = {
    fetchMarketSnapshot
};
