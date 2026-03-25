const { FlashbotsBundleProvider } = require("@flashbots/ethers-provider-bundle");
const { ethers } = require("ethers");

const cycleExecutorAbi = [
    "function executeTwoLegSwap(address routerA,address routerB,address tokenIn,address middleToken,uint24 feeA,uint24 feeB,uint256 amountIn,uint256 minOutFirst,uint256 minOutSecond) external returns (uint256 finalAmount)"
];

function applySlippage(rawAmount, bps) {
    return ethers.BigNumber.from(rawAmount).mul(10000 - bps).div(10000);
}

function canPrivatelyExecuteCandidate(candidate) {
    return Boolean(
        candidate
        && candidate.capturable
        && candidate.firstRouter
        && candidate.secondRouter
        && candidate.firstVenueName !== "balancer"
        && candidate.secondVenueName !== "balancer"
    );
}

async function createPrivateExecutor(config, provider) {
    if (!config.privateExecution) {
        return null;
    }

    if (!config.privateKey || !config.contractAddress || !config.relayUrls.length) {
        return {
            enabled: false,
            reason: "missing private key, executor contract, or relay URL configuration"
        };
    }

    const wallet = new ethers.Wallet(config.privateKey, provider);
    const authSigner = config.flashbotsAuthKey
        ? new ethers.Wallet(config.flashbotsAuthKey)
        : ethers.Wallet.createRandom();
    const relayProviders = await Promise.all(
        config.relayUrls.map(async (url) => ({
            url,
            provider: await FlashbotsBundleProvider.create(provider, authSigner, url)
        }))
    );
    const network = await provider.getNetwork();
    const executor = new ethers.Contract(config.contractAddress, cycleExecutorAbi, wallet);

    async function buildTransaction(candidate) {
        const latestBlock = await provider.getBlock("latest");
        const priorityFee = ethers.utils.parseUnits(String(config.privateTipGwei), "gwei");
        const gasPriceCap = ethers.utils.parseUnits(String(config.maxBundleGasPriceGwei), "gwei");
        const baseFee = latestBlock.baseFeePerGas || await provider.getGasPrice();
        let maxFeePerGas = baseFee.mul(2).add(priorityFee);
        if (maxFeePerGas.gt(gasPriceCap)) {
            maxFeePerGas = gasPriceCap;
        }

        const minOutFirst = applySlippage(candidate.firstAmountOutRaw, config.executionSlippageBps);
        const minOutSecond = applySlippage(candidate.secondAmountOutRaw, config.executionSlippageBps);
        const transaction = await executor.populateTransaction.executeTwoLegSwap(
            candidate.firstRouter,
            candidate.secondRouter,
            candidate.baseAddress,
            candidate.midAddress,
            candidate.firstFee,
            candidate.secondFee,
            candidate.inputAmountRaw,
            minOutFirst,
            minOutSecond
        );

        transaction.chainId = network.chainId;
        transaction.type = 2;
        transaction.nonce = await wallet.getTransactionCount("latest");
        transaction.maxPriorityFeePerGas = priorityFee;
        transaction.maxFeePerGas = maxFeePerGas;

        try {
            const estimatedGas = await wallet.estimateGas(transaction);
            transaction.gasLimit = estimatedGas.mul(12000).div(10000);
        } catch (_) {
            transaction.gasLimit = ethers.BigNumber.from(config.bundleGasLimit);
        }

        return {
            currentBlock: latestBlock.number,
            minOutFirst,
            minOutSecond,
            transaction
        };
    }

    async function submitCandidate(candidate) {
        if (!canPrivatelyExecuteCandidate(candidate)) {
            return {
                skipped: true,
                reason: "candidate is not executable through the current private-orderflow path"
            };
        }

        const prepared = await buildTransaction(candidate);
        const targetBlocks = Array.from({ length: Math.max(1, config.bundleBlocks) }, (_, index) => prepared.currentBlock + 1 + index);
        const relayResults = [];

        for (const relay of relayProviders) {
            for (const targetBlock of targetBlocks) {
                try {
                    const signedBundle = await relay.provider.signBundle([
                        {
                            signer: wallet,
                            transaction: prepared.transaction
                        }
                    ]);
                    const simulation = await relay.provider.simulate(signedBundle, targetBlock);

                    if (config.privateExecutionDryRun) {
                        relayResults.push({
                            relay: relay.url,
                            targetBlock,
                            simulated: true,
                            simulation
                        });
                        continue;
                    }

                    if (simulation.error || simulation.firstRevert) {
                        relayResults.push({
                            relay: relay.url,
                            targetBlock,
                            simulated: true,
                            simulation
                        });
                        continue;
                    }

                    const submission = await relay.provider.sendRawBundle(signedBundle, targetBlock);
                    relayResults.push({
                        relay: relay.url,
                        targetBlock,
                        simulated: true,
                        submitted: true,
                        bundleTransactions: submission.bundleTransactions
                    });
                } catch (error) {
                    relayResults.push({
                        relay: relay.url,
                        targetBlock,
                        error: error.message
                    });
                }
            }
        }

        return {
            dryRun: config.privateExecutionDryRun,
            minOutFirstRaw: prepared.minOutFirst.toString(),
            minOutSecondRaw: prepared.minOutSecond.toString(),
            relayResults
        };
    }

    return {
        enabled: true,
        walletAddress: wallet.address,
        canExecuteCandidate: canPrivatelyExecuteCandidate,
        submitCandidate
    };
}

module.exports = {
    canPrivatelyExecuteCandidate,
    createPrivateExecutor
};
