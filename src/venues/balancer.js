const { ethers } = require("ethers");

const { postJson } = require("../lib/http");

class BalancerVenue {
    constructor(config) {
        this.name = "balancer";
        this.apiUrl = config.balancerApiUrl;
        this.supportsHistoricalReplay = false;
    }

    async quoteExactIn(tokenIn, tokenOut, amountInRaw) {
        const amountIn = ethers.utils.formatUnits(amountInRaw, tokenIn.decimals);
        const query = `query Quote($tokenIn: String!, $tokenOut: String!, $swapAmount: String!) {
          sorGetSwapPaths(
            chain: MAINNET
            swapAmount: $swapAmount
            swapType: EXACT_IN
            tokenIn: $tokenIn
            tokenOut: $tokenOut
          ) {
            swapAmountRaw
            returnAmountRaw
            priceImpact {
              priceImpact
              error
            }
          }
        }`;

        try {
            const response = await postJson(this.apiUrl, {
                query,
                variables: {
                    tokenIn: tokenIn.address.toLowerCase(),
                    tokenOut: tokenOut.address.toLowerCase(),
                    swapAmount: amountIn
                }
            });

            const payload = response && response.data ? response.data.sorGetSwapPaths : null;
            if (!payload || !payload.returnAmountRaw) return [];

            return [{
                venue: this.name,
                routeId: `${this.name}:sor`,
                fee: 0,
                routerAddress: null,
                amountOutRaw: ethers.BigNumber.from(payload.returnAmountRaw),
                priceImpact: payload.priceImpact && payload.priceImpact.priceImpact
                    ? Number(payload.priceImpact.priceImpact)
                    : null
            }];
        } catch (_) {
            return [];
        }
    }
}

module.exports = {
    BalancerVenue
};
