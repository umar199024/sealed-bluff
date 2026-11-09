# 🎲 Sealed Bluff

**Liar's Dice where nobody — not the other players, not the validators, not a block explorer — can see your cup.**

Built on the [Zama FHEVM](https://docs.zama.org/protocol) for the Zama Developer Program, Season 5 — _Confidential Gaming_. Deployed on **Sepolia**.

---

## The pitch

Liar's Dice is the purest bluffing game there is: everybody shakes a cup, peeks at their own dice, and then lies about
what's on the table. It has never worked on a public blockchain, because a public blockchain has no cups. Every value
in contract storage can be read by anyone, so the first person to open Etherscan wins every hand.

Sealed Bluff fixes that with Fully Homomorphic Encryption:

- the **contract rolls** the dice as encrypted random numbers (`FHE.randEuint16`), so nobody can pick or predict them,
- **only you** can decrypt your own dice (FHE ACL + user decryption via the Zama relayer),
- when someone shouts **"Liar!"**, the contract **counts the matching dice while they are still encrypted** and
  reveals exactly **one bit**: was the bid true or not.

Individual dice are never decrypted publicly. Not during the round, not after it.

---

## Rules

| | |
|---|---|
| Players | 2–6 per table, each starts with **5 dice** |
| Each round | All cups are re-rolled (encrypted). You privately peek at your own dice. |
| Bidding | In turn order, claim "there are **at least _N_ dice showing face _F_** on the whole table". Every bid must be **strictly higher**: more dice, or the same number of a higher face. |
| Liar! | Instead of raising, the player on turn may call **Liar!** on the last bid. |
| Resolution | If the bid was true (count ≥ N) the **challenger** loses a die. If it was a bluff, the **bidder** loses a die. |
| Optional rule | **1s are wild**: 1s count as any face (except when the bid face is 1 itself). Chosen when the table is created. |
| Next round | The player who lost a die opens the next round (or the next player still alive). Fresh encrypted roll. |
| Turn timeout | Each table has a timeout (1 min – 1 h). If the player on turn stalls past the deadline, **anyone** may call `claimTimeout` — the staller loses a die and a new round starts. |
| Win | Last player with dice wins. |

---

## What is encrypted, and why it would break if it were public

| Data | Type | Who can read it | If it were public… |
|---|---|---|---|
| Every die in every cup | `euint8` (values 1–6) | the owner (`FHE.allow`) + the contract (`FHE.allowThis`) | Anyone reading storage or the RPC would know the whole table. Every bid would be trivially checked, bluffing is impossible, the game is solved. |
| The random source | `FHE.randEuint16` inside the coprocessor | nobody | A plaintext on-chain RNG (blockhash, timestamp…) is predictable or manipulable by validators / the player triggering the roll. |
| The running count during "Liar!" | `euint8`, transient | nobody (never stored, never allowed) | Revealing the exact count leaks information about other players' cups that carries into reasoning, and allows inference attacks over many rounds. |
| **The verdict** `count >= bidQty` | `ebool` | **everyone** (`FHE.makePubliclyDecryptable`) | This is the only thing the game needs to make public. |

Public data: who is seated, how many dice each player has left, whose turn it is, the bids, and each round's verdict
and loser. That is exactly what a real-life table can see.

---

## How fairness works

1. **Nobody chooses the dice.** Dice come from the FHEVM's on-chain encrypted PRNG. `rollDice(tableId, player)` can be
   called by _anyone_ (so nobody can stall the roll), but the caller only triggers the roll; they cannot see or pick the
   result. Each die is `FHE.rem(FHE.randEuint16(), 6) + 1` stored as `euint8` (bias < 0.01 %, since 65536 mod 6 = 4).
2. **Nobody sees other dice.** The ACL grants each die only to its owner and to the contract. User decryption requires
   an EIP-712 signature from the owner's wallet; the Zama KMS re-encrypts the value under that user's key.
3. **The contract counts, not a server.** `callLiar` loops over every alive cup and computes homomorphically:
   `match = FHE.eq(d, face) [ FHE.or FHE.eq(d, 1) if wild ]`, `count = FHE.add(count, FHE.select(match, 1, 0))`,
   then `verdict = FHE.ge(count, bidQty)`.
4. **Only the verdict is revealed, and it can't be faked.** The verdict handle is marked publicly decryptable. Anyone
   asks the Zama relayer for its public decryption, which returns the clear value plus a **KMS signature proof**.
   `resolveChallenge(tableId, bidWasTrue, proof)` calls `FHE.checkSignatures(handles, abi.encode(bidWasTrue), proof)`,
   which reverts unless the threshold of KMS signers signed exactly that value for exactly that handle. Flipping the
   answer reverts (there's a test for it). The phase change is the replay protection.
5. **Nobody can freeze the game.** Rolling and resolving are permissionless; the only action tied to one player (bid
   or call on your turn) is covered by the turn timeout.
6. **Fresh dice every round.** A new round always re-rolls every cup, so information from previous rounds is worthless.

---

## How to verify a round

Everything needed to audit a round is on-chain:

1. Find the `LiarCalled(tableId, round, challenger, bidder, quantity, face, verdictHandle)` event on Etherscan
   (contract → _Events_), or read it from the app's table page.
2. Public-decrypt the handle yourself — it is publicly decryptable forever:
   ```bash
   npx hardhat --network sepolia sealed:verdict --id <tableId>      # while the round is awaiting reveal
   ```
   or in JavaScript with the relayer SDK: `await instance.publicDecrypt([verdictHandle])`.
3. In the `resolveChallenge` transaction, check the `PublicDecryptionVerified(handles, abiEncodedCleartexts)` event
   (emitted by `FHE.checkSignatures`) and the `RoundResolved(tableId, round, bidWasTrue, loser, loserDiceLeft)` event.
   They must match the verdict you decrypted.
4. `getHistory(tableId)` returns the full history: bidder, challenger, bid, verdict, loser, dice left, and whether the
   round ended in a timeout. `npx hardhat --network sepolia sealed:table --id <tableId>` prints it.

What you **cannot** verify is anybody's individual dice. That's the point.

---

## Architecture

```
┌──────────────────────────── Browser (Vite + React, ethers v6) ────────────────────────────┐
│  MetaMask ── txs: createTable / joinTable / startGame / rollDice / placeBid / callLiar /   │
│              resolveChallenge / claimTimeout                                               │
│  @zama-fhe/relayer-sdk ── userDecrypt(my dice)  ── EIP-712 permit, cached 7 days           │
│                       └── publicDecrypt(verdict) ── clear bool + KMS proof                 │
└──────────────┬──────────────────────────────────────────────┬─────────────────────────────┘
               │ JSON-RPC (Sepolia)                           │ HTTPS
┌──────────────▼───────────────┐                 ┌────────────▼─────────────┐
│ SealedBluff.sol (Sepolia)    │  FHE ops/ACL    │ Zama Relayer → Gateway → │
│  - tables, seats, bids       │ ───────────────▶│ KMS (threshold decrypt)  │
│  - euint8 dice[5] per player │  coprocessor    │ + FHE coprocessors       │
│  - ebool verdict             │                 └──────────────────────────┘
│  - FHE.checkSignatures       │
└──────────────────────────────┘
```

**Contract — `contracts/SealedBluff.sol`** (inherits `ZamaEthereumConfig`, which wires the Sepolia ACL / coprocessor
/ KMS-verifier addresses)

| Function | Who | What |
|---|---|---|
| `createTable(maxPlayers, onesWild, turnTimeout)` | anyone | opens a table; creator takes seat 0 |
| `joinTable(id)` | anyone | takes a seat while in Lobby |
| `startGame(id)` | creator | ≥ 2 players; gives 5 dice each; starts round 1 |
| `rollDice(id, player)` | anyone | encrypted roll of `player`'s cup for this round; `FHE.allowThis` + `FHE.allow(player)` |
| `placeBid(id, qty, face)` | player on turn | strictly higher bid, `qty ≤ totalDice`, `1 ≤ face ≤ 6` |
| `callLiar(id)` | player on turn | homomorphic count → `ebool verdict` → `makePubliclyDecryptable` |
| `resolveChallenge(id, bidWasTrue, proof)` | anyone | `FHE.checkSignatures`, loser loses a die, next round or `GameWon` |
| `claimTimeout(id)` | anyone | after the deadline: player on turn loses a die, next round |
| `getTable / getPlayers / getDice / getHistory / diceCountOf` | view | public state (dice are opaque handles) |

Phases: `Lobby → Rolling → Bidding → AwaitingReveal → (Rolling … ) → Finished`.

Events: `TableCreated, PlayerJoined, GameStarted, RoundStarted, DiceRolled, BiddingOpened, BidPlaced, LiarCalled,
RoundResolved, TimeoutPenalty, PlayerEliminated, GameWon` (+ the library's `PublicDecryptionVerified`).

**HCU budget** (Zama limits per tx: 20M HCU total, 5M depth). Rolling is done **per player** (5 dice ≈ 3.6M HCU) rather
than for the whole table in one go (30 dice would exceed 20M). The worst-case Liar! call — 6 players × 5 dice with wild
1s — is ≈ 8.3M HCU with ≈ 2.9M depth, and is covered by a test.

**Frontend — `frontend/`** — Vite + React + ethers v6 + `@zama-fhe/relayer-sdk` (loaded from Zama's CDN, re-exported
through `@zama-fhe/relayer-sdk/bundle`). Contract address in `frontend/src/config.js` or `VITE_CONTRACT_ADDRESS`.

```
contracts/SealedBluff.sol     the game
test/SealedBluff.ts           mock-FHEVM test suite (10 tests)
deploy/deploy.ts              hardhat-deploy script (Sepolia / local)
tasks/SealedBluff.ts          sealed:address, sealed:table, sealed:verdict
hardhat.config.ts             vars: PRIVATE_KEY or MNEMONIC, SEPOLIA_RPC_URL or INFURA_API_KEY
frontend/                     the web app (Vercel root directory)
DEPLOY_GUIDE.md               step-by-step deployment for non-coders
```

---

## Run the tests

```bash
npm install
npx hardhat compile
npx hardhat test
```

The suite runs on the FHEVM **mock** from `@fhevm/hardhat-plugin` (mock host contracts including the ACL and the
KMS-signature verifier; ciphertexts are mocked). It covers:

- lobby guards (config bounds, full table, creator-only start)
- encrypted roll: values in 1..6, owner can decrypt, **another player cannot**, dice are **not publicly decryptable**
- bidding: turn order, strictly-higher rule, quantity/face bounds
- a **full round**: join → roll → bid → Liar! → public decryption → `resolveChallenge` → correct loser, reroll, history,
  replay protection
- **forged verdicts are rejected** (flipped value with a genuine proof, garbage proof)
- **1s wild** counting
- **turn timeout** penalty
- a **whole game to a winner** (2 players, up to 9 rounds) and a 3-player game with eliminations
- **worst case** 6 × 5 dice with wild 1s: roll + Liar! fit within HCU and gas limits

Deploy locally: `npx hardhat node` in one terminal, `npx hardhat deploy --network localhost` in another.
Deploy to Sepolia: see **[DEPLOY_GUIDE.md](./DEPLOY_GUIDE.md)**.

---

## Versions

Based on the official [`zama-ai/fhevm-hardhat-template`](https://github.com/zama-ai/fhevm-hardhat-template) (v0.4.1).

| Package | Version |
|---|---|
| `@fhevm/solidity` | 0.11.1 (template pin; Sepolia addresses identical to the latest 0.13.x) |
| `@fhevm/hardhat-plugin` / `@fhevm/mock-utils` | 0.4.2 |
| `@zama-fhe/relayer-sdk` | 0.4.1 (hardhat) · 0.4.5 (frontend) |
| `hardhat` | 2.28.x, Solidity 0.8.27, EVM cancun |
| Frontend | Vite 6, React 19, ethers 6 |

## Known limitations

- One game per table; no stakes or wagers (it's a testnet game).
- The bid rules are the simple "strictly higher (quantity, face)" variant; there's no special bid conversion for 1s.
- Each player sends their own transactions on Sepolia; FHE results take a few seconds to be ready for decryption, so
  the app retries automatically.

## License

BSD-3-Clause-Clear (same as the template).
