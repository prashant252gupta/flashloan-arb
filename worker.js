const { ethers } = require("ethers");

const { buildUniverse } = require("./src/assets");
const { formatUnits, multicall2Abi, parseUnits } = require("./src/lib/abis");
const { UniswapVenue } = require("./src/venues/uniswap");
const { PancakeVenue } = require("./src/venues/pancakeswap");
const { BalancerVenue } = require("./src/venues/balancer");

function computeSpreadBps(amountInRaw, amountOutRaw, decimals) {
    const amountIn = formatUnits(amountInRaw, decimals);
    const amountOut = formatUnits(amountOutRaw, decimals);
    if (!Number.isFinite(amountIn) || amountIn <= 0) return 0;
    return ((amountOut - amountIn) / amountIn) * 10000;
}

function addBpsMargin(amount, bps) {
    return amount.mul(10000 + bps).div(10000);
}

async function createScanner(config) {
    if (!config.rpcUrl) {
        throw new Error("Missing ARB_RPC_URL or RPC_URL/LOCAL_RPC in .env");
    }

    const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
    const universe = buildUniverse(config);
    const multicall = config.enableMulticallBatching
        ? new ethers.Contract(config.multicallAddress, multicall2Abi, provider)
        : null;
    const venues = [];

    if (config.enableUniswap) venues.push(new UniswapVenue(config, provider));
    if (config.enablePancake) venues.push(new PancakeVenue(config, provider));
    if (config.enableBalancer) venues.push(new BalancerVenue(config));

    function getActiveVenues(options = {}) {
        const historical = options.blockTag !== undefined && options.blockTag !== null;
        const includeBalancer = options.includeBalancer !== undefined ? options.includeBalancer : !historical;

        return venues.filter((venue) => {
            if (venue.name === "balancer" && !includeBalancer) return false;
            if (historical && venue.supportsHistoricalReplay === false) return false;
            return true;
        });
    }

    async function quoteAcrossVenues(tokenIn, tokenOut, amountInRaw, options = {}) {
        const activeVenues = getActiveVenues(options);
        const directQuotes = [];

        const batchableVenues = multicall && config.enableMulticallBatching
            ? activeVenues.filter((venue) => typeof venue.buildBatchCalls === "function" && typeof venue.parseBatchResult === "function")
            : [];
        const directVenues = activeVenues.filter((venue) => !batchableVenues.includes(venue));

        if (batchableVenues.length) {
            const builtCalls = [];
            for (const venue of batchableVenues) {
                const calls = venue.buildBatchCalls(tokenIn, tokenOut, amountInRaw);
                for (const call of calls) {
                    builtCalls.push({ venue, meta: call.meta, target: call.target, callData: call.callData });
                }
            }

            try {
                const overrides = options.blockTag ? { blockTag: options.blockTag } : {};
                const results = await multicall.tryAggregate(
                    false,
                    builtCalls.map((call) => ({ target: call.target, callData: call.callData })),
                    overrides
                );

                for (let index = 0; index < results.length; index += 1) {
                    const row = results[index];
                    const call = builtCalls[index];
                    if (!row || !row.success || !row.returnData || row.returnData === "0x") continue;
                    try {
                        directQuotes.push(call.venue.parseBatchResult(call.meta, row.returnData));
                    } catch (_) {
                        // Ignore individual decode errors and continue scanning.
                    }
                }
            } catch (_) {
                const fallbackResults = await Promise.all(
                    batchableVenues.map((venue) => venue.quoteExactIn(tokenIn, tokenOut, amountInRaw, options))
                );
                directQuotes.push(...fallbackResults.flat());
            }
        }

        if (directVenues.length) {
            const results = await Promise.all(directVenues.map((venue) => venue.quoteExactIn(tokenIn, tokenOut, amountInRaw, options)));
            directQuotes.push(...results.flat());
        }

        return directQuotes;
    }

    async function getEthUsdPrice(options = {}) {
        const weth = universe.assetsBySymbol.WETH;
        const stableSymbols = ["USDC", "USDT", "DAI"].filter((symbol) => universe.assetsBySymbol[symbol]);
        let bestPrice = null;

        const wethProbeRaw = parseUnits("0.1", weth.decimals);
        for (const stableSymbol of stableSymbols) {
            const stable = universe.assetsBySymbol[stableSymbol];
            const quotes = await quoteAcrossVenues(weth, stable, wethProbeRaw, options);
            for (const quote of quotes) {
                const stableOut = formatUnits(quote.amountOutRaw, stable.decimals);
                const price = stableOut / 0.1;
                if (Number.isFinite(price) && price > 0 && (!bestPrice || price > bestPrice)) {
                    bestPrice = price;
                }
            }
        }

        if (bestPrice) return bestPrice;

        for (const stableSymbol of stableSymbols) {
            const stable = universe.assetsBySymbol[stableSymbol];
            const stableProbeRaw = parseUnits("1000", stable.decimals);
            const quotes = await quoteAcrossVenues(stable, weth, stableProbeRaw, options);
            for (const quote of quotes) {
                const wethOut = formatUnits(quote.amountOutRaw, weth.decimals);
                const price = wethOut > 0 ? 1000 / wethOut : null;
                if (Number.isFinite(price) && price > 0 && (!bestPrice || price > bestPrice)) {
                    bestPrice = price;
                }
            }
        }

        return bestPrice || 3000;
    }

    function getBaseUsdPrice(baseSymbol, ethUsd) {
        if (baseSymbol === "WETH") return ethUsd;
        if (baseSymbol === "USDC" || baseSymbol === "USDT" || baseSymbol === "DAI") return 1;
        return null;
    }

    async function scanOnce(options = {}) {
        const historical = options.blockTag !== undefined && options.blockTag !== null;
        const block = options.block || (historical ? await provider.getBlock(options.blockTag) : null);
        const includeBalancer = options.includeBalancer !== undefined ? options.includeBalancer : !historical;

        const gasPriceWei = options.gasPriceWeiOverride
            || (historical && block && block.baseFeePerGas
                ? block.baseFeePerGas.add(ethers.utils.parseUnits(String(config.backtestPriorityFeeGwei), "gwei"))
                : null)
            || ((await provider.getFeeData()).maxFeePerGas)
            || ((await provider.getFeeData()).gasPrice)
            || ethers.utils.parseUnits(String(config.defaultGasGwei), "gwei");
        const ethUsd = await getEthUsdPrice({ ...options, includeBalancer });
        const bufferedGasUnits = Math.ceil(config.estimatedGasUnits * (10000 + config.gasBufferBps) / 10000);
        const gasCostUsd = Number(ethers.utils.formatEther(gasPriceWei.mul(bufferedGasUnits))) * ethUsd;
        const profitableCandidates = [];
        let bestObservedCandidate = null;
        let evaluatedRoutes = 0;

        for (const baseAsset of universe.baseAssets) {
            const amountInRaw = parseUnits(baseAsset.tradeSize, baseAsset.decimals);
            const baseUsdPrice = getBaseUsdPrice(baseAsset.symbol, ethUsd);
            if (!baseUsdPrice) continue;

            for (const midAsset of universe.scanAssets) {
                if (midAsset.symbol === baseAsset.symbol) continue;

                const firstLegQuotes = await quoteAcrossVenues(baseAsset, midAsset, amountInRaw, { ...options, includeBalancer });
                for (const firstQuote of firstLegQuotes) {
                    const secondLegQuotes = await quoteAcrossVenues(midAsset, baseAsset, firstQuote.amountOutRaw, { ...options, includeBalancer });
                    for (const secondQuote of secondLegQuotes) {
                        if (secondQuote.venue === firstQuote.venue) continue;

                        evaluatedRoutes += 1;
                        const grossProfitRaw = secondQuote.amountOutRaw.sub(amountInRaw);
                        const grossProfitBase = formatUnits(grossProfitRaw, baseAsset.decimals);
                        const grossProfitUsd = grossProfitBase * baseUsdPrice;
                        const netProfitUsd = grossProfitUsd - gasCostUsd;
                        const spreadBps = computeSpreadBps(amountInRaw, secondQuote.amountOutRaw, baseAsset.decimals);

                        const candidate = {
                            timestamp: options.timestampOverride || (block ? block.timestamp * 1000 : Date.now()),
                            blockNumber: block ? block.number : null,
                            baseSymbol: baseAsset.symbol,
                            baseAddress: baseAsset.address,
                            midSymbol: midAsset.symbol,
                            midAddress: midAsset.address,
                            inputAmount: baseAsset.tradeSize,
                            inputAmountRaw: amountInRaw.toString(),
                            grossProfitBase,
                            grossProfitUsd,
                            netProfitUsd,
                            spreadBps,
                            gasCostUsd,
                            firstVenue: firstQuote.routeId,
                            secondVenue: secondQuote.routeId,
                            firstVenueName: firstQuote.venue,
                            secondVenueName: secondQuote.venue,
                            firstRouter: firstQuote.routerAddress || null,
                            secondRouter: secondQuote.routerAddress || null,
                            firstFee: firstQuote.fee || 0,
                            secondFee: secondQuote.fee || 0,
                            firstAmountOut: formatUnits(firstQuote.amountOutRaw, midAsset.decimals),
                            secondAmountOut: formatUnits(secondQuote.amountOutRaw, baseAsset.decimals),
                            firstAmountOutRaw: firstQuote.amountOutRaw.toString(),
                            secondAmountOutRaw: secondQuote.amountOutRaw.toString(),
                            capturable: Boolean(firstQuote.routerAddress && secondQuote.routerAddress)
                        };

                        if (!bestObservedCandidate || candidate.netProfitUsd > bestObservedCandidate.netProfitUsd) {
                            bestObservedCandidate = candidate;
                        }

                        if (candidate.netProfitUsd >= config.minNetProfitUsd) {
                            profitableCandidates.push(candidate);
                        }
                    }
                }
            }
        }

        profitableCandidates.sort((left, right) => right.netProfitUsd - left.netProfitUsd);

        return {
            timestamp: options.timestampOverride || (block ? block.timestamp * 1000 : Date.now()),
            chain: config.chain,
            blockNumber: block ? block.number : null,
            historical,
            balancerIncluded: includeBalancer && !historical,
            gasPriceGwei: Number(ethers.utils.formatUnits(gasPriceWei, "gwei")),
            ethUsd,
            gasCostUsd,
            gasUnits: bufferedGasUnits,
            evaluatedRoutes,
            profitableCandidates,
            bestObservedCandidate
        };
    }

    return {
        provider,
        quoteAcrossVenues,
        scanOnce,
        universe,
        estimateBufferedGasUnits: () => addBpsMargin(ethers.BigNumber.from(config.estimatedGasUnits), config.gasBufferBps)
    };
}

module.exports = {
    createScanner
};
