import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";

/**
 * Examples
 *   npx hardhat --network sepolia sealed:address
 *   npx hardhat --network sepolia sealed:table --id 1
 */
task("sealed:address", "Prints the deployed SealedBluff address").setAction(async function (_args: TaskArguments, hre) {
  const d = await hre.deployments.get("SealedBluff");
  console.log(`SealedBluff address is ${d.address}`);
});

task("sealed:table", "Prints the public state of a table")
  .addParam("id", "Table id")
  .addOptionalParam("address", "Optionally specify the SealedBluff contract address")
  .setAction(async function (args: TaskArguments, hre) {
    const d = args.address ? { address: args.address } : await hre.deployments.get("SealedBluff");
    const c = await hre.ethers.getContractAt("SealedBluff", d.address);
    const phases = ["Lobby", "Rolling", "Bidding", "AwaitingReveal", "Finished"];
    const t = await c.getTable(args.id);
    const [players, counts] = await c.getPlayers(args.id);
    console.log(`Table ${args.id} @ ${d.address}`);
    console.log(`  phase=${phases[Number(t.phase)]} round=${t.round} totalDice=${t.totalDice} onesWild=${t.onesWild}`);
    console.log(`  bid=${t.bidQty} x ${t.bidFace} by ${t.lastBidder}`);
    players.forEach((p: string, i: number) => console.log(`  seat ${i}: ${p} dice=${counts[i]}`));
    if (Number(t.phase) === 4) console.log(`  winner=${t.winner}`);
    const history = await c.getHistory(args.id);
    for (const h of history) {
      console.log(
        `  round ${h.round}: ${h.timeout ? "TIMEOUT" : `bid ${h.bidQty}x${h.bidFace} was ${h.bidWasTrue ? "TRUE" : "a BLUFF"}`} -> ${h.loser} loses a die (${h.loserDiceLeft} left)`,
      );
    }
  });

/**
 * Independently verify (and optionally apply) the verdict of the current "Liar!" call.
 *   npx hardhat --network sepolia sealed:verdict --id 1
 *   npx hardhat --network sepolia sealed:verdict --id 1 --resolve true
 * Uses the Zama relayer's public decryption: prints the clear verdict + KMS decryption proof.
 */
task("sealed:verdict", "Public-decrypts the verdict of a pending Liar! call")
  .addParam("id", "Table id")
  .addOptionalParam("address", "Optionally specify the SealedBluff contract address")
  .addOptionalParam("resolve", "Also submit resolveChallenge (true/false)", "false")
  .setAction(async function (args: TaskArguments, hre) {
    await hre.fhevm.initializeCLIApi();
    const d = args.address ? { address: args.address } : await hre.deployments.get("SealedBluff");
    const c = await hre.ethers.getContractAt("SealedBluff", d.address);
    const t = await c.getTable(args.id);
    if (Number(t.phase) !== 3) {
      console.log("No pending verdict (table is not in AwaitingReveal).");
      return;
    }
    const handle = t.verdictHandle;
    const res = await hre.fhevm.publicDecrypt([handle]);
    const verdict = res.clearValues[handle as `0x${string}`] as boolean;
    console.log(`Bid ${t.bidQty} x ${t.bidFace} by ${t.lastBidder}`);
    console.log(`Verdict handle : ${handle}`);
    console.log(
      `Clear verdict  : bid was ${verdict ? "TRUE (challenger loses a die)" : "a BLUFF (bidder loses a die)"}`,
    );
    console.log(`Decryption proof: ${res.decryptionProof}`);
    if (args.resolve === "true") {
      const [signer] = await hre.ethers.getSigners();
      const tx = await c.connect(signer).resolveChallenge(args.id, verdict, res.decryptionProof);
      console.log(`resolveChallenge tx: ${tx.hash}`);
      await tx.wait();
      console.log("Resolved ✔");
    }
  });
