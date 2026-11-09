// Copies the compiled HiddenNumber ABI from the Hardhat artifacts into the frontend.
// Run from /frontend after `npx hardhat compile` in the project root:  npm run sync-abi
import fs from "node:fs";
const src = new URL("../../artifacts/contracts/HiddenNumber.sol/HiddenNumber.json", import.meta.url);
const dst = new URL("../src/abi.json", import.meta.url);
const { abi } = JSON.parse(fs.readFileSync(src, "utf8"));
fs.writeFileSync(dst, JSON.stringify(abi, null, 1));
console.log(`ABI synced (${abi.length} entries) -> src/abi.json`);
