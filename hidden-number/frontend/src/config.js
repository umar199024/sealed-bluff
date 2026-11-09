// ============================================================================
//  Hidden Number — frontend configuration
// ============================================================================
//  After you deploy the contract, paste its address below (between the quotes).
//  Alternatively set the VITE_CONTRACT_ADDRESS environment variable (e.g. on Vercel);
//  the environment variable wins if both are set.
// ============================================================================

export const CONTRACT_ADDRESS_FALLBACK = "0xYOUR_CONTRACT_ADDRESS_HERE";

export const CONTRACT_ADDRESS = (import.meta.env.VITE_CONTRACT_ADDRESS || CONTRACT_ADDRESS_FALLBACK).trim();

// Sepolia testnet
export const CHAIN_ID = 11155111;
export const CHAIN_ID_HEX = "0xaa36a7";
export const CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: "Sepolia",
  nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
  blockExplorerUrls: ["https://sepolia.etherscan.io"],
};
export const EXPLORER = "https://sepolia.etherscan.io";

// Game rules (must match the contract)
export const MAX_ATTEMPTS = 7;
export const MAX_NUMBER = 64;

// How often the game state is refreshed (ms)
export const POLL_MS = 5000;
