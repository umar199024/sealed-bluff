import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  console.log(`Network:  ${hre.network.name} (chainId ${hre.network.config.chainId})`);
  console.log(`Deployer: ${deployer}`);
  const balance = await hre.ethers.provider.getBalance(deployer);
  console.log(`Balance:  ${hre.ethers.formatEther(balance)} ETH`);

  const deployed = await deploy("SealedBluff", {
    from: deployer,
    log: true,
    waitConfirmations: hre.network.name === "sepolia" ? 2 : 1,
  });

  console.log("");
  console.log("==============================================================");
  console.log(`  SealedBluff deployed at: ${deployed.address}`);
  console.log("  Copy this address into frontend/src/config.js");
  console.log("  (or the VITE_CONTRACT_ADDRESS env var on Vercel).");
  if (hre.network.name === "sepolia") {
    console.log(`  Etherscan: https://sepolia.etherscan.io/address/${deployed.address}`);
  }
  console.log("==============================================================");
};
export default func;
func.id = "deploy_sealedBluff"; // id required to prevent reexecution
func.tags = ["SealedBluff"];
