# Sealed Bluff — Deploy Guide (no coding needed)

This guide takes you from a zip file to a live game on the internet. Go slowly, one step at a time.
Total time: about 45–60 minutes. Everything is free (Sepolia is a test network; its ETH has no value).

You will use:

- **MetaMask** — your crypto wallet in the browser
- **GitHub** — stores the project files
- **GitHub Codespaces** — a computer in the cloud where you type commands (no install on your PC)
- **Vercel** — puts the website online

---

## ⚠️ Read this first — safety

> **Use a brand-new MetaMask account that has NO real money in it.**
>
> In Step 6 you will copy a **private key** (or a 12-word **secret phrase**) into Codespaces so it can deploy the
> contract for you. Anyone who has this key controls that wallet.
>
> - **Never** use the wallet that holds your real crypto.
> - **Never** share the key or phrase with anybody — not in chat, not in a screenshot, not in your video.
> - **Never** paste it into a file that gets uploaded to GitHub. In this guide it goes only into the
>   `npx hardhat vars set` command, which stores it outside the project.
> - Nobody from Zama, GitHub or Vercel will ever ask for it.

---

## Step 1 — Set up MetaMask and Sepolia

1. Install MetaMask from **https://metamask.io** (browser extension). Create a wallet if you don't have one.
2. Create a **fresh test account**: click the account name at the top → **Add account or hardware wallet** →
   **Add a new account** → name it `Sealed Bluff Deployer`.
3. Turn on test networks: click the network menu (top left) → switch on **Show test networks** → choose **Sepolia**.
4. Create a **second** test account the same way and name it `Player 2`. You'll use it to play against yourself in
   Step 11.

## Step 2 — Get free Sepolia ETH (a "faucet")

You need test ETH to pay for transactions. Copy your `Sealed Bluff Deployer` address (click it in MetaMask to copy)
and paste it into one of these faucets:

- **Google Cloud faucet:** https://cloud.google.com/application/web3/faucet/ethereum/sepolia (sign in with Google)
- **PoW faucet (no sign-in):** https://sepolia-faucet.pk910.de (leave the tab open a few minutes)
- **Alchemy faucet:** https://www.alchemy.com/faucets/ethereum-sepolia

Aim for **0.1 Sepolia ETH or more** on the deployer. Then send about **0.05** to `Player 2` (MetaMask → Send →
choose Player 2). Each player pays a little gas for every move.

## Step 3 — Put the project on GitHub

1. Go to **https://github.com** and sign in (or create a free account).
2. Click **+** (top right) → **New repository**.
   - Name: `sealed-bluff`
   - Public
   - Tick **Add a README file**
   - Click **Create repository**.
3. On the new repository page click the green **Code** button → **Codespaces** tab → **Create codespace on main**.
   A new tab opens with an editor (it looks like VS Code). Wait until it finishes loading — about 1 minute.
4. On the left side you see the file list (Explorer). **Drag the file `sealed-bluff.zip` from your computer into that
   file list.** Wait for it to appear.
