# X (Twitter) launch post

## Main post (fits in 280 characters)

🎲 Sealed Bluff: Liar's Dice where the blockchain can't see your cup.

Dice are rolled encrypted on @zama FHEVM. Call "Liar!" and the contract counts them still encrypted. Only the verdict is revealed.

Live on Sepolia 👇
[VERCEL LINK]

#FHE #onchaingaming

---

## Longer version (X Premium)

🎲 Introducing Sealed Bluff — Liar's Dice where the blockchain can't peek at your cup.

Built on @zama FHEVM for the Zama Developer Program S5 (Confidential Gaming), live on Sepolia:

🔒 Dice rolled on-chain as encrypted randomness
👁 Only you can decrypt your own dice
🤥 Call "Liar!" → the contract counts matching dice while still encrypted
✅ Only the true/false verdict is revealed, verified on-chain with KMS proofs

Play: [VERCEL LINK]
Code: [GITHUB LINK]

#FHE #Zama #onchaingaming

---

## Optional thread (reply to the main post)

1/ Why can't you play Liar's Dice on a normal blockchain? Everything in contract storage is public. The first player to
open a block explorer sees every cup and the game is over.

2/ With @zama's FHEVM the dice are `euint8` ciphertexts. The contract generates them with `FHE.randEuint16`, gives each
player access to only their own cup, and keeps its own access to count them later.

3/ On "Liar!", the contract runs `FHE.eq` + `FHE.select` + `FHE.add` over every die, then `FHE.ge(count, bid)`. That
single encrypted boolean is the only thing made publicly decryptable. Individual dice are never revealed.

4/ Anyone can reveal it through the Zama relayer and submit it with the KMS signature proof. `FHE.checkSignatures`
rejects forged results. Stallers? A turn timeout lets anyone take a die from them.

5/ 2–6 players, optional wild 1s, fresh encrypted roll every round. Grab a friend and call my bluff 👇
[VERCEL LINK]

---

**Before posting:** replace `[VERCEL LINK]` and `[GITHUB LINK]`, attach the demo video (or a GIF of the 🔒 cups +
LIAR! button), and check the length: the short post fits in 280 characters including a ~23-character link.
