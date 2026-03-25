// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IV3SwapRouterLike {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

contract CycleArbExecutor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    mapping(address => bool) public trustedRouter;

    event TwoLegSwapExecuted(
        address indexed tokenIn,
        address indexed middleToken,
        address indexed firstRouter,
        address secondRouter,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(address[] memory routers) Ownable(msg.sender) {
        for (uint256 index = 0; index < routers.length; index += 1) {
            address router = routers[index];
            require(router != address(0), "zero router");
            trustedRouter[router] = true;
        }
    }

    function setTrustedRouter(address router, bool allowed) external onlyOwner {
        require(router != address(0), "zero router");
        trustedRouter[router] = allowed;
    }

    function executeTwoLegSwap(
        address routerA,
        address routerB,
        address tokenIn,
        address middleToken,
        uint24 feeA,
        uint24 feeB,
        uint256 amountIn,
        uint256 minOutFirst,
        uint256 minOutSecond
    ) external onlyOwner nonReentrant returns (uint256 finalAmount) {
        require(trustedRouter[routerA] && trustedRouter[routerB], "untrusted router");
        require(tokenIn != address(0) && middleToken != address(0), "zero token");
        require(tokenIn != middleToken, "same token");
        require(amountIn > 0, "zero amount");
        require(IERC20(tokenIn).balanceOf(address(this)) >= amountIn, "insufficient balance");

        _approveExact(IERC20(tokenIn), routerA, amountIn);
        uint256 firstOut = IV3SwapRouterLike(routerA).exactInputSingle(
            IV3SwapRouterLike.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: middleToken,
                fee: feeA,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: minOutFirst,
                sqrtPriceLimitX96: 0
            })
        );

        _approveExact(IERC20(middleToken), routerB, firstOut);
        finalAmount = IV3SwapRouterLike(routerB).exactInputSingle(
            IV3SwapRouterLike.ExactInputSingleParams({
                tokenIn: middleToken,
                tokenOut: tokenIn,
                fee: feeB,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: firstOut,
                amountOutMinimum: minOutSecond,
                sqrtPriceLimitX96: 0
            })
        );

        require(finalAmount > amountIn, "unprofitable cycle");
        emit TwoLegSwapExecuted(tokenIn, middleToken, routerA, routerB, amountIn, finalAmount);
    }

    function sweep(address token, address to) external onlyOwner {
        require(to != address(0), "zero recipient");
        IERC20 erc20 = IERC20(token);
        uint256 balance = erc20.balanceOf(address(this));
        require(balance > 0, "no balance");
        erc20.safeTransfer(to, balance);
    }

    function _approveExact(IERC20 token, address spender, uint256 amount) internal {
        token.forceApprove(spender, 0);
        token.forceApprove(spender, amount);
    }
}
