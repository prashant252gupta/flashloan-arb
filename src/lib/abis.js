const { ethers } = require("ethers");

const uniswapQuoterAbi = [
    "function quoteExactInputSingle(address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96) returns (uint256 amountOut)"
];

const pancakeQuoterV2Abi = [
    "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"
];

const multicall2Abi = [
    "function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)"
];

function parseUnits(amount, decimals) {
    return ethers.utils.parseUnits(String(amount), decimals);
}

function formatUnits(amount, decimals) {
    return Number(ethers.utils.formatUnits(amount, decimals));
}

module.exports = {
    formatUnits,
    multicall2Abi,
    pancakeQuoterV2Abi,
    parseUnits,
    uniswapQuoterAbi
};