5. At the bottom there is a **Terminal**. (If you don't see it: menu ☰ → Terminal → New Terminal.)
   Click inside it and paste these commands one at a time, pressing **Enter** after each:

   ```bash
   unzip -o sealed-bluff.zip
   cp -r sealed-bluff/. .
   rm -rf sealed-bluff sealed-bluff.zip
   ls
   ```

   You should now see folders such as `contracts`, `frontend`, `test`, and files such as `hardhat.config.ts`.
6. Save it to GitHub:

   ```bash
   git add .
   git commit -m "Sealed Bluff"
   git push
   ```

   (Pasting in the terminal: right-click → Paste, or Ctrl+Shift+V / Cmd+V.)

## Step 4 — Install and test (in the same Codespaces terminal)

```bash
npm install
```

This takes 1–3 minutes. Yellow "warn" lines are normal. Then:

```bash
npx hardhat compile
npx hardhat test
```

At the end you should see **`10 passing`**. 🎉 This proves the game logic works with encryption on a simulated chain.

## Step 5 — Copy your private key from MetaMask

In MetaMask, select the `Sealed Bluff Deployer` account → **⋮** (three dots) → **Account details** →
**Show private key** (or **Details → Private keys**) → enter your MetaMask password → copy it.

> Remember: this is the **fresh test account**, never your real one.

## Step 6 — Give the key to Hardhat (safely)

In the Codespaces terminal run:

```bash
npx hardhat vars set PRIVATE_KEY
```

It asks `Enter value:` — paste the private key and press **Enter**. (Nothing shows while you paste; that's fine.)
This is saved in a private settings file of the Codespace, **not** in your project and **not** on GitHub.

<details>
<summary>Prefer a 12-word secret phrase instead of a private key?</summary>

Use `npx hardhat vars set MNEMONIC` instead and paste the 12 words separated by single spaces. The deployer will be
the **first** account of that phrase. Only do this with a phrase created just for testing. Do not set both — if
`PRIVATE_KEY` is set it wins.
</details>

### Optional: your own RPC (connection to Sepolia)

The project already uses a free public Sepolia connection. If deployment says "timeout" or "rate limited", get a free
key from **https://www.infura.io** (or Alchemy) and run **one** of these:

```bash
npx hardhat vars set INFURA_API_KEY
# or a full URL from any provider:
npx hardhat vars set SEPOLIA_RPC_URL
```

Check what you've set (it only shows the names, not the secrets):

```bash
npx hardhat vars list
```

## Step 7 — Deploy the contract to Sepolia

```bash
npx hardhat deploy --network sepolia
```

Wait 30–90 seconds. You will see something like:

```
Deployer: 0xAbC…
Balance:  0.1 ETH
deploying "SealedBluff" ...: deployed at 0x1234...ABCD with 3274280 gas
==============================================================
  SealedBluff deployed at: 0x1234567890abcdef1234567890ABCDEF12345678
```

**Copy that address** (the `0x…` after "deployed at") and paste it somewhere safe, e.g. a note. It is public — fine
to share.

Problems?
- `insufficient funds` → get more Sepolia ETH (Step 2) for the deployer address shown.
- `timeout` / `429` → set an RPC (end of Step 6) and run the deploy command again.

You can double-check it on Etherscan: `https://sepolia.etherscan.io/address/YOUR_ADDRESS`.

## Step 8 — Put the address into the website

**Easiest way (recommended):** you'll type it into Vercel in Step 9. Nothing to edit here.

**Also good (so it's saved in the code):** in the Codespace file list open `frontend` → `src` → `config.js`. Find:

```js
export const CONTRACT_ADDRESS_FALLBACK = "0x0000000000000000000000000000000000000000";
```

Replace the zeros with your address (keep the quotes), save (Ctrl+S / Cmd+S), then in the terminal:

```bash
git add .
git commit -m "Set contract address"
git push
```

## Step 9 — Put the website online with Vercel

1. Go to **https://vercel.com** → **Sign up / Log in with GitHub**.
2. Click **Add New… → Project** → find `sealed-bluff` → **Import**.
3. **Root Directory:** click **Edit** and choose **`frontend`**. ← important
4. Framework Preset: **Vite** (it should pick it automatically). Leave build settings as they are.
5. Open **Environment Variables** and add:
   - Name: `VITE_CONTRACT_ADDRESS`
   - Value: your contract address from Step 7
6. Click **Deploy**. After about a minute you get a link like `https://sealed-bluff-xyz.vercel.app`. 🎉

If you change the address later: Vercel → your project → **Settings → Environment Variables** → edit →
then **Deployments → ⋮ → Redeploy**.

## Step 10 — Open the game

Open your Vercel link. Click **Connect MetaMask**, approve, and approve the switch to **Sepolia** if asked.
Top right should show your address and, after a few seconds, **FHE ready**.

## Step 11 — Test a full round with two wallets

The simplest way: use **two browser windows** — your normal one, and a second browser (or a second Chrome profile)
with MetaMask holding `Player 2`. You can also use one browser and switch accounts in MetaMask between moves (the page
follows the account you pick).

1. **Player 1 (Deployer):** choose **2 players**, leave **1s are wild** ticked, timeout **5 minutes** →
   **Create table** → confirm in MetaMask. The table page opens. Click **copy invite link**.
2. **Player 2:** open the invite link → **Connect MetaMask** → **Join this table** → confirm.
3. **Player 1:** **Start game** → confirm.
4. **Each player:** click **🎲 Roll my dice** → confirm. (Anyone may also press "Roll for them" — nobody can choose or
   see the result.)
5. **Each player:** click **👁 Peek at my dice**. MetaMask asks you to **sign** a message (free, no gas) — this
   proves to Zama it's really you. Your 5 dice appear; the other cup shows 🔒🔒🔒🔒🔒. The first time can take ~10–30 s.
6. **Whoever is on turn** (yellow outline): choose a quantity and a face, e.g. `2 × ⚂`, then **Bid**.
7. **Other player:** either bid higher, or press **LIAR!**.
8. After Liar!, anyone presses **Reveal verdict & resolve**. The app asks the Zama relayer for the encrypted verdict's
   public decryption, then sends it with the proof. (If it says "not ready yet", it retries by itself.)
9. Look at **Round history**: it says whether the bid was TRUE or a BLUFF and who lost a die. A new round starts —
   roll again.
10. Keep going until one player has no dice. The winner gets a 👑.

**Try the timeout:** create a table with a **1 minute** timeout, place a bid, then wait. After the countdown goes red,
the other player sees **⏰ Penalise staller** — press it and the staller loses a die.

## You're done ✅

Things to save for your submission:

- GitHub repository link
- Vercel website link
- Contract address + Etherscan link: `https://sepolia.etherscan.io/address/YOUR_ADDRESS`

### Troubleshooting

| Problem | Fix |
|---|---|
| "No contract address configured" on the site | Set `VITE_CONTRACT_ADDRESS` in Vercel and **Redeploy**, or edit `config.js` (Step 8). |
| MetaMask on the wrong network | Click **Switch to Sepolia** at the top of the page. |
| "FHE loading…" never turns green | Refresh the page; check your internet; try another browser (Chrome / Brave / Firefox). |
| "Could not decrypt your dice" | Wait 20 seconds and press Peek again. Make sure you've rolled this round. |
| "Contract said: NotYourTurn" | Wait for your turn (yellow outline around your seat). |
| "Contract said: BidNotHigher" | Raise the quantity, or keep it and pick a higher face. |
| Transactions fail with "insufficient funds" | Get more Sepolia ETH from a faucet (Step 2). |
| Codespace closed | github.com → your repo → **Code → Codespaces** → click the existing one. Your `vars` are still there. |
