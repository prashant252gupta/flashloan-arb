const DEFAULT_ASSETS = {
    WETH: {
        symbol: "WETH",
        address: "0xc02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase(),
        decimals: 18,
        stable: false,
        tradeSize: "2"
    },
    USDC: {
        symbol: "USDC",
        address: "0xA0b86991C6218b36c1d19D4a2e9Eb0cE3606eB48".toLowerCase(),
        decimals: 6,
        stable: true,
        tradeSize: "5000"
    },
    USDT: {
        symbol: "USDT",
        address: "0xdAC17F958D2ee523a2206206994597C13D831ec7".toLowerCase(),
        decimals: 6,
        stable: true,
        tradeSize: "5000"
    },
    WBTC: {
        symbol: "WBTC",
        address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599".toLowerCase(),
        decimals: 8,
        stable: false,
        tradeSize: "0.05"
    },
    DAI: {
        symbol: "DAI",
        address: "0x6B175474E89094C44Da98b954EedeAC495271d0F".toLowerCase(),
        decimals: 18,
        stable: true,
        tradeSize: "5000"
    },
    WSTETH: {
        symbol: "WSTETH",
        address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0".toLowerCase(),
        decimals: 18,
        stable: false,
        tradeSize: "1"
    }
};

function buildUniverse(config) {
    const requested = Array.from(new Set([...config.baseAssets, ...config.scanAssets]));
    const assetsBySymbol = {};

    for (const symbol of requested) {
        const asset = DEFAULT_ASSETS[symbol];
        if (!asset) {
            throw new Error(`Unsupported asset symbol in arbitrage universe: ${symbol}`);
        }
        assetsBySymbol[symbol] = {
            ...asset,
            tradeSize: config.tradeSizes[symbol] || asset.tradeSize
        };
    }

    return {
        assetsBySymbol,
        baseAssets: config.baseAssets.map((symbol) => assetsBySymbol[symbol]),
        scanAssets: config.scanAssets.map((symbol) => assetsBySymbol[symbol])
    };
}

module.exports = {
    buildUniverse
};
