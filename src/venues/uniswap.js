const { ethers } = require("ethers");

const { uniswapQuoterAbi } = require("../lib/abis");

class UniswapVenue {
    constructor(config, provider) {
        this.name = "uniswap";
        this.fees = config.uniFees;
        this.routerAddress = config.uniswapRouter;
        this.quoter = new ethers.Contract(config.uniswapQuoter, uniswapQuoterAbi, provider);
        this.iface = new ethers.utils.Interface(uniswapQuoterAbi);
    }

    buildBatchCalls(tokenIn, tokenOut, amountInRaw) {
        return this.fees.map((fee) => ({
            target: this.quoter.address,
            callData: this.iface.encodeFunctionData("quoteExactInputSingle", [
                tokenIn.address,
                tokenOut.address,
                fee,
                amountInRaw,
                0
            ]),
            meta: {
                venue: this.name,
                routeId: `${this.name}:${fee}`,
                fee,
                routerAddress: this.routerAddress
            }
        }));
    }

    parseBatchResult(meta, returnData) {
        const decoded = this.iface.decodeFunctionResult("quoteExactInputSingle", returnData);
        return {
            venue: this.name,
            routeId: meta.routeId,
            fee: meta.fee,
            routerAddress: meta.routerAddress,
            amountOutRaw: decoded[0]
        };
    }

    async quoteExactIn(tokenIn, tokenOut, amountInRaw, options = {}) {
        const quotes = [];

        for (const fee of this.fees) {
            try {
                const overrides = options.blockTag ? { blockTag: options.blockTag } : {};
                const amountOutRaw = await this.quoter.callStatic.quoteExactInputSingle(
                    tokenIn.address,
                    tokenOut.address,
                    fee,
                    amountInRaw,
                    0,
                    overrides
                );

                quotes.push({
                    venue: this.name,
                    routeId: `${this.name}:${fee}`,
                    fee,
                    routerAddress: this.routerAddress,
                    amountOutRaw
                });
            } catch (_) {
                // Ignore missing pools or unquotable routes.
            }
        }

        return quotes;
    }
}

module.exports = {
    UniswapVenue
};
