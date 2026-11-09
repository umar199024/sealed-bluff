// Multi-wallet support via EIP-6963 (MetaMask, Rabby, Coinbase Wallet, OKX, Brave, Trust, ...).
// Falls back to window.ethereum for wallets that do not announce themselves.
const wallets = new Map(); // rdns -> { info, provider }
const listeners = new Set();
const KEY = "sealedbluff.wallet";

function emit() {
  listeners.forEach((fn) => fn(listWallets()));
}

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (event) => {
    const { info, provider } = event.detail || {};
    if (!info || !provider) return;
    wallets.set(info.rdns || info.uuid, { info, provider });
    emit();
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

export function listWallets() {
  const list = [...wallets.values()];
  if (!list.length && typeof window !== "undefined" && window.ethereum) {
    list.push({ info: { name: "Browser wallet", rdns: "injected", icon: "" }, provider: window.ethereum });
  }
  return list;
}

export function onWalletsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let selected = null;

export function selectWallet(rdns) {
  const w = listWallets().find((x) => x.info.rdns === rdns);
  if (!w) return null;
  selected = w.provider;
  try {
    localStorage.setItem(KEY, rdns);
  } catch {
    /* ignore */
  }
  return selected;
}

/** The EIP-1193 provider the app should use right now. */
export function getEth() {
  if (selected) return selected;
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* ignore */
  }
  if (saved) {
    const w = listWallets().find((x) => x.info.rdns === saved);
    if (w) return (selected = w.provider);
  }
  return typeof window !== "undefined" ? window.ethereum || null : null;
}
