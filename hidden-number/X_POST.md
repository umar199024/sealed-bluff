# X (Twitter) thread — Hidden Number

Replace the placeholders before posting:

- `[VERCEL LINK]` → your live site, e.g. https://hidden-number.vercel.app
- `[GITHUB LINK]` → your repository
- `[CONTRACT LINK]` → https://sepolia.etherscan.io/address/0xYourAddress
- `[VIDEO / GIF]` → optional screen recording attached to post 1

---

**1/**

🔢 Hidden Number — a guessing game where even the blockchain doesn't know the answer.

The secret (1–64) is drawn as encrypted randomness on @zama FHEVM. You get 7 guesses, and only you can read the hints.

Play on Sepolia 👇 [VERCEL LINK]

#ZamaDeveloperProgram

---

**2/**

How it works:

🎲 `FHE.randEuint8(64) + 1` → encrypted secret ⚖️ `FHE.eq` + `FHE.gt` + `FHE.select` → encrypted hint: ⬆ higher / ⬇
lower / 🎉 correct 🔐 `FHE.allow(hint, you)` → only your wallet can decrypt it

No oracle, no commit-reveal, no trusted server.

---

**3/**

On a normal chain the "secret" would sit in storage for anyone to read. Here it's a ciphertext from start to finish.

You sign once per session to decrypt your hints, and at the end the contract can reveal the number — to you only.

---

**4/**

Built for the @zama Developer Program, Season 5 — Confidential Gaming 🎮

One wallet, 7 guesses, and binary search is the winning strategy. Can you find it?

🌐 [VERCEL LINK] 💻 [GITHUB LINK] 📜 [CONTRACT LINK]

#ZamaDeveloperProgram #FHE
