// Thin wrapper around the Zama Relayer SDK (@zama-fhe/relayer-sdk).
// User decryption: only the player can decrypt their own hints / won flag / revealed secret.
// The decryption permit (keypair + EIP-712 signature) is cached for the browser session,
// so the player signs ONCE per session, not once per hint.
import { initSDK, createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/bundle";
import { getEth } from "./wallet.js";

let instancePromise = null;

export function getFhevm() {
  if (!instancePromise) {
    instancePromise = (async () => {
      if (!window.relayerSDK) throw new Error("Zama Relayer SDK failed to load from the CDN (check your connection).");
      await initSDK(); // loads the TFHE + KMS WASM
      return createInstance({ ...SepoliaConfig, network: getEth() || "https://ethereum-sepolia-rpc.publicnode.com" });
    })().catch((e) => {
      instancePromise = null;
      throw e;
    });
  }
  return instancePromise;
}

const DURATION_DAYS = 1;
const memoryPermits = new Map();

function pick(map, handle) {
  if (handle in map) return map[handle];
  const k = Object.keys(map).find((x) => x.toLowerCase() === handle.toLowerCase());
  return k === undefined ? undefined : map[k];
}

/** Retries `fn` while the coprocessor is still computing a fresh ciphertext. */
export async function withRetry(fn, { tries = 12, delayMs = 5000, onRetry } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      // Never retry a signature the user rejected.
      if (e?.code === "ACTION_REJECTED" || e?.code === 4001) throw e;
      if (onRetry) onRetry(i + 1, e);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

function permitKey(user, contract) {
  return `hiddennumber:permit:${user.toLowerCase()}:${contract.toLowerCase()}`;
}

/** Returns the session's cached permit, or asks the wallet to sign one (once per browser session). */
async function getPermit(instance, signer, contractAddress) {
  const user = await signer.getAddress();
  const key = permitKey(user, contractAddress);
  const now = Math.floor(Date.now() / 1000);
  const valid = (p) => p && Number(p.startTimestamp) + DURATION_DAYS * 86400 - 600 > now;

  if (valid(memoryPermits.get(key))) return memoryPermits.get(key);
  try {
    const cached = JSON.parse(sessionStorage.getItem(key) || "null");
    if (valid(cached)) {
      memoryPermits.set(key, cached);
      return cached;
    }
  } catch {
    /* ignore */
  }

  const keypair = instance.generateKeypair();
  const startTimestamp = now;
  const eip712 = instance.createEIP712(keypair.publicKey, [contractAddress], startTimestamp, DURATION_DAYS);
  const signature = await signer.signTypedData(
    eip712.domain,
    { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification },
    eip712.message,
  );
  const permit = {
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    signature: signature.replace("0x", ""),
    startTimestamp,
    durationDays: DURATION_DAYS,
  };
  memoryPermits.set(key, permit);
  try {
    sessionStorage.setItem(key, JSON.stringify(permit));
  } catch {
    /* ignore */
  }
  return permit;
}

export function hasSessionPermit(user, contractAddress) {
  if (!user) return false;
  const key = permitKey(user, contractAddress);
  if (memoryPermits.has(key)) return true;
  try {
    return !!sessionStorage.getItem(key);
  } catch {
    return false;
  }
}

/**
 * User-decrypts a batch of the caller's own handles in ONE relayer request.
 * Returns a { handle -> value } map (euint8 -> number, ebool -> boolean).
 */
export async function userDecrypt(signer, contractAddress, handles) {
  const instance = await getFhevm();
  const user = await signer.getAddress();
  const permit = await getPermit(instance, signer, contractAddress);
  const pairs = handles.map((handle) => ({ handle, contractAddress }));
  let result;
  try {
    result = await instance.userDecrypt(
      pairs,
      permit.privateKey,
      permit.publicKey,
      permit.signature,
      [contractAddress],
      user,
      permit.startTimestamp,
      permit.durationDays,
    );
  } catch (e) {
    // Keep the permit (the usual cause is a ciphertext that is not ready yet); it is session-scoped anyway.
    throw e;
  }
  const out = {};
  for (const h of handles) {
    const v = pick(result, h);
    out[h.toLowerCase()] = typeof v === "boolean" ? v : v === undefined ? undefined : Number(v);
  }
  return out;
}

export function forgetPermit(user, contractAddress) {
  const key = permitKey(user, contractAddress);
  memoryPermits.delete(key);
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
