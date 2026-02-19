require("dotenv").config();
require("@nomiclabs/hardhat-ethers");

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
      url: process.env.ALCHEMY_URL,
      accounts: [process.env.PRIVATE_KEY].filter(Boolean)
    },

    sepolia: {
      url: process.env.ALCHEMY_URL_SEPOLIA,
      accounts: [process.env.PRIVATE_KEY].filter(Boolean)
    },

    polygon: {
      url: process.env.POLYGON_RPC,
      accounts: [process.env.PRIVATE_KEY].filter(Boolean)
    }
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY  // optional for verifying
  }
};
