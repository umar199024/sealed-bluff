# 🔢 Hidden Number — a confidential guessing game on the Zama FHEVM

A simple **single-player** game for the **Zama Developer Program — Mainnet Season 5 (Confidential Gaming)**. You need
**one** wallet (MetaMask or any EVM wallet) on **Sepolia**.

The contract draws a secret number from **1 to 64** using on-chain FHE randomness. You have **7 guesses**. After each
guess the contract compares your number with the secret **while it is still encrypted** and stores an **encrypted hint**
that only your wallet can decrypt: **⬆ Higher**, **⬇ Lower** or **🎉 Correct**. Nobody else — not other players, not
validators, not the deployer, not a block explorer — can read the secret or your hints. At the end (or if you give up)
you can reveal the secret **to yourself only**.

> 7 guesses is exactly enough for a perfect binary search over 64 numbers (2⁶ = 64), so a smart player always wins.

---

## How it works

```
newGame()          secret = FHE.randEuint8(64) + 1        → encrypted euint8 in [1, 64]
                   won    = FHE.asEbool(false)            → encrypted flag, readable by the player

guess(g)  (1..64)  isEq   = FHE.eq(secret, g)
                   isHi   = FHE.gt(secret, g)
                   hint   = FHE.select(isEq, 2, FHE.select(isHi, 1, 0))   // 2 = correct, 1 = higher, 0 = lower
                   won    = FHE.or(won, isEq)
                   FHE.allowThis(hint); FHE.allow(hint, player)            // only the player can decrypt
                   attempts++  (max 7), emit Guessed(...)

revealSecret()     FHE.allow(secret, player)              → the player alone can now decrypt the secret
```

- The guess itself is **plaintext** (it is the player's own choice; hiding it adds nothing in a single-player game).
  What stays confidential is the **secret** and the **comparison result**.
- One active game per player. `newGame()` can be called at any time and resets attempts and history.
- `getGame(player)` returns `gameNumber, active, revealed, attempts, guesses[], hintHandles[], wonHandle, secretHandle`
  (the secret handle is zero until revealed). Handles are public; the **ACL** decides who can decrypt.
- The website uses **user decryption** from `@zama-fhe/relayer-sdk`: the player signs **one** EIP-712 message per
  browser session; the keypair + signature are cached in `sessionStorage`, so every later hint decrypts without another
  popup.

### FHE operations used

| Operation                     | Where              | Why                                                                      |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `FHE.randEuint8(64)`          | `newGame`          | Uniform encrypted random number 0..63 (upper bound must be a power of 2) |
| `FHE.add(x, 1)`               | `newGame`          | Shift to 1..64                                                           |
| `FHE.asEbool`, `FHE.asEuint8` | `newGame`, `guess` | Encrypted constants (`false`, hint codes 0/1/2)                          |
| `FHE.eq`, `FHE.gt`            | `guess`            | Compare the encrypted secret with the plaintext guess                    |
| `FHE.select` (nested)         | `guess`            | Branch-free encrypted hint: correct / higher / lower                     |
| `FHE.or`                      | `guess`            | Encrypted "has the player won" flag                                      |
| `FHE.allowThis`, `FHE.allow`  | everywhere         | ACL: the contract keeps access; only the player may decrypt              |
| `FHE.toBytes32`               | views/events       | Expose handles for the relayer                                           |
| User decryption (relayer SDK) | frontend           | Player-only decryption of hints, win flag and revealed secret            |

---

## Project layout

```
hidden-number/
├─ contracts/HiddenNumber.sol      the game contract
├─ test/HiddenNumber.ts            8 Hardhat tests (FHEVM mock)
├─ deploy/deploy.ts                hardhat-deploy script
├─ hardhat.config.ts               Sepolia via `npx hardhat vars`
├─ frontend/                       Vite + React site (deploy this folder on Vercel)
│  ├─ src/config.js                ← paste your contract address here
│  ├─ src/App.jsx                  game UI
│  ├─ src/fhe.js                   relayer SDK + session-cached decryption permit
│  ├─ src/wallet.js                EIP-6963 multi-wallet picker
│  └─ src/abi.json                 contract ABI (npm run sync-abi after recompiling)
├─ X_POST.md                       launch thread for X
└─ README.md
```

---

## Run the tests

```bash
npm install
npx hardhat test
```

Expected: **8 passing** — new game, guards, higher/lower/correct hints checked against the revealed secret, edge hints
at 1 and 64, max 7 attempts, a non-player cannot decrypt, new game resets, and binary search always wins.

---

## Deploy from GitHub Codespaces (Windows-friendly, nothing to install)

> ⚠️ Use a **fresh test wallet** with no real funds. Its private key goes **only** into `npx hardhat vars set`, which
> stores it outside the project. Never paste it into a file, chat or screenshot.

You need ~0.02 Sepolia ETH on that wallet (faucets: https://cloud.google.com/application/web3/faucet/ethereum/sepolia,
https://sepolia-faucet.pk910.de).

1. Open the repository on GitHub → green **Code** button → **Codespaces** → **Create codespace** (or reuse your existing
   one). In the terminal, make sure you are on the right code (skip `checkout` if this project lives on `main` of its
   own repo):

   ```bash
   git fetch origin
   git checkout hidden-number
   cd hidden-number
   ```

2. Install and test:

   ```bash
   npm install
   npx hardhat test
   ```

3. Store the deployer key (skip if you already did this in the same Codespace for another project — the variables are
   shared by every Hardhat project in that Codespace):

   ```bash
   npx hardhat vars set PRIVATE_KEY
   # optional, a public RPC is used otherwise:
   npx hardhat vars set SEPOLIA_RPC_URL
   ```

4. Deploy:

   ```bash
   npx hardhat deploy --network sepolia
   ```

   Copy the address printed after `HiddenNumber deployed at:`.

5. Paste it into `frontend/src/config.js`:

   ```js
   export const CONTRACT_ADDRESS_FALLBACK = "0xYourAddressHere";
   ```

6. Save to GitHub:

   ```bash
   git add frontend/src/config.js
   git commit -m "Set Hidden Number Sepolia address"
   git push
   ```

7. (Optional) Try the site inside Codespaces: `cd frontend && npm install && npm run dev`, then open the forwarded
   port 5173.

## Put the site online with Vercel

1. https://vercel.com → **Add New… → Project** → import the GitHub repository.
2. **Root Directory**: click **Edit** and choose the folder that contains this project's `frontend`
   (`hidden-number/frontend` inside the sealed-bluff repo, or `frontend` in a standalone `hidden-number` repo).
3. Framework preset: **Vite** (auto-detected from `vercel.json`). Leave build command `npm run build`, output `dist`.
4. Optional: add the environment variable `VITE_CONTRACT_ADDRESS` = your address (overrides `config.js`).
5. **Deploy**. Vercel builds the production branch (usually `main`). If the code is on another branch, either merge it
   into `main`, or set **Settings → Git → Production Branch** to that branch and redeploy.

---

## Play

1. Open the site → **Connect wallet** (the site switches your wallet to Sepolia automatically).
2. **New game** → confirm the transaction.
3. Type a number 1–64 → **Guess** → confirm.
4. **🔓 Decrypt hint** → sign once (no gas) → ⬆ Higher / ⬇ Lower / 🎉 Correct.
5. Repeat. When you win, run out of tries, or give up → **Reveal the number** → **Show the number**.

Freshly computed ciphertexts can take a few seconds to reach the relayer; the site retries automatically.

## License

BSD-3-Clause-Clear (same as the Zama Hardhat template).
