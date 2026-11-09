// Thin wrapper around the Zama Relayer SDK (@zama-fhe/relayer-sdk).
//  - user decryption: a player decrypts ONLY their own dice (needs an EIP-712 signature)
//  - public decryption: anyone decrypts the publicly-decryptable verdict and gets a KMS proof
import { initSDK, createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/bundle";

let instancePromise = null;

export function getFhevm() {
  if (!instancePromise) {
    instancePromise = (async () => {
      if (!window.relayerSDK) throw new Error("Zama Relayer SDK failed to load from the CDN (check your connection).");
      await initSDK(); // loads the TFHE + KMS WASM
      return createInstance({ ...SepoliaConfig, network: window.ethereum });
    })().catch((e) => {
      instancePromise = null;
      throw e;
    });
  }
  return instancePromise;
}

const DURATION_DAYS = 7;

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
      if (onRetry) onRetry(i + 1, e);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

function permitKey(user, contract) {
  return `sealedbluff:permit:${user.toLowerCase()}:${contract.toLowerCase()}`;
}

/** Returns a cached (keypair + signature) user-decryption permit, or asks the wallet to sign one. */
async function getPermit(instance, signer, contractAddress) {
  const user = await signer.getAddress();
  const key = permitKey(user, contractAddress);
  try {
    const cached = JSON.parse(localStorage.getItem(key) || "null");
    const now = Math.floor(Date.now() / 1000);
    if (cached && Number(cached.startTimestamp) + DURATION_DAYS * 86400 - 3600 > now) return cached;
  } catch {
    /* ignore */
  }
  const keypair = instance.generateKeypair();
  const startTimestamp = Math.floor(Date.now() / 1000);
  const contractAddresses = [contractAddress];
  const eip712 = instance.createEIP712(keypair.publicKey, contractAddresses, startTimestamp, DURATION_DAYS);
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
  localStorage.setItem(key, JSON.stringify(permit));
  return permit;
}

/** Decrypts the caller's own dice handles. Returns numbers 1..6 in the same order. */
export async function decryptMyDice(signer, contractAddress, handles) {
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
    localStorage.removeItem(permitKey(user, contractAddress)); // retry with a fresh permit next time
    throw e;
  }
  return handles.map((h) => Number(pick(result, h)));
}

/** Public decryption of the verdict. Returns { bidWasTrue, proof } ready for resolveChallenge(). */
export async function decryptVerdict(handle) {
  const instance = await getFhevm();
  const res = await instance.publicDecrypt([handle]);
  const v = pick(res.clearValues, handle);
  return { bidWasTrue: v === true || v === 1n || v === "true", proof: res.decryptionProof };
}
