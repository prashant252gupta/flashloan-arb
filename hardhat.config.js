require("dotenv").config();
require("@nomiclabs/hardhat-ethers");

const mainnetUrl = process.env.ARB_RPC_URL || process.env.RPC_URL || process.env.ALCHEMY_URL;
const sepoliaUrl = process.env.ALCHEMY_URL_SEPOLIA || "";
const polygonUrl = process.env.POLYGON_RPC || "";
const deployerKey = process.env.ARB_PRIVATE_KEY || process.env.PRIVATE_KEY;

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true
    }
  },
  networks: {
    hardhat: {},
    mainnet: {
      url: mainnetUrl,
      accounts: [deployerKey].filter(Boolean)
    },
    sepolia: {
      url: sepoliaUrl,
      accounts: [deployerKey].filter(Boolean)
    },
    polygon: {
      url: polygonUrl,
      accounts: [deployerKey].filter(Boolean)
    }
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY
  }
};
