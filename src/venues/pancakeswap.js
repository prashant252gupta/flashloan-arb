const { ethers } = require("ethers");

const { pancakeQuoterV2Abi } = require("../lib/abis");

class PancakeVenue {
    constructor(config, provider) {
        this.name = "pancakeswap";
        this.fees = config.pancakeFees;
        this.routerAddress = config.pancakeRouter;
        this.quoter = new ethers.Contract(config.pancakeQuoter, pancakeQuoterV2Abi, provider);
        this.iface = new ethers.utils.Interface(pancakeQuoterV2Abi);
    }

    buildBatchCalls(tokenIn, tokenOut, amountInRaw) {
        return this.fees.map((fee) => ({
            target: this.quoter.address,
            callData: this.iface.encodeFunctionData("quoteExactInputSingle", [{
                tokenIn: tokenIn.address,
                tokenOut: tokenOut.address,
                amountIn: amountInRaw,
                fee,
                sqrtPriceLimitX96: 0
            }]),
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
                const result = await this.quoter.callStatic.quoteExactInputSingle({
                    tokenIn: tokenIn.address,
                    tokenOut: tokenOut.address,
                    amountIn: amountInRaw,
                    fee,
                    sqrtPriceLimitX96: 0
                }, overrides);

                const amountOutRaw = Array.isArray(result) ? result[0] : result.amountOut;
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
    PancakeVenue
};
