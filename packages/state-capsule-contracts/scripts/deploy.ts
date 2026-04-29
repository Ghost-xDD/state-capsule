import { ethers, network } from "hardhat";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer signer available");

  console.log(`[deploy] Network    : ${network.name}`);
  console.log(`[deploy] Deployer   : ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`[deploy] Balance    : ${ethers.formatEther(balance)} ETH`);

  const Factory  = await ethers.getContractFactory("CapsuleRegistry");
  const registry = await Factory.deploy();
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  console.log(`[deploy] CapsuleRegistry deployed → ${address}`);

  // Write address into SDK deployments.json
  const deploymentsPath = resolve(
    __dirname,
    "../../state-capsule-sdk/deployments.json"
  );

  let deployments: Record<string, Record<string, string>> = {};
  if (existsSync(deploymentsPath)) {
    deployments = JSON.parse(readFileSync(deploymentsPath, "utf-8")) as Record<string, Record<string, string>>;
  }

  deployments[network.name] = {
    ...(deployments[network.name] ?? {}),
    CapsuleRegistry: address,
  };

  writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2) + "\n");
  console.log(`[deploy] deployments.json updated → ${deploymentsPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
