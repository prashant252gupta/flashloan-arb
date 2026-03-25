const { BinanceConnector } = require("./binance");
const { BybitConnector } = require("./bybit");

function buildConnectors(config) {
    return config.exchanges.map((name) => {
        if (name === "binance") return new BinanceConnector(config);
        if (name === "bybit") return new BybitConnector(config);
        throw new Error(`Unsupported exchange connector: ${name}`);
    });
}

module.exports = {
    buildConnectors
};
