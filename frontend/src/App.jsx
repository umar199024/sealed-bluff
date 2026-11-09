import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, isAddress } from "ethers";
import abi from "./abi.json";
import { CHAIN_ID, CHAIN_ID_HEX, CHAIN_PARAMS, CONTRACT_ADDRESS, EXPLORER, POLL_MS } from "./config.js";
import { decryptMyDice, decryptVerdict, getFhevm, withRetry } from "./fhe.js";
import { getEth, listWallets, onWalletsChanged, selectWallet } from "./wallet.js";

const PHASES = ["Lobby", "Rolling", "Bidding", "Awaiting reveal", "Finished"];
const FACE = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

const readProvider = new JsonRpcProvider(CHAIN_PARAMS.rpcUrls[0], CHAIN_ID, { staticNetwork: true });
const readContract = isAddress(CONTRACT_ADDRESS) ? new Contract(CONTRACT_ADDRESS, abi, readProvider) : null;

function errorText(e) {
  const data = e?.data || e?.info?.error?.data || e?.error?.data;
  if (data && typeof data === "string") {
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
  const [signerContract, setSignerContract] = useState(null);
  const [signer, setSigner] = useState(null);
  const [tableId, setTableId] = useState(() => {
    const p = new URLSearchParams(window.location.search).get("table");
    return p ? Number(p) : null;
  });
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState(null);
  const [fheReady, setFheReady] = useState(false);

  const notify = (msg, kind = "info") => setToast({ msg, kind, at: Date.now() });

  // -------------------------------------------------------------- wallet
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
    } else {
      setAccount(null);
      setSigner(null);
      setSignerContract(null);
    }
  }, []);

  const [wallets, setWallets] = useState(() => listWallets());
  const [picker, setPicker] = useState(false);
  const [walletTick, setWalletTick] = useState(0);
  useEffect(() => onWalletsChanged(setWallets), []);

  useEffect(() => {
    syncWallet();
    const eth = getEth();
    if (!eth) return;
    const h = () => syncWallet();
    eth.on?.("accountsChanged", h);
    eth.on?.("chainChanged", h);
    return () => {
      eth.removeListener?.("accountsChanged", h);
      eth.removeListener?.("chainChanged", h);
    };
  }, [syncWallet, walletTick]);

  function connect() {
    const list = listWallets();
    if (!list.length) {
      notify("No wallet found. Install MetaMask, Rabby or another EVM wallet and reload.", "error");
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
      await switchToSepolia();
      await syncWallet();
    } catch (e) {
      notify(errorText(e), "error");
    }
  }

  async function switchToSepolia() {
    try {
      await getEth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
    } catch (e) {
      if (e?.code === 4902) {
        await getEth().request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] });
      } else throw e;
    }
  }

  // Warm up the FHE SDK (WASM) in the background once a wallet is connected.
  useEffect(() => {
    if (!account || !chainOk) return;
    getFhevm()
      .then(() => setFheReady(true))
      .catch((e) => notify(`Zama SDK: ${errorText(e)}`, "error"));
  }, [account, chainOk]);

  // -------------------------------------------------------------- tx helper
  async function send(label, fn) {
    if (!signerContract) return notify("Connect your wallet first.", "error");
    if (!chainOk) return notify("Switch your wallet to Sepolia.", "error");
    setBusy(label);
    try {
      const tx = await fn(signerContract);
      notify(`${label}: waiting for confirmation…`);
      const rc = await tx.wait();
      notify(`${label}: confirmed ✔`, "ok");
      return rc;
    } catch (e) {
      notify(`${label} failed — ${errorText(e)}`, "error");
    } finally {
      setBusy("");
    }
  }

  function openTable(id) {
    setTableId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("table", String(id));
    else url.searchParams.delete("table");
    window.history.replaceState({}, "", url);
  }

  // -------------------------------------------------------------- render
  return (
    <div className="app">
      <header>
        <div className="brand" onClick={() => openTable(null)}>
          <span className="logo">🎲</span>
          <div>
            <h1>Sealed Bluff</h1>
            <p className="tag">Liar's Dice where nobody — not even the chain — sees your cup.</p>
          </div>
        </div>
        <div className="wallet">
          {account ? (
            <>
              {!chainOk && (
                <button className="warn" onClick={() => switchToSepolia().then(syncWallet)}>
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
            <button className="link" onClick={() => setPicker(false)}>Cancel</button>
          </div>
        </div>
      )}

      {!readContract && (
        <div className="card warnbox">
          <b>No contract address configured.</b> Paste your deployed address into <code>frontend/src/config.js</code>{" "}
          or set <code>VITE_CONTRACT_ADDRESS</code> on Vercel, then rebuild.
        </div>
      )}

      {readContract &&
        (tableId ? (
          <TableView
            key={tableId}
            tableId={tableId}
            account={account}
            signer={signer}
            send={send}
            busy={busy}
            notify={notify}
            onBack={() => openTable(null)}
          />
        ) : (
          <Lobby account={account} send={send} busy={busy} openTable={openTable} />
        ))}

      {toast && (
        <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>
          {toast.msg}
        </div>
      )}

      <footer>
        Contract{" "}
        <a href={`${EXPLORER}/address/${CONTRACT_ADDRESS}`} target="_blank" rel="noreferrer">
          {short(CONTRACT_ADDRESS)}
        </a>{" "}
        on Sepolia · Encrypted with Zama FHEVM · Dice are never revealed, only the verdict.
      </footer>
    </div>
  );
}

// ============================================================================
// Lobby
// ============================================================================
function Lobby({ account, send, busy, openTable }) {
  const [maxPlayers, setMaxPlayers] = useState(2);
  const [onesWild, setOnesWild] = useState(true);
  const [timeout, setTimeoutSec] = useState(300);
  const [joinId, setJoinId] = useState("");
  const [recent, setRecent] = useState([]);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const count = Number(await readContract.tableCount());
        const ids = [];
        for (let i = count; i >= 1 && ids.length < 8; i--) ids.push(i);
        const rows = await Promise.all(
          ids.map(async (id) => {
            const t = await readContract.getTable(id);
            return { id, phase: Number(t.phase), players: Number(t.playerCount), max: Number(t.maxPlayers), wild: t.onesWild };
          }),
        );
        if (alive) setRecent(rows);
      } catch {
        /* RPC hiccup */
      }
    }
    load();
    const iv = setInterval(load, POLL_MS * 2);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  async function create() {
    const rc = await send("Create table", (c) => c.createTable(maxPlayers, onesWild, timeout));
    if (!rc) return;
    const ev = rc.logs.map((l) => {
      try {
        return readContract.interface.parseLog(l);
      } catch {
        return null;
      }
    }).find((e) => e?.name === "TableCreated");
    if (ev) openTable(Number(ev.args.tableId));
  }

  async function join(id) {
    const rc = await send(`Join table #${id}`, (c) => c.joinTable(id));
    if (rc) openTable(id);
  }

  return (
    <div className="grid2">
      <section className="card">
        <h2>Open a table</h2>
        <label>
          Players (2–6)
          <div className="seg">
            {[2, 3, 4, 5, 6].map((n) => (
              <button key={n} className={n === maxPlayers ? "on" : ""} onClick={() => setMaxPlayers(n)}>
                {n}
              </button>
            ))}
          </div>
        </label>
        <label className="row">
          <input type="checkbox" checked={onesWild} onChange={(e) => setOnesWild(e.target.checked)} /> 1s are wild
        </label>
        <label>
          Turn timeout
          <select value={timeout} onChange={(e) => setTimeoutSec(Number(e.target.value))}>
            <option value={60}>1 minute</option>
            <option value={180}>3 minutes</option>
            <option value={300}>5 minutes</option>
            <option value={900}>15 minutes</option>
            <option value={3600}>1 hour</option>
          </select>
        </label>
        <button className="primary" disabled={!account || !!busy} onClick={create}>
          {busy === "Create table" ? "Creating…" : "Create table"}
        </button>
        <hr />
        <h2>Join or watch a table</h2>
        <div className="row">
          <input placeholder="Table #" value={joinId} onChange={(e) => setJoinId(e.target.value.replace(/\D/g, ""))} />
          <button disabled={!joinId} onClick={() => openTable(Number(joinId))}>
            Open
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Recent tables</h2>
        {recent.length === 0 && <p className="muted">No tables yet — open the first one.</p>}
        <ul className="tables">
          {recent.map((r) => (
            <li key={r.id}>
              <span>
                <b>#{r.id}</b> · {PHASES[r.phase]} · {r.players}/{r.max} players {r.wild ? "· 1s wild" : ""}
              </span>
              <span>
                {r.phase === 0 && r.players < r.max && (
                  <button disabled={!account || !!busy} onClick={() => join(r.id)}>
                    Join
                  </button>
                )}
                <button onClick={() => openTable(r.id)}>View</button>
              </span>
            </li>
          ))}
        </ul>
        <h3>How it works</h3>
        <ol className="muted small">
          <li>Each round the contract rolls everyone's dice as encrypted numbers (FHE randomness).</li>
          <li>Only you can decrypt your own cup. Everyone else sees 🔒.</li>
          <li>Bid "at least N dice show face F". Each bid must be higher.</li>
          <li>Call "Liar!" and the contract counts matching dice while still encrypted. Only the yes/no verdict is revealed.</li>
          <li>Wrong side loses a die. Last player with dice wins.</li>
        </ol>
      </section>
    </div>
  );
}

