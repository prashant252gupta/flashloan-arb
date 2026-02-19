// contracts/ArbExecutor.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";

interface ISwapRouterV3 {
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

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut);
}

contract ArbExecutor is FlashLoanSimpleReceiverBase, ReentrancyGuard {
    using SafeERC20 for IERC20;

    event FlashLoanExecuted(
        address indexed asset,
        uint256 amount,
        uint256 premium,
        uint256 profit
    );

    address public immutable owner;
    IUniswapV2Router02 public immutable UNI_ROUTER;
    IUniswapV2Router02 public immutable SUSHI_ROUTER;
    ISwapRouterV3 public immutable UNI_V3_ROUTER;
    mapping(address => bool) public trustedV2Router;

    constructor(
        IPoolAddressesProvider provider,
        address _uniRouter,
        address _sushiRouter,
        address _uniV3Router
    ) FlashLoanSimpleReceiverBase(provider) {
        owner = msg.sender;
        UNI_ROUTER = IUniswapV2Router02(_uniRouter);
        SUSHI_ROUTER = IUniswapV2Router02(_sushiRouter);
        UNI_V3_ROUTER = ISwapRouterV3(_uniV3Router);
        trustedV2Router[_uniRouter] = true;
        trustedV2Router[_sushiRouter] = true;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    function setTrustedV2Router(address router, bool allowed) external onlyOwner {
        require(router != address(0), "Zero router");
        trustedV2Router[router] = allowed;
    }

    function _validateCyclePaths(
        address asset,
        address[] memory pathUni,
        address[] memory pathSushi,
        bool uniFirst
    ) internal pure {
        if (uniFirst) {
            require(pathUni[0] == asset, "Asset/path mismatch");
            require(pathUni[pathUni.length - 1] == pathSushi[0], "Disconnected paths");
            require(pathSushi[pathSushi.length - 1] == asset, "Return asset mismatch");
        } else {
            require(pathSushi[0] == asset, "Asset/path mismatch");
            require(pathSushi[pathSushi.length - 1] == pathUni[0], "Disconnected paths");
            require(pathUni[pathUni.length - 1] == asset, "Return asset mismatch");
        }
    }

    function _swapV2(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin
    ) internal returns (uint256 amountOut) {
        require(trustedV2Router[router], "Router not trusted");
        IUniswapV2Router02 v2 = IUniswapV2Router02(router);
        IERC20(tokenIn).safeIncreaseAllowance(address(router), amountIn);
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        uint256[] memory out = v2.swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            address(this),
            block.timestamp
        );
        return out[out.length - 1];
    }

    function _swapV3(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOutMin
    ) internal returns (uint256 amountOut) {
        IERC20(tokenIn).safeIncreaseAllowance(address(UNI_V3_ROUTER), amountIn);
        ISwapRouterV3.ExactInputSingleParams memory p = ISwapRouterV3
            .ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: 0
            });
        return UNI_V3_ROUTER.exactInputSingle(p);
    }

    /// @notice Start a flash-loan for `amount` of WETH, then execute two-path swaps
    /// @param amount       loan size in WETH
    /// @param pathUni      Uniswap V2 path, e.g. [WETH, USDC, DAI]
    /// @param pathSushi    SushiSwap V2 path, reverse, e.g. [DAI, USDC, WETH]
    /// @param minOutUni    minimum out for Uniswap swap
    /// @param minOutSushi  minimum out for SushiSwap swap
    /// @param uniFirst     true: Uni then Sushi, false: Sushi then Uni
    function executeFlashLoan(
        uint256 amount,
        address[] calldata pathUni,
        address[] calldata pathSushi,
        uint256 minOutUni,
        uint256 minOutSushi,
        bool uniFirst
    ) external onlyOwner {
        require(amount > 0, "Zero amount");
        require(pathUni.length >= 2 && pathSushi.length >= 2, "Invalid path");
        address asset = uniFirst ? pathUni[0] : pathSushi[0];
        _validateCyclePaths(asset, pathUni, pathSushi, uniFirst);
        POOL.flashLoanSimple(
            address(this),
            asset,
            amount,
            abi.encode(pathUni, pathSushi, minOutUni, minOutSushi, uniFirst),
            0
        );
    }

    /// @notice Flexible two-leg flash-loan arb with V2/V3 mix.
    /// @param amount           loan size
    /// @param asset            asset borrowed from Aave and returned at end
    /// @param middleToken      bridge token for 2-leg cycle
    /// @param firstDex         0=UniV2, 1=SushiV2, 2=UniV3
    /// @param secondDex        0=UniV2, 1=SushiV2, 2=UniV3
    /// @param firstV2Router    router for first leg when firstDex != 2
    /// @param secondV2Router   router for second leg when secondDex != 2
    /// @param firstFee         UniV3 fee for first leg (ignored for V2)
    /// @param secondFee        UniV3 fee for second leg (ignored for V2)
    /// @param minOutFirst      slippage protection for first leg
    /// @param minOutSecond     slippage protection for second leg
    function executeFlashLoanFlexible(
        uint256 amount,
        address asset,
        address middleToken,
        uint8 firstDex,
        uint8 secondDex,
        address firstV2Router,
        address secondV2Router,
        uint24 firstFee,
        uint24 secondFee,
        uint256 minOutFirst,
        uint256 minOutSecond
    ) external onlyOwner {
        require(amount > 0, "Zero amount");
        require(asset != address(0) && middleToken != address(0), "Zero addr");
        require(asset != middleToken, "Same token");
        require(firstDex <= 2 && secondDex <= 2, "Bad dex");

        POOL.flashLoanSimple(
            address(this),
            asset,
            amount,
            abi.encode(
                uint8(1),
                middleToken,
                firstDex,
                secondDex,
                firstV2Router,
                secondV2Router,
                firstFee,
                secondFee,
                minOutFirst,
                minOutSecond
            ),
            0
        );
    }

    /// @dev Aave callback: perform multi-hop swaps and repay
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address /* initiator */,
        bytes calldata params
    ) external override nonReentrant returns (bool) {
        require(msg.sender == address(POOL), "Only pool");

        uint256 marker;
        assembly {
            marker := calldataload(params.offset)
        }

        uint256 finalAmt;
        if (marker == 1) {
            (
                ,
                address middleToken,
                uint8 firstDex,
                uint8 secondDex,
                address firstV2Router,
                address secondV2Router,
                uint24 firstFee,
                uint24 secondFee,
                uint256 minOutFirst,
                uint256 minOutSecond
            ) = abi.decode(
                    params,
                    (uint8, address, uint8, uint8, address, address, uint24, uint24, uint256, uint256)
                );

            uint256 midOut;
            if (firstDex == 0) {
                midOut = _swapV2(
                    firstV2Router,
                    asset,
                    middleToken,
                    amount,
                    minOutFirst
                );
            } else if (firstDex == 1) {
                midOut = _swapV2(
                    firstV2Router,
                    asset,
                    middleToken,
                    amount,
                    minOutFirst
                );
            } else {
                midOut = _swapV3(asset, middleToken, firstFee, amount, minOutFirst);
            }

            if (secondDex == 0) {
                finalAmt = _swapV2(
                    secondV2Router,
                    middleToken,
                    asset,
                    midOut,
                    minOutSecond
                );
            } else if (secondDex == 1) {
                finalAmt = _swapV2(
                    secondV2Router,
                    middleToken,
                    asset,
                    midOut,
                    minOutSecond
                );
            } else {
                finalAmt = _swapV3(
                    middleToken,
                    asset,
                    secondFee,
                    midOut,
                    minOutSecond
                );
            }
        } else {
            (
                address[] memory pathUni,
                address[] memory pathSushi,
                uint256 minOutUni,
                uint256 minOutSushi,
                bool uniFirst
            ) = abi.decode(params, (address[], address[], uint256, uint256, bool));
            _validateCyclePaths(asset, pathUni, pathSushi, uniFirst);

            if (uniFirst) {
                IERC20(asset).safeIncreaseAllowance(address(UNI_ROUTER), amount);
                uint256[] memory outUni = UNI_ROUTER.swapExactTokensForTokens(
                    amount,
                    minOutUni,
                    pathUni,
                    address(this),
                    block.timestamp
                );

                uint256 intermediate = outUni[outUni.length - 1];
                IERC20(pathSushi[0]).safeIncreaseAllowance(
                    address(SUSHI_ROUTER),
                    intermediate
                );
                uint256[] memory outSushi = SUSHI_ROUTER.swapExactTokensForTokens(
                    intermediate,
                    minOutSushi,
                    pathSushi,
                    address(this),
                    block.timestamp
                );
                finalAmt = outSushi[outSushi.length - 1];
            } else {
                IERC20(asset).safeIncreaseAllowance(address(SUSHI_ROUTER), amount);
                uint256[] memory outSushi = SUSHI_ROUTER.swapExactTokensForTokens(
                    amount,
                    minOutSushi,
                    pathSushi,
                    address(this),
                    block.timestamp
                );

                uint256 intermediate = outSushi[outSushi.length - 1];
                IERC20(pathUni[0]).safeIncreaseAllowance(
                    address(UNI_ROUTER),
                    intermediate
                );
                uint256[] memory outUni = UNI_ROUTER.swapExactTokensForTokens(
                    intermediate,
                    minOutUni,
                    pathUni,
                    address(this),
                    block.timestamp
                );
                finalAmt = outUni[outUni.length - 1];
            }
        }

        // 3) Check profit and repay
        uint256 totalOwing = amount + premium;
        require(finalAmt > totalOwing, "Unprofitable arb");

        // allow Aave to pull repayment
        IERC20(asset).safeIncreaseAllowance(address(POOL), totalOwing);

        emit FlashLoanExecuted(asset, amount, premium, finalAmt - totalOwing);
        return true;
    }

    /// @notice Withdraw any ERC20 profit
    function withdraw(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "No balance");
        IERC20(token).safeTransfer(owner, bal);
    }
}
