require("dotenv").config();

async function main() {
    const [deployer] = await ethers.getSigners();
    const routers = [
        process.env.ARB_UNISWAP_ROUTER || "0x68b3465833FB72A70ecDF485E0e4C7bD8665Fc45",
        process.env.ARB_PANCAKE_ROUTER || "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4"
    ].map((value) => value.toLowerCase());

    const Factory = await ethers.getContractFactory("CycleArbExecutor");
    const contract = await Factory.deploy(routers);
    await contract.deployed();

    console.log(JSON.stringify({
        deployer: deployer.address,
        contract: contract.address,
        routers
    }, null, 2));
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
