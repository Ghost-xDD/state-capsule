import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(__dirname, "../../.env"), override: true });

const PRIVATE_KEY = process.env["OG_PRIVATE_KEY"] ?? "0x" + "ac".repeat(32);

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {},
    zerog: {
      url: process.env["OG_EVM_RPC"] ?? "https://evmrpc-testnet.0g.ai",
      accounts: [PRIVATE_KEY],
      chainId: 16600,
    },
  },
  paths: {
    sources:   "./src",
    tests:     "./test",
    cache:     "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
