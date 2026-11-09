import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, ZeroHash, isAddress } from "ethers";
import abi from "./abi.json";
import {
  CHAIN_ID,
  CHAIN_ID_HEX,
  CHAIN_PARAMS,
  CONTRACT_ADDRESS,
  EXPLORER,
  MAX_ATTEMPTS,
  MAX_NUMBER,
  POLL_MS,
} from "./config.js";
import { getFhevm, hasSessionPermit, userDecrypt, withRetry } from "./fhe.js";
import { getEth, listWallets, onWalletsChanged, selectWallet } from "./wallet.js";

const HINT = {
  0: { icon: "⬇", text: "Lower", cls: "lower" },
  1: { icon: "⬆", text: "Higher", cls: "higher" },
  2: { icon: "🎉", text: "Correct!", cls: "correct" },
};

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

const readProvider = new JsonRpcProvider(CHAIN_PARAMS.rpcUrls[0], CHAIN_ID, { staticNetwork: true });
const readContract = isAddress(CONTRACT_ADDRESS) ? new Contract(CONTRACT_ADDRESS, abi, readProvider) : null;

// Decrypted values are cached per handle in this browser (they are the player's own results).
const CACHE_KEY = "hiddennumber:clear";
function loadCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveCache(c) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

function errorText(e) {
  const data = e?.data || e?.info?.error?.data || e?.error?.data;
  if (data && typeof data === "string" && readContract) {
    try {
      const parsed = readContract.interface.parseError(data);
      if (parsed) return `Contract said: ${parsed.name}`;
    } catch {
      /* not a custom error */
    }
  }
  if (e?.code === "ACTION_REJECTED" || e?.code === 4001) return "You rejected the request in your wallet.";
  return e?.shortMessage || e?.reason || e?.message || String(e);
}

