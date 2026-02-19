async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying with:", deployer.address);

    const providerAddress = process.env.POOL_ADDRESSES_PROVIDER;
    if (!providerAddress) throw new Error("Missing POOL_ADDRESSES_PROVIDER in .env");

    const Arb = await ethers.getContractFactory("ArbExecutor");
    const arb = await Arb.deploy(
        providerAddress,
        "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", // Uniswap V2
        "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F", // SushiSwap V2
        "0xE592427A0AEce92De3Edee1F18E0157C05861564"  // Uniswap V3 SwapRouter
    );
    await arb.deployed();

    console.log("✅ ArbExecutor deployed to:", arb.address);
}
main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error(err);
        process.exit(1);
    });
