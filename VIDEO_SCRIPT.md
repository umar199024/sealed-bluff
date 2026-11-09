# Sealed Bluff — 3-minute demo video script

Read it in your own voice; it's written to sound natural spoken aloud. Times are approximate (≈150 words/minute).
**Before recording:** have two browser windows ready (Player 1 and Player 2), both connected to Sepolia, a table
already created with both players seated but **not started**, and a second tab with the contract on Etherscan.
Never show MetaMask's private key or secret phrase on screen.

---

### 0:00 – 0:20 · Hook

**Shot:** Your face or the app's home page, logo big. Slow scroll over the title.

> "This is Sealed Bluff — Liar's Dice on a blockchain. And until now, that was impossible.
> Liar's Dice is all about hidden cups. But on a public blockchain, there are no cups — anyone can read the contract
> and see everyone's dice. So I used Zama's Fully Homomorphic Encryption to give the chain a cup."

### 0:20 – 0:45 · The rules, fast

**Shot:** The "How it works" box on the lobby page; point at each line with the cursor.

> "The rules: two to six players, five dice each. You bid things like 'there are at least four threes on the table'.
> Each bid must be higher. If you don't believe it, you call 'Liar!'. If the bid was true, the challenger loses a die;
> if it was a bluff, the bidder does. Last player with dice wins. You can turn on 'ones are wild', and there's a turn
> timer so nobody can stall."

### 0:45 – 1:15 · Encrypted roll + private peek

**Shot:** Player 1 window → **Start game** → **Roll my dice** (MetaMask confirm). Player 2 window → roll.
Then Player 1 → **Peek at my dice** → sign → dice appear. Split screen: Player 2 sees 🔒🔒🔒🔒🔒 for Player 1.

> "When the round starts, the contract rolls the dice itself, using Zama's encrypted random numbers. Nobody picks them
> — not me, not the other player, not the validator.
> Now I peek. My wallet signs a request and Zama's key management re-encrypts my dice just for me. Here they are.
> And here's Player 2's screen: my cup is just locks. Even on Etherscan, my dice are only encrypted handles."

**Shot (2 s):** Etherscan → contract → a `DiceRolled` event showing no values.

### 1:15 – 1:50 · Bluffing + Liar!

**Shot:** Player 1 bids e.g. `3 × ⚄`. Player 2 bids `4 × ⚄`. Player 1 presses the red **LIAR!** button.

> "I open with three fives. Player 2 raises to four fives… I don't believe it. Liar!
> Here's the magic: the contract now counts every five on the table — while all the dice are still encrypted. It
> compares the count to the bid and produces a single encrypted answer: true or false. That one bit is the only thing
> that ever becomes public."

### 1:50 – 2:25 · Reveal with proof

**Shot:** Press **Reveal verdict & resolve** → status messages → MetaMask confirm → Round history line appears
("bid was TRUE / it was a BLUFF … lost a die"). Then Etherscan: the `PublicDecryptionVerified` and `RoundResolved`
events.

> "Anyone can reveal the verdict. The app asks Zama's relayer to decrypt it, and gets back the answer with a
> signature proof from the key management network. The contract checks that proof on-chain with
> `FHE.checkSignatures` — if anyone tried to flip the result, the transaction would fail.
> The verdict is applied, someone loses a die, and a fresh encrypted roll starts the next round. And still — no
> individual die was ever revealed. Not even after the round."

### 2:25 – 2:45 · Under the hood

**Shot:** VS Code / GitHub: `contracts/SealedBluff.sol` scrolled to `callLiar`, then the terminal with
`npx hardhat test` → **10 passing**.

> "Under the hood: one Solidity contract on Sepolia. Dice are encrypted 8-bit numbers, the count uses
> FHE equals, select and add, and the verdict is an encrypted boolean. Ten tests on Zama's mock cover a full game,
> forged proofs, wild ones, timeouts, and a worst-case six-player table that still fits in one transaction."

### 2:45 – 3:00 · Close

**Shot:** Back to the table with the winner crown 👑 (or your face). Show the Vercel URL on screen.

> "Sealed Bluff: the first Liar's Dice where the blockchain keeps your secrets. Link's below — grab a friend and call
> my bluff. Built with Zama."

---

## Shot list (checklist)

| # | Shot | Length |
|---|------|--------|
| 1 | Title / face cam | 0:20 |
| 2 | Lobby "How it works" | 0:25 |
| 3 | Start game, both players roll (MetaMask confirms) | 0:15 |
| 4 | Peek → own dice visible; other screen shows 🔒 | 0:15 |
| 5 | Etherscan `DiceRolled` event (no values) | 0:03 |
| 6 | Bid, raise, **LIAR!** | 0:35 |
| 7 | Reveal & resolve → history line | 0:25 |
| 8 | Etherscan `PublicDecryptionVerified` + `RoundResolved` | 0:08 |
| 9 | Code `callLiar` + `10 passing` | 0:20 |
| 10 | Winner crown + URL | 0:15 |

**Tips:** Sepolia confirmations take ~12 s — cut the waiting in editing. Record at 1080p, zoom the browser to 125 %.
