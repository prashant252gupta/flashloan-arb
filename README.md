# Cross-DEX Arbitrage Scanner

This repo is currently focused on Ethereum mainnet cross-DEX cycle scans across Uniswap, PancakeSwap, and Balancer.

## What it does

- Scans `base -> mid -> base` routes across the configured asset universe.
- Uses Multicall2 batching for Uniswap and Pancake quoter requests.
- Supports sampled historical replay with block-tagged quotes for Uniswap and Pancake.
- Keeps Balancer live-only because the current Balancer pathing is sourced from the live SOR API.
- Can dry-run or submit private-orderflow bundles for capturable Uniswap/Pancake routes through Flashbots-compatible relays.

## Main files

- `bot.js`: live loop entrypoint
- `worker.js`: scanner engine and historical replay support
- `src/index.js`: runtime loop and private execution hook
- `src/execution/privateOrderflow.js`: Flashbots bundle simulation/submission
- `contracts/CycleArbExecutor.sol`: prefunded two-leg V3 executor for private bundles
- `scripts/backtest_arb_2months.js`: sampled two-month profitability replay
- `scripts/private_dryrun.js`: one-shot private-orderflow dry run

## Commands

```bash
npm run scan:arb
npm run backtest:arb
npm run private:dryrun
npm run compile
npm run deploy:cycle-executor
```

## Important limits

- The two-month replay is a sampled opportunity scan, not realized PnL.
- Historical replay currently excludes Balancer.
- The private execution path currently supports only capturable two-leg Uniswap/Pancake V3-style routes.
- The executor contract is prefunded, not flashloan-based.

## Required env vars for execution

- `ARB_RPC_URL` or `RPC_URL`
- `ARB_ENABLE_PRIVATE_EXECUTION=1`
- `ARB_PRIVATE_EXECUTION_DRY_RUN=1` for simulation-only mode
- `ARB_PRIVATE_KEY`
- `ARB_FLASHBOTS_AUTH_KEY` recommended
- `ARB_CONTRACT_ADDRESS`
- `ARB_RELAY_URLS`

## Security note

If your `.env` contains a raw funded private key, rotate it before any live relay submission or contract deployment.