// ============================================================================
// Table
// ============================================================================
function TableView({ tableId, account, signer, send, busy, notify, onBack }) {
  const [t, setT] = useState(null);
  const [players, setPlayers] = useState([]);
  const [history, setHistory] = useState([]);
  const [notFound, setNotFound] = useState(false);
  const [myDice, setMyDice] = useState(null); // { round, faces }
  const [peeking, setPeeking] = useState(false);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [qty, setQty] = useState(1);
  const [face, setFace] = useState(2);
  const [resolving, setResolving] = useState("");
  const lastRound = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const [tt, pp, hh] = await Promise.all([
        readContract.getTable(tableId),
        readContract.getPlayers(tableId),
        readContract.getHistory(tableId),
      ]);
      setT({
        creator: tt.creator,
        maxPlayers: Number(tt.maxPlayers),
        onesWild: tt.onesWild,
        turnTimeout: Number(tt.turnTimeout),
        phase: Number(tt.phase),
        round: Number(tt.round),
        currentTurn: Number(tt.currentTurn),
        alivePlayers: Number(tt.alivePlayers),
        totalDice: Number(tt.totalDice),
        bidQty: Number(tt.bidQty),
        bidFace: Number(tt.bidFace),
        lastBidder: tt.lastBidder,
        challenger: tt.challenger,
        turnDeadline: Number(tt.turnDeadline),
        winner: tt.winner,
        verdictHandle: tt.verdictHandle,
      });
      setPlayers(pp[0].map((addr, i) => ({ addr, dice: Number(pp[1][i]), rolled: pp[2][i] })));
      setHistory(
        hh.map((h) => ({
          round: Number(h.round),
          bidder: h.bidder,
          challenger: h.challenger,
          bidQty: Number(h.bidQty),
          bidFace: Number(h.bidFace),
          bidWasTrue: h.bidWasTrue,
          timeout: h.timeout,
          loser: h.loser,
          left: Number(h.loserDiceLeft),
        })),
      );
    } catch (e) {
      if (String(e?.message || "").includes("TableNotFound") || e?.revert?.name === "TableNotFound") setNotFound(true);
    }
  }, [tableId]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, POLL_MS);
    const clock = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => {
      clearInterval(iv);
      clearInterval(clock);
    };
  }, [refresh]);

  // New round → forget old dice, reset bid controls
  useEffect(() => {
    if (!t) return;
    if (t.round !== lastRound.current) {
      lastRound.current = t.round;
      setMyDice(null);
    }
  }, [t]);

  // Keep the bid controls on the lowest legal bid
  useEffect(() => {
    if (!t || t.phase !== 2) return;
    if (t.bidQty === 0) {
      setQty((q) => Math.max(1, Math.min(q, t.totalDice)));
    } else if (!(qty > t.bidQty || (qty === t.bidQty && face > t.bidFace))) {
      if (t.bidFace < 6) {
        setQty(t.bidQty);
        setFace(t.bidFace + 1);
      } else {
        setQty(Math.min(t.bidQty + 1, t.totalDice));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.bidQty, t?.bidFace, t?.phase]);

  const me = useMemo(() => players.find((p) => same(p.addr, account)), [players, account]);
  const seated = !!me;
  const onTurn = t && players[t.currentTurn] && same(players[t.currentTurn].addr, account);
  const bidLegal =
    t && qty >= 1 && qty <= t.totalDice && face >= 1 && face <= 6 && (qty > t.bidQty || (qty === t.bidQty && face > t.bidFace));
  const secondsLeft = t ? t.turnDeadline - now : 0;

  async function peek() {
    if (!signer) return notify("Connect your wallet first.", "error");
    setPeeking(true);
    try {
      const handles = await readContract.getDice(tableId, account);
      const mine = handles.slice(0, me.dice);
      const faces = await withRetry(() => decryptMyDice(signer, readContract.target, mine), {
        tries: 8,
        delayMs: 5000,
        onRetry: (i) => notify(`Your dice are still being sealed by the coprocessor… retry ${i}`),
      });
      setMyDice({ round: t.round, faces });
    } catch (e) {
      notify(`Could not decrypt your dice — ${errorText(e)}`, "error");
    } finally {
      setPeeking(false);
    }
  }

  async function resolve() {
    setResolving("Asking the Zama relayer for the public verdict…");
    try {
      const { bidWasTrue, proof } = await withRetry(() => decryptVerdict(t.verdictHandle), {
        tries: 24,
        delayMs: 5000,
        onRetry: (i) => setResolving(`Verdict not ready yet (coprocessor still counting)… retry ${i}`),
      });
      setResolving(`Verdict: the bid was ${bidWasTrue ? "TRUE" : "a BLUFF"}. Submitting with KMS proof…`);
      await send("Resolve", (c) => c.resolveChallenge(tableId, bidWasTrue, proof));
    } catch (e) {
      notify(`Public decryption failed — ${errorText(e)}`, "error");
    } finally {
      setResolving("");
      refresh();
    }
  }

  const act = async (label, fn) => {
    await send(label, fn);
    refresh();
  };

  if (notFound)
    return (
      <div className="card">
        <p>Table #{tableId} does not exist.</p>
        <button onClick={onBack}>← Back</button>
      </div>
    );
  if (!t) return <div className="card">Loading table #{tableId}…</div>;

  const shareUrl = `${window.location.origin}${window.location.pathname}?table=${tableId}`;

  return (
    <div className="table-wrap">
      <div className="card head">
        <button onClick={onBack}>← Lobby</button>
        <div>
          <h2>
            Table #{tableId} <span className={`phase p${t.phase}`}>{PHASES[t.phase]}</span>
          </h2>
          <p className="muted small">
            Round {t.round || "–"} · {t.totalDice} dice in play · {t.onesWild ? "1s wild" : "no wilds"} · timeout{" "}
            {Math.round(t.turnTimeout / 60)} min ·{" "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                navigator.clipboard?.writeText(shareUrl);
                notify("Invite link copied");
              }}
            >
              copy invite link
            </a>
          </p>
        </div>
      </div>

      {/* ---------------- seats ---------------- */}
      <div className="seats">
        {players.map((p, i) => {
          const isMe = same(p.addr, account);
          const turn = (t.phase === 2 && t.currentTurn === i) || false;
          return (
            <div key={p.addr} className={`seat ${isMe ? "me" : ""} ${turn ? "turn" : ""} ${p.dice === 0 && t.phase > 0 ? "out" : ""}`}>
              <div className="seat-head">
                <b>{isMe ? "You" : `Seat ${i + 1}`}</b> <span className="muted small">{short(p.addr)}</span>
                {same(t.winner, p.addr) && <span className="crown">👑</span>}
              </div>
              <div className="cup">
                {t.phase === 0 && <span className="muted small">waiting…</span>}
                {t.phase > 0 && p.dice === 0 && <span className="muted small">out</span>}
                {t.phase > 0 &&
                  Array.from({ length: p.dice }).map((_, k) =>
                    isMe && myDice && myDice.round === t.round ? (
                      <span key={k} className="die" title={`${myDice.faces[k]}`}>
                        {FACE[myDice.faces[k]]}
                      </span>
                    ) : (
                      <span key={k} className="die sealed" title="sealed (encrypted)">
                        🔒
                      </span>
                    ),
                  )}
              </div>
              <div className="seat-foot small">
                {t.phase === 1 && (p.rolled ? "rolled ✔" : "not rolled")}
                {turn && "⏳ on turn"}
                {t.phase === 1 && !p.rolled && p.dice > 0 && account && (
                  <button
                    disabled={!!busy}
                    onClick={() => act(isMe ? "Roll my dice" : "Roll for player", (c) => c.rollDice(tableId, p.addr))}
                  >
                    {isMe ? "🎲 Roll my dice" : "Roll for them"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {t.phase === 0 &&
          Array.from({ length: t.maxPlayers - players.length }).map((_, k) => (
            <div key={`empty${k}`} className="seat empty">
              <span className="muted">empty seat</span>
            </div>
          ))}
      </div>

      {/* ---------------- action panel ---------------- */}
      <div className="card actions">
        {t.phase === 0 && (
          <>
            <p>
              {players.length}/{t.maxPlayers} players seated. Share the invite link, then the creator starts the game.
            </p>
            {!seated && account && (
              <button className="primary" disabled={!!busy} onClick={() => act("Join table", (c) => c.joinTable(tableId))}>
                Join this table
              </button>
            )}
            {same(t.creator, account) && (
              <button
                className="primary"
                disabled={!!busy || players.length < 2}
                onClick={() => act("Start game", (c) => c.startGame(tableId))}
              >
                Start game
              </button>
            )}
          </>
        )}

        {t.phase === 1 && (
          <p>
            Rolling round {t.round}. The contract rolls each cup with encrypted randomness — anyone can press roll, nobody
            can see or choose the result.
          </p>
        )}

        {t.phase >= 1 && t.phase <= 3 && seated && me.dice > 0 && (
          <div className="peek">
            <button disabled={peeking || !me.rolled} onClick={peek}>
              {peeking ? "Decrypting…" : myDice && myDice.round === t.round ? "🔓 Refresh my dice" : "👁 Peek at my dice"}
            </button>
            <span className="muted small">
              User decryption: your wallet signs a request, the Zama KMS re-encrypts your dice for your key only.
            </span>
          </div>
        )}

        {t.phase === 2 && (
          <>
            <div className="bid-now">
              {t.bidQty === 0 ? (
                <span>No bid yet — {onTurn ? "you open" : `${short(players[t.currentTurn]?.addr)} opens`}.</span>
              ) : (
                <span>
                  Current bid: <b className="big">{t.bidQty} × {FACE[t.bidFace]}</b> by{" "}
                  {same(t.lastBidder, account) ? "you" : short(t.lastBidder)}
                </span>
              )}
              <span className={`clock ${secondsLeft < 0 ? "late" : ""}`}>
                {secondsLeft >= 0 ? `${secondsLeft}s left` : `${-secondsLeft}s overdue`}
              </span>
            </div>
            {onTurn ? (
              <div className="bid-controls">
                <div className="row">
                  <button onClick={() => setQty((q) => Math.max(1, q - 1))}>−</button>
                  <span className="big">{qty}</span>
                  <button onClick={() => setQty((q) => Math.min(t.totalDice, q + 1))}>+</button>
                  <span className="muted">×</span>
                  {[1, 2, 3, 4, 5, 6].map((f) => (
                    <button key={f} className={`facebtn ${f === face ? "on" : ""}`} onClick={() => setFace(f)}>
                      {FACE[f]}
                    </button>
                  ))}
                </div>
                <div className="row">
                  <button
                    className="primary"
                    disabled={!!busy || !bidLegal}
                    onClick={() => act("Bid", (c) => c.placeBid(tableId, qty, face))}
                  >
                    Bid {qty} × {FACE[face]}
                  </button>
                  <button
                    className="liar"
                    disabled={!!busy || t.bidQty === 0}
                    onClick={() => act("Liar!", (c) => c.callLiar(tableId))}
                  >
                    LIAR!
                  </button>
                </div>
                {!bidLegal && <p className="muted small">A bid must be higher: more dice, or the same number of a higher face.</p>}
              </div>
            ) : (
              <p className="muted">Waiting for {short(players[t.currentTurn]?.addr)} to bid or call Liar…</p>
            )}
            {secondsLeft < 0 && account && !onTurn && (
              <button className="warn" disabled={!!busy} onClick={() => act("Claim timeout", (c) => c.claimTimeout(tableId))}>
                ⏰ Penalise staller (they lose a die)
              </button>
            )}
          </>
        )}

        {t.phase === 3 && (
          <>
            <p>
              <b>{same(t.challenger, account) ? "You" : short(t.challenger)}</b> called Liar on{" "}
              <b>
                {t.bidQty} × {FACE[t.bidFace]}
              </b>
              . The contract counted the matching dice under encryption; only the yes/no verdict is publicly decryptable.
            </p>
            <p className="muted small mono">verdict handle: {t.verdictHandle}</p>
            <button className="primary" disabled={!!busy || !!resolving || !account} onClick={resolve}>
              Reveal verdict & resolve
            </button>
            {resolving && <p className="muted">{resolving}</p>}
          </>
        )}

        {t.phase === 4 && (
          <div className="winner">
            👑 {same(t.winner, account) ? "You win!" : `${short(t.winner)} wins!`} after {t.round} rounds.
          </div>
        )}
      </div>

      {/* ---------------- history ---------------- */}
      <div className="card">
        <h3>Round history</h3>
        {history.length === 0 && <p className="muted small">No rounds finished yet.</p>}
        <ol className="history">
          {[...history].reverse().map((h) => (
            <li key={h.round}>
              <b>Round {h.round}</b>{" "}
              {h.timeout ? (
                <>⏰ timeout — {short(h.loser)} stalled</>
              ) : (
                <>
                  {short(h.bidder)} bid {h.bidQty} × {FACE[h.bidFace]}, {short(h.challenger)} called Liar →{" "}
                  <b className={h.bidWasTrue ? "ok" : "bad"}>{h.bidWasTrue ? "bid was TRUE" : "it was a BLUFF"}</b>
                </>
              )}{" "}
              · {same(h.loser, account) ? "you" : short(h.loser)} lost a die ({h.left} left)
            </li>
          ))}
        </ol>
        <p className="muted small">
          Every verdict is checked on-chain against Zama KMS signatures (<code>FHE.checkSignatures</code>). Verify on{" "}
          <a href={`${EXPLORER}/address/${CONTRACT_ADDRESS}#events`} target="_blank" rel="noreferrer">
            Etherscan events
          </a>
          .
        </p>
      </div>
      {account === null && <p className="muted center">Connect your wallet to play. You are watching as a spectator.</p>}
      {busy && <div className="busy">⏳ {busy}…</div>}
    </div>
  );
}