export default function App() {
  const [account, setAccount] = useState(null);
  const [chainOk, setChainOk] = useState(false);
  const [signer, setSigner] = useState(null);
  const [signerContract, setSignerContract] = useState(null);
  const [game, setGame] = useState(null);
  const [clear, setClear] = useState(() => loadCache());
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState(null);
  const [fheReady, setFheReady] = useState(false);
  const [wallets, setWallets] = useState(() => listWallets());
  const [picker, setPicker] = useState(false);
  const [walletTick, setWalletTick] = useState(0);
  const autoSwitchTried = useRef(false);

  const notify = (msg, kind = "info") => setToast({ msg, kind, at: Date.now() });
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === "error" ? 9000 : 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // -------------------------------------------------------------- wallet
  async function switchToSepolia() {
    const eth = getEth();
    if (!eth) return;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
    } catch (e) {
      if (e?.code === 4902 || e?.data?.originalError?.code === 4902) {
        await eth.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] });
      } else throw e;
    }
  }

  const syncWallet = useCallback(async () => {
    const eth = getEth();
    if (!eth) return;
    const provider = new BrowserProvider(eth);
    const accounts = await provider.send("eth_accounts", []);
    const net = await provider.getNetwork();
    const ok = Number(net.chainId) === CHAIN_ID;
    setChainOk(ok);
    if (accounts.length) {
      const s = await provider.getSigner();
      setAccount(await s.getAddress());
      setSigner(s);
      setSignerContract(readContract ? new Contract(CONTRACT_ADDRESS, abi, s) : null);
      // Automatic network switch: if a connected wallet is on another chain, ask it to move to Sepolia once.
      if (!ok && !autoSwitchTried.current) {
        autoSwitchTried.current = true;
        switchToSepolia().catch(() => {});
      }
    } else {
      setAccount(null);
      setSigner(null);
      setSignerContract(null);
    }
  }, []);

  useEffect(() => onWalletsChanged(setWallets), []);

  useEffect(() => {
    syncWallet().catch(() => {});
    const eth = getEth();
    if (!eth) return;
    const onAccounts = () => syncWallet().catch(() => {});
    const onChain = () => {
      autoSwitchTried.current = false;
      syncWallet().catch(() => {});
    };
    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [syncWallet, walletTick]);

  function connect() {
    const list = listWallets();
    if (!list.length) {
      notify("No wallet found. Install MetaMask (or another EVM wallet) and reload.", "error");
      return;
    }
    if (list.length === 1) return connectWith(list[0].info.rdns);
    setPicker(true);
  }

  async function connectWith(rdns) {
    setPicker(false);
    const eth = selectWallet(rdns);
    if (!eth) return notify("That wallet is not available.", "error");
    setWalletTick((t) => t + 1);
    try {
      await eth.request({ method: "eth_requestAccounts" });
      autoSwitchTried.current = true;
      await switchToSepolia();
      await syncWallet();
    } catch (e) {
      notify(errorText(e), "error");
    }
  }

  // Warm up the FHE SDK (WASM) in the background once a wallet is connected.
  useEffect(() => {
    if (!account || !chainOk) return;
    getFhevm()
      .then(() => setFheReady(true))
      .catch((e) => notify(`Zama SDK: ${errorText(e)}`, "error"));
  }, [account, chainOk]);

  // -------------------------------------------------------------- game state
  const refresh = useCallback(async () => {
    if (!readContract || !account) return setGame(null);
    try {
      const g = await readContract.getGame(account);
      setGame({
        gameNumber: Number(g.gameNumber),
        active: g.active,
        revealed: g.revealed,
        attempts: Number(g.attempts),
        guesses: g.guesses.map(Number),
        hintHandles: [...g.hintHandles],
        wonHandle: g.wonHandle,
        secretHandle: g.secretHandle,
      });
    } catch (e) {
      console.warn("getGame failed", e);
    }
  }, [account]);

  useEffect(() => {
    refresh();
    if (!account) return;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh, account]);

  // -------------------------------------------------------------- actions
  async function send(label, fn) {
    if (!signerContract) return notify("Connect your wallet first.", "error");
    if (!chainOk) {
      try {
        await switchToSepolia();
      } catch {
        return notify("Please switch your wallet to Sepolia.", "error");
      }
      return notify("Switched to Sepolia — press the button again.", "info");
    }
    setBusy(label);
    try {
      const tx = await fn(signerContract);
      notify(`${label}: waiting for confirmation…`);
      const rc = await tx.wait();
      notify(`${label}: confirmed ✔`, "ok");
      await refresh();
      return rc;
    } catch (e) {
      notify(`${label} failed — ${errorText(e)}`, "error");
    } finally {
      setBusy("");
    }
  }

  const known = (h) => (h && h !== ZeroHash ? clear[h.toLowerCase()] : undefined);

  async function decrypt(handles, label) {
    const todo = handles.filter((h) => h && h !== ZeroHash && known(h) === undefined);
    if (!todo.length) return;
    if (!signer) return notify("Connect your wallet first.", "error");
    setBusy(label);
    try {
      const res = await withRetry(() => userDecrypt(signer, CONTRACT_ADDRESS, todo), {
        tries: 10,
        delayMs: 5000,
        onRetry: (i) => setBusy(`${label} (waiting for the coprocessor… ${i})`),
      });
      setClear((prev) => {
        const next = { ...prev, ...res };
        saveCache(next);
        return next;
      });
    } catch (e) {
      notify(`Decryption failed — ${errorText(e)}`, "error");
    } finally {
      setBusy("");
    }
  }

  async function onGuess(e) {
    e.preventDefault();
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > MAX_NUMBER) return notify(`Enter a whole number from 1 to ${MAX_NUMBER}.`, "error");
    const rc = await send(`Guess ${n}`, (c) => c.guess(n));
    if (rc) setValue("");
  }

  // -------------------------------------------------------------- derived view
  const view = useMemo(() => {
    if (!game) return null;
    const rows = game.guesses.map((g, i) => ({ n: i + 1, guess: g, handle: game.hintHandles[i], hint: known(game.hintHandles[i]) }));
    const pending = rows.filter((r) => r.hint === undefined).map((r) => r.handle);
    const won = rows.some((r) => r.hint === 2);
    let lo = 1;
    let hi = MAX_NUMBER;
    for (const r of rows) {
      if (r.hint === 1) lo = Math.max(lo, r.guess + 1);
      if (r.hint === 0) hi = Math.min(hi, r.guess - 1);
    }
    const secret = game.revealed ? known(game.secretHandle) : undefined;
    const left = game.active ? MAX_ATTEMPTS - game.attempts : 0;
    return { rows, pending, won, lo, hi, secret, left };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, clear]);

  const signedThisSession = account && hasSessionPermit(account, CONTRACT_ADDRESS);
  const hasGame = game && game.gameNumber > 0;

  // -------------------------------------------------------------- render
  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo">🔢</span>
          <div>
            <h1>Hidden Number</h1>
            <p className="tag">Guess an encrypted number. Only you can read the hints.</p>
          </div>
        </div>
        <div className="wallet">
          {account ? (
            <>
              {!chainOk && (
                <button className="warn" onClick={() => switchToSepolia().then(syncWallet).catch((e) => notify(errorText(e), "error"))}>
                  Switch to Sepolia
                </button>
              )}
              <span className="pill">{short(account)}</span>
              <span className={`pill ${fheReady ? "ok" : ""}`}>{fheReady ? "FHE ready" : "FHE loading…"}</span>
            </>
          ) : (
            <button className="primary" onClick={connect}>
              Connect wallet
            </button>
          )}
        </div>
      </header>

      {picker && (
        <div className="wallet-picker" onClick={() => setPicker(false)}>
          <div className="wallet-picker-box" onClick={(e) => e.stopPropagation()}>
            <h3>Choose a wallet</h3>
            {wallets.map((w) => (
              <button key={w.info.rdns} className="wallet-option" onClick={() => connectWith(w.info.rdns)}>
                {w.info.icon ? <img src={w.info.icon} alt="" width="24" height="24" /> : <span>👛</span>}
                <span>{w.info.name}</span>
              </button>
            ))}
            <button className="link" onClick={() => setPicker(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {!readContract && (
        <div className="card warnbox">
          <b>No contract address configured.</b> Paste your deployed address into <code>frontend/src/config.js</code> (or
          set <code>VITE_CONTRACT_ADDRESS</code> on Vercel) and rebuild.
        </div>
      )}

      <div className="grid2">
        <div className="card">
          <h2>How it works</h2>
          <ol className="steps">
            <li>
              <b>New game</b> — the contract draws a secret number from <b>1 to {MAX_NUMBER}</b> with FHE randomness. It
              stays encrypted on-chain.
            </li>
            <li>
              <b>Guess</b> — you have <b>{MAX_ATTEMPTS} tries</b>. The contract compares your guess with the encrypted secret
              and stores an <b>encrypted hint</b>.
            </li>
            <li>
              <b>Decrypt hint</b> — only your wallet can read it: ⬆ Higher, ⬇ Lower or 🎉 Correct. You sign once per
              session.
            </li>
            <li>
              <b>Reveal</b> — at the end (or to give up) the secret becomes decryptable by you alone.
            </li>
          </ol>
          <p className="muted small">
            Contract:{" "}
            {readContract ? (
              <a href={`${EXPLORER}/address/${CONTRACT_ADDRESS}`} target="_blank" rel="noreferrer">
                <code>{short(CONTRACT_ADDRESS)}</code>
              </a>
            ) : (
              "not set"
            )}{" "}
            · Sepolia
          </p>
        </div>

        <div className="card">
          {!account ? (
            <div className="center">
              <div className="big-q">?</div>
              <p className="muted">Connect a wallet on Sepolia to play. One account is all you need.</p>
              <button className="primary" onClick={connect}>
                Connect wallet
              </button>
            </div>
          ) : !hasGame || (!game.active && !game.revealed) ? (
            <div className="center">
              <div className="big-q">?</div>
              <p className="muted">A secret number between 1 and {MAX_NUMBER} is waiting to be drawn.</p>
              <button className="primary" disabled={!!busy || !readContract} onClick={() => send("New game", (c) => c.newGame())}>
                New game
              </button>
            </div>
          ) : (
            <>
              <div className="row spread">
                <h2>
                  Game #{game.gameNumber}{" "}
                  <span className={`phase ${game.active ? "p2" : "p4"}`}>{game.active ? "In progress" : "Revealed"}</span>
                </h2>
                {game.active && (
                  <span className="pill">
                    {view.left} / {MAX_ATTEMPTS} tries left
                  </span>
                )}
              </div>

              <div className="dots">
                {Array.from({ length: MAX_ATTEMPTS }).map((_, i) => (
                  <span key={i} className={`dot ${i < game.attempts ? "used" : ""}`} />
                ))}
              </div>

              {game.active && !view.won && view.left > 0 && (
                <form className="guess-form" onSubmit={onGuess}>
                  <input
                    type="number"
                    min={1}
                    max={MAX_NUMBER}
                    placeholder={`${view.lo}–${view.hi}`}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    disabled={!!busy}
                  />
                  <button className="primary" type="submit" disabled={!!busy || !value}>
                    Guess
                  </button>
                  <span className="muted small">
                    Range so far: <b>{view.lo}</b> – <b>{view.hi}</b>
                  </span>
                </form>
              )}

              {view.pending.length > 0 && (
                <div className="decrypt-box">
                  <button className="primary" disabled={!!busy} onClick={() => decrypt(view.pending, "Decrypting hint")}>
                    🔓 Decrypt hint{view.pending.length > 1 ? `s (${view.pending.length})` : ""}
                  </button>
                  <span className="muted small">
                    {signedThisSession ? "No signature needed — already signed this session." : "Sign once; cached for this session."}
                  </span>
                </div>
              )}

              {view.won && game.active && (
                <div className="banner correct">🎉 Correct! You found it in {view.rows.findIndex((r) => r.hint === 2) + 1} tries.</div>
              )}
              {game.active && !view.won && view.left === 0 && view.pending.length === 0 && (
                <div className="banner lower">Out of tries. Reveal the number to see what it was.</div>
              )}

              {view.rows.length > 0 && (
                <>
                  <h3>Your guesses</h3>
                  <ol className="history">
                    {view.rows.map((r) => (
                      <li key={r.n} className={r.hint !== undefined ? HINT[r.hint]?.cls : "sealed"}>
                        <span className="n">#{r.n}</span>
                        <span className="g">{r.guess}</span>
                        <span className="h">{r.hint !== undefined ? `${HINT[r.hint].icon} ${HINT[r.hint].text}` : "🔒 encrypted"}</span>
                      </li>
                    ))}
                  </ol>
                </>
              )}

              {game.revealed && (
                <div className="reveal">
                  {view.secret !== undefined ? (
                    <div className="banner correct">
                      The number was <b className="secret">{view.secret}</b>
                    </div>
                  ) : (
                    <button className="primary" disabled={!!busy} onClick={() => decrypt([game.secretHandle], "Decrypting the number")}>
                      🔓 Show the number
                    </button>
                  )}
                </div>
              )}

              <div className="row actions">
                {game.active && (
                  <button
                    className={view.won || view.left === 0 ? "primary" : "warn"}
                    disabled={!!busy}
                    onClick={() => send("Reveal", (c) => c.revealSecret())}
                  >
                    {view.won || view.left === 0 ? "Reveal the number" : "Give up & reveal"}
                  </button>
                )}
                <button disabled={!!busy} onClick={() => send("New game", (c) => c.newGame())}>
                  New game
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <footer>
        Built on the <a href="https://docs.zama.org/protocol" target="_blank" rel="noreferrer">Zama FHEVM</a> · secret drawn
        with <code>FHE.randEuint8</code>, compared with <code>FHE.eq</code> / <code>FHE.gt</code> / <code>FHE.select</code>,
        read with user decryption.
      </footer>

      {busy && <div className="busy">{busy}…</div>}
      {toast && (
        <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
