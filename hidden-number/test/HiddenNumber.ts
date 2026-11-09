import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { HiddenNumber, HiddenNumber__factory } from "../types";

const LOWER = 0;
const HIGHER = 1;
const CORRECT = 2;

async function deployFixture() {
  const factory = (await ethers.getContractFactory("HiddenNumber")) as HiddenNumber__factory;
  const game = (await factory.deploy()) as HiddenNumber;
  const address = await game.getAddress();
  return { game, address };
}

describe("HiddenNumber", function () {
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let game: HiddenNumber;
  let address: string;

  before(async function () {
    const all = await ethers.getSigners();
    alice = all[1];
    bob = all[2];
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This hardhat test suite runs on the local FHEVM mock only");
      this.skip();
    }
    ({ game, address } = await deployFixture());
  });

  // ---------------------------------------------------------------- helpers

  async function guessAndDecrypt(p: HardhatEthersSigner, value: number): Promise<number> {
    await (await game.connect(p).guess(value)).wait();
    const g = await game.getGame(p.address);
    const handle = g.hintHandles[g.hintHandles.length - 1];
    return Number(await fhevm.userDecryptEuint(FhevmType.euint8, handle, address, p));
  }

  async function revealAndDecrypt(p: HardhatEthersSigner): Promise<number> {
    await (await game.connect(p).revealSecret()).wait();
    const g = await game.getGame(p.address);
    return Number(await fhevm.userDecryptEuint(FhevmType.euint8, g.secretHandle, address, p));
  }

  /** Binary search over [1, 64] driven ONLY by the decrypted hints. Always finds it in <= 7 guesses. */
  async function binarySearch(p: HardhatEthersSigner): Promise<{ found: number; tries: number }> {
    let lo = 1;
    let hi = 64;
    for (let i = 1; i <= 7; i++) {
      const mid = Math.floor((lo + hi) / 2);
      const hint = await guessAndDecrypt(p, mid);
      if (hint === CORRECT) return { found: mid, tries: i };
      if (hint === HIGHER) lo = mid + 1;
      else hi = mid - 1;
    }
    throw new Error("binary search did not converge in 7 guesses");
  }

  // ---------------------------------------------------------------- tests

  it("newGame starts an active game with 0 attempts and a secret in [1, 64]", async function () {
    await expect(game.connect(alice).newGame()).to.emit(game, "GameStarted").withArgs(alice.address, 1);
    const g = await game.getGame(alice.address);
    expect(g.gameNumber).to.eq(1);
    expect(g.active).to.eq(true);
    expect(g.revealed).to.eq(false);
    expect(g.attempts).to.eq(0);
    expect(g.guesses.length).to.eq(0);
    expect(g.secretHandle).to.eq(ethers.ZeroHash);
    expect(await game.attemptsLeft(alice.address)).to.eq(7);

    const secret = await revealAndDecrypt(alice);
    expect(secret).to.be.gte(1).and.lte(64);
  });

  it("guards: no game, out-of-range guesses", async function () {
    await expect(game.connect(alice).guess(10)).to.be.revertedWithCustomError(game, "NoActiveGame");
    await expect(game.connect(alice).revealSecret()).to.be.revertedWithCustomError(game, "NoActiveGame");
    await (await game.connect(alice).newGame()).wait();
    await expect(game.connect(alice).guess(0)).to.be.revertedWithCustomError(game, "OutOfRange");
    await expect(game.connect(alice).guess(65)).to.be.revertedWithCustomError(game, "OutOfRange");
  });

  it("hints are correct: higher / lower / correct (checked against the revealed secret)", async function () {
    await (await game.connect(alice).newGame()).wait();
    const { found, tries } = await binarySearch(alice);
    expect(tries).to.be.lte(7);

    // The encrypted won flag is user-decryptable by the player and is now true
    const g = await game.getGame(alice.address);
    expect(await fhevm.userDecryptEbool(g.wonHandle, address, alice)).to.eq(true);

    const secret = await revealAndDecrypt(alice);
    expect(secret).to.eq(found);

    // Every hint in the history must agree with the real secret
    const after = await game.getGame(alice.address);
    for (let i = 0; i < after.guesses.length; i++) {
      const guess = Number(after.guesses[i]);
      const hint = Number(await fhevm.userDecryptEuint(FhevmType.euint8, after.hintHandles[i], address, alice));
      const expected = secret === guess ? CORRECT : secret > guess ? HIGHER : LOWER;
      expect(hint, `guess ${guess} vs secret ${secret}`).to.eq(expected);
    }
  });

  it("explicit higher and lower hints at the edges (1 and 64)", async function () {
    await (await game.connect(alice).newGame()).wait();
    const h1 = await guessAndDecrypt(alice, 1);
    const h64 = await guessAndDecrypt(alice, 64);
    const secret = await revealAndDecrypt(alice);
    expect(h1).to.eq(secret === 1 ? CORRECT : HIGHER);
    expect(h64).to.eq(secret === 64 ? CORRECT : LOWER);
  });

  it("max 7 attempts, then reveal ends the game; won flag false when never correct", async function () {
    await (await game.connect(alice).newGame()).wait();
    // Guess 1 first; then keep guessing a value we know is wrong (1 if 1 was wrong, else 2).
    const first = await guessAndDecrypt(alice, 1);
    const wrong = first === CORRECT ? 2 : 1;
    for (let i = 1; i < 7; i++) {
      await expect(game.connect(alice).guess(wrong)).to.emit(game, "Guessed");
    }
    let g = await game.getGame(alice.address);
    expect(g.attempts).to.eq(7);
    expect(g.guesses.length).to.eq(7);
    expect(g.hintHandles.length).to.eq(7);
    expect(await game.attemptsLeft(alice.address)).to.eq(0);
    await expect(game.connect(alice).guess(5)).to.be.revertedWithCustomError(game, "NoAttemptsLeft");

    if (first !== CORRECT) {
      expect(await fhevm.userDecryptEbool(g.wonHandle, address, alice)).to.eq(false);
    }

    await expect(game.connect(alice).revealSecret()).to.emit(game, "SecretRevealed");
    g = await game.getGame(alice.address);
    expect(g.active).to.eq(false);
    expect(g.revealed).to.eq(true);
    await expect(game.connect(alice).guess(5)).to.be.revertedWithCustomError(game, "NoActiveGame");
  });

  it("a non-player cannot decrypt the player's hints, won flag or revealed secret", async function () {
    await (await game.connect(alice).newGame()).wait();
    await (await game.connect(alice).guess(32)).wait();
    await (await game.connect(alice).revealSecret()).wait();
    const g = await game.getGame(alice.address);

    let hintBlocked = false;
    try {
      await fhevm.userDecryptEuint(FhevmType.euint8, g.hintHandles[0], address, bob);
    } catch {
      hintBlocked = true;
    }
    expect(hintBlocked, "bob decrypted alice's hint").to.eq(true);

    let secretBlocked = false;
    try {
      await fhevm.userDecryptEuint(FhevmType.euint8, g.secretHandle, address, bob);
    } catch {
      secretBlocked = true;
    }
    expect(secretBlocked, "bob decrypted alice's secret").to.eq(true);

    let wonBlocked = false;
    try {
      await fhevm.userDecryptEbool(g.wonHandle, address, bob);
    } catch {
      wonBlocked = true;
    }
    expect(wonBlocked, "bob decrypted alice's won flag").to.eq(true);

    // ...while alice can
    const hint = Number(await fhevm.userDecryptEuint(FhevmType.euint8, g.hintHandles[0], address, alice));
    expect([LOWER, HIGHER, CORRECT]).to.include(hint);
  });

  it("newGame resets attempts and history; games are independent per player", async function () {
    await (await game.connect(alice).newGame()).wait();
    await (await game.connect(alice).guess(10)).wait();
    await (await game.connect(alice).guess(20)).wait();
    await (await game.connect(bob).newGame()).wait();
    await (await game.connect(bob).guess(40)).wait();

    await expect(game.connect(alice).newGame()).to.emit(game, "GameStarted").withArgs(alice.address, 2);
    const a = await game.getGame(alice.address);
    expect(a.attempts).to.eq(0);
    expect(a.guesses.length).to.eq(0);
    expect(a.hintHandles.length).to.eq(0);
    expect(a.active).to.eq(true);

    const b = await game.getGame(bob.address);
    expect(b.attempts).to.eq(1);
    expect(Number(b.guesses[0])).to.eq(40);
  });

  it("several random games: binary search always wins within 7 guesses", async function () {
    for (let round = 0; round < 3; round++) {
      await (await game.connect(alice).newGame()).wait();
      const { found } = await binarySearch(alice);
      expect(await revealAndDecrypt(alice)).to.eq(found);
    }
  });
});
