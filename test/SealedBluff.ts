import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers, fhevm } from "hardhat";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { SealedBluff, SealedBluff__factory } from "../types";

// Phase enum mirror
const Phase = { Lobby: 0, Rolling: 1, Bidding: 2, AwaitingReveal: 3, Finished: 4 };
const TIMEOUT = 120; // seconds

type Signers = {
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  carol: HardhatEthersSigner;
  dave: HardhatEthersSigner;
};

async function deployFixture() {
  const factory = (await ethers.getContractFactory("SealedBluff")) as SealedBluff__factory;
  const game = (await factory.deploy()) as SealedBluff;
  const address = await game.getAddress();
  return { game, address };
}

describe("SealedBluff", function () {
  let s: Signers;
  let game: SealedBluff;
  let address: string;

  before(async function () {
    const all = await ethers.getSigners();
    s = { alice: all[1], bob: all[2], carol: all[3], dave: all[4] };
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This hardhat test suite runs on the local FHEVM mock only");
      this.skip();
    }
    ({ game, address } = await deployFixture());
  });

  // ---------------------------------------------------------------- helpers

  async function setupTable(players: HardhatEthersSigner[], onesWild = false): Promise<bigint> {
    await (await game.connect(players[0]).createTable(players.length, onesWild, TIMEOUT)).wait();
    const id = await game.tableCount();
    for (const p of players.slice(1)) {
      await (await game.connect(p).joinTable(id)).wait();
    }
    await (await game.connect(players[0]).startGame(id)).wait();
    return id;
  }

  async function rollAll(id: bigint, players: HardhatEthersSigner[]) {
    for (const p of players) {
      if ((await game.diceCountOf(id, p.address)) > 0n) {
        await (await game.connect(p).rollDice(id, p.address)).wait();
      }
    }
  }

  /** Each player decrypts ONLY their own dice (user decryption). */
  async function myDice(id: bigint, p: HardhatEthersSigner): Promise<number[]> {
    const n = Number(await game.diceCountOf(id, p.address));
    const handles = await game.getDice(id, p.address);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(Number(await fhevm.userDecryptEuint(FhevmType.euint8, handles[i], address, p)));
    }
    return out;
  }

  /** Test-only oracle: actual number of dice matching a face (uses every player's own decryption). */
  async function trueCount(id: bigint, players: HardhatEthersSigner[], face: number, wild: boolean) {
    let c = 0;
    for (const p of players) {
      for (const d of await myDice(id, p)) {
        if (d === face || (wild && face !== 1 && d === 1)) c++;
      }
    }
    return c;
  }

  /** Public decryption of the verdict via the (mock) relayer, then on-chain proof check. */
  async function revealAndResolve(id: bigint, caller: HardhatEthersSigner) {
    const t = await game.getTable(id);
    const handle = t.verdictHandle;
    const res = await fhevm.publicDecrypt([handle]);
    const verdict = res.clearValues[handle as `0x${string}`] as boolean;
    await expect(game.connect(caller).resolveChallenge(id, verdict, res.decryptionProof)).to.emit(
      game,
      "RoundResolved",
    );
    return verdict;
  }

  // ---------------------------------------------------------------- tests

  it("lobby: create, join, guards", async function () {
    await expect(game.connect(s.alice).createTable(1, false, TIMEOUT)).to.be.revertedWithCustomError(game, "BadConfig");
    await expect(game.connect(s.alice).createTable(3, false, 5)).to.be.revertedWithCustomError(game, "BadConfig");

    await expect(game.connect(s.alice).createTable(2, true, TIMEOUT))
      .to.emit(game, "TableCreated")
      .withArgs(1n, s.alice.address, 2, true, TIMEOUT);
    await expect(game.connect(s.alice).joinTable(1)).to.be.revertedWithCustomError(game, "AlreadySeated");
    await expect(game.connect(s.alice).startGame(1)).to.be.revertedWithCustomError(game, "NotEnoughPlayers");
    await expect(game.connect(s.bob).joinTable(1)).to.emit(game, "PlayerJoined").withArgs(1n, s.bob.address, 1);
    await expect(game.connect(s.carol).joinTable(1)).to.be.revertedWithCustomError(game, "TableFull");
    await expect(game.connect(s.bob).startGame(1)).to.be.revertedWithCustomError(game, "NotCreator");
    await expect(game.connect(s.alice).startGame(1)).to.emit(game, "GameStarted").withArgs(1n, 2);

    const t = await game.getTable(1);
    expect(t.phase).to.eq(Phase.Rolling);
    expect(t.round).to.eq(1);
    expect(t.totalDice).to.eq(10);
  });

  it("rolls encrypted dice in 1..6 that only the owner can decrypt", async function () {
    const players = [s.alice, s.bob];
    const id = await setupTable(players);

    await expect(game.connect(s.alice).rollDice(id, s.alice.address))
      .to.emit(game, "DiceRolled")
      .withArgs(id, 1, s.alice.address, 5);
    await expect(game.connect(s.alice).rollDice(id, s.alice.address)).to.be.revertedWithCustomError(
      game,
      "AlreadyRolled",
    );
    // Anyone may trigger someone else's roll (values are FHE-random, caller learns nothing)
    await expect(game.connect(s.alice).rollDice(id, s.bob.address)).to.emit(game, "BiddingOpened");

    const a = await myDice(id, s.alice);
    const b = await myDice(id, s.bob);
    expect(a.length).to.eq(5);
    for (const d of [...a, ...b]) {
      expect(d).to.be.gte(1);
      expect(d).to.be.lte(6);
    }

    // Bob cannot user-decrypt Alice's dice: ACL only grants Alice + the contract.
    const aliceHandles = await game.getDice(id, s.alice.address);
    let failed = false;
    try {
      await fhevm.userDecryptEuint(FhevmType.euint8, aliceHandles[0], address, s.bob);
    } catch {
      failed = true;
    }
    expect(failed, "bob must not be able to decrypt alice's die").to.eq(true);

    // Individual dice are not publicly decryptable either.
    failed = false;
    try {
      await fhevm.publicDecrypt([aliceHandles[0]]);
    } catch {
      failed = true;
    }
    expect(failed, "dice must not be publicly decryptable").to.eq(true);
  });

  it("bidding rules: turn order, strictly higher, bounds", async function () {
    const players = [s.alice, s.bob, s.carol];
    const id = await setupTable(players);
    await expect(game.connect(s.alice).placeBid(id, 1, 2)).to.be.revertedWithCustomError(game, "WrongPhase");
    await rollAll(id, players);

    await expect(game.connect(s.alice).callLiar(id)).to.be.revertedWithCustomError(game, "NoBidYet");
    await expect(game.connect(s.bob).placeBid(id, 2, 3)).to.be.revertedWithCustomError(game, "NotYourTurn");
    await expect(game.connect(s.alice).placeBid(id, 2, 7)).to.be.revertedWithCustomError(game, "InvalidBid");
    await expect(game.connect(s.alice).placeBid(id, 16, 3)).to.be.revertedWithCustomError(game, "InvalidBid");

    await expect(game.connect(s.alice).placeBid(id, 3, 4))
      .to.emit(game, "BidPlaced")
      .withArgs(id, 1, s.alice.address, 3, 4);
    await expect(game.connect(s.bob).placeBid(id, 3, 4)).to.be.revertedWithCustomError(game, "BidNotHigher");
    await expect(game.connect(s.bob).placeBid(id, 3, 2)).to.be.revertedWithCustomError(game, "BidNotHigher");
    await expect(game.connect(s.bob).placeBid(id, 2, 6)).to.be.revertedWithCustomError(game, "BidNotHigher");
    await game.connect(s.bob).placeBid(id, 3, 5); // same qty, higher face: ok
    await game.connect(s.carol).placeBid(id, 4, 1); // higher qty, any face: ok
    const t = await game.getTable(id);
    expect(t.currentTurn).to.eq(0); // back to alice
    expect(t.lastBidder).to.eq(s.carol.address);
  });

  it("full round: join, roll, bid, Liar!, public-decrypt verdict, resolve — correct player loses a die", async function () {
    const players = [s.alice, s.bob];
    const id = await setupTable(players);
    await rollAll(id, players);

    // Alice bids "two 3s"; Bob calls Liar.
    await game.connect(s.alice).placeBid(id, 2, 3);
    const expected = (await trueCount(id, players, 3, false)) >= 2;

    const tx = await game.connect(s.bob).callLiar(id);
    const rc = await tx.wait();
    const ev = rc!.logs
      .map((l) => {
        try {
          return game.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e?.name === "LiarCalled");
    expect(ev, "LiarCalled emitted").to.not.eq(undefined);
    expect(ev!.args.challenger).to.eq(s.bob.address);
    expect(ev!.args.bidder).to.eq(s.alice.address);
    expect((await game.getTable(id)).phase).to.eq(Phase.AwaitingReveal);

    // Anyone (here: carol, a spectator) can resolve with the public decryption proof.
    const verdict = await revealAndResolve(id, s.carol);
    expect(verdict).to.eq(expected);

    const loser = verdict ? s.bob : s.alice;
    const winner = verdict ? s.alice : s.bob;
    expect(await game.diceCountOf(id, loser.address)).to.eq(4);
    expect(await game.diceCountOf(id, winner.address)).to.eq(5);

    // New round with reroll; the loser starts.
    const t = await game.getTable(id);
    expect(t.round).to.eq(2);
    expect(t.phase).to.eq(Phase.Rolling);
    expect(t.totalDice).to.eq(9);
    const [ps] = await game.getPlayers(id);
    expect(ps[Number(t.currentTurn)]).to.eq(loser.address);

    const history = await game.getHistory(id);
    expect(history.length).to.eq(1);
    expect(history[0].bidWasTrue).to.eq(verdict);
    expect(history[0].loser).to.eq(loser.address);
    expect(history[0].bidQty).to.eq(2);
    expect(history[0].bidFace).to.eq(3);

    // Replay protection: the same proof cannot be applied again.
    await expect(game.resolveChallenge(id, verdict, "0x")).to.be.revertedWithCustomError(game, "WrongPhase");
  });

  it("rejects a forged verdict (KMS signature check)", async function () {
    const players = [s.alice, s.bob];
    const id = await setupTable(players);
    await rollAll(id, players);
    await game.connect(s.alice).placeBid(id, 1, 6);
    await game.connect(s.bob).callLiar(id);

    const handle = (await game.getTable(id)).verdictHandle;
    const res = await fhevm.publicDecrypt([handle]);
    const real = res.clearValues[handle as `0x${string}`] as boolean;
    // Flip the answer but reuse the genuine proof -> must revert.
    await expect(game.resolveChallenge(id, !real, res.decryptionProof)).to.be.reverted;
    // Garbage proof -> must revert.
    await expect(game.resolveChallenge(id, real, "0x1234")).to.be.reverted;
    // Real one works.
    await expect(game.resolveChallenge(id, real, res.decryptionProof)).to.emit(game, "RoundResolved");
  });

  it("ones are wild: 1s count toward the bid face", async function () {
    const players = [s.alice, s.bob, s.carol];
    const id = await setupTable(players, true);
    await rollAll(id, players);

    // Pick the bid so the outcome is fully determined by the wild rule.
    const plain = await trueCount(id, players, 5, false);
    const wild = await trueCount(id, players, 5, true);
    const bidQty = Math.max(1, wild);
    await game.connect(s.alice).placeBid(id, bidQty, 5);
    await game.connect(s.bob).callLiar(id);
    const verdict = await revealAndResolve(id, s.dave);
    // The homomorphic verdict must match the wild count, not the plain count.
    expect(verdict).to.eq(wild >= bidQty);
    if (plain < bidQty && wild >= bidQty) {
      // without counting 1s as wild this bid would have been judged a bluff
      expect(verdict).to.eq(true);
    }
    const loser = verdict ? s.bob : s.alice;
    expect(await game.diceCountOf(id, loser.address)).to.eq(4);
  });

  it("turn timeout: anyone can penalise a staller, who loses a die and the round rerolls", async function () {
    const players = [s.alice, s.bob];
    const id = await setupTable(players);
    await rollAll(id, players);
    await game.connect(s.alice).placeBid(id, 2, 4);

    // Bob is on turn and stalls.
    await expect(game.connect(s.carol).claimTimeout(id)).to.be.revertedWithCustomError(game, "TurnNotExpired");
    await time.increase(TIMEOUT + 1);
    await expect(game.connect(s.carol).claimTimeout(id))
      .to.emit(game, "TimeoutPenalty")
      .withArgs(id, 1, s.bob.address, s.carol.address, 4);

    expect(await game.diceCountOf(id, s.bob.address)).to.eq(4);
    const t = await game.getTable(id);
    expect(t.round).to.eq(2);
    expect(t.phase).to.eq(Phase.Rolling);
    const h = await game.getHistory(id);
    expect(h[0].timeout).to.eq(true);
    expect(h[0].loser).to.eq(s.bob.address);
  });

  it("plays a whole game until one player is left with dice (winner)", async function () {
    this.timeout(600_000);
    const players = [s.alice, s.bob];
    const id = await setupTable(players);
    const byAddr = new Map(players.map((p) => [p.address, p]));

    let rounds = 0;
    while ((await game.getTable(id)).phase !== BigInt(Phase.Finished)) {
      rounds++;
      await rollAll(id, players);
      const t = await game.getTable(id);
      const [ps] = await game.getPlayers(id);
      const opener = byAddr.get(ps[Number(t.currentTurn)])!;
      const responder = opener === s.alice ? s.bob : s.alice;

      // Opener bids "one 6", responder calls Liar every round.
      await game.connect(opener).placeBid(id, 1, 6);
      const expected = (await trueCount(id, players, 6, false)) >= 1;
      await game.connect(responder).callLiar(id);
      const verdict = await revealAndResolve(id, opener);
      expect(verdict).to.eq(expected);
      expect(rounds).to.be.lte(9);
    }

    const t = await game.getTable(id);
    expect(t.phase).to.eq(Phase.Finished);
    const winnerDice = await game.diceCountOf(id, t.winner);
    const loser = players.find((p) => p.address !== t.winner)!;
    expect(winnerDice).to.be.gt(0);
    expect(await game.diceCountOf(id, loser.address)).to.eq(0);
    expect((await game.getHistory(id)).length).to.eq(rounds);
    // loser lost all 5 dice, winner lost (5 - winnerDice): one die lost per round
    expect(rounds).to.eq(5 + (5 - Number(winnerDice)));
    await expect(game.connect(s.alice).placeBid(id, 1, 2)).to.be.revertedWithCustomError(game, "WrongPhase");
  });

  it("eliminated players are skipped; 3-player game ends with GameWon via timeouts", async function () {
    this.timeout(600_000);
    const players = [s.alice, s.bob, s.carol];
    const id = await setupTable(players);

    // Repeatedly time out whoever's turn it is after the opener bids.
    let guard = 0;
    while ((await game.getTable(id)).phase !== BigInt(Phase.Finished) && guard++ < 20) {
      await rollAll(id, players);
      await time.increase(TIMEOUT + 1);
      const tx = await game.connect(s.dave).claimTimeout(id);
      await tx.wait();
    }
    const t = await game.getTable(id);
    expect(t.phase).to.eq(Phase.Finished);
    const [ps, counts] = await game.getPlayers(id);
    const alive = ps.filter((_, i) => counts[i] > 0n);
    expect(alive.length).to.eq(1);
    expect(alive[0]).to.eq(t.winner);
  });
  it("worst case: 6 players x 5 dice with 1s wild — roll + Liar! fit in one tx each (HCU/gas)", async function () {
    this.timeout(600_000);
    const all = await ethers.getSigners();
    const players = all.slice(1, 7);
    const id = await setupTable(players, true);
    let maxRollGas = 0n;
    for (const p of players) {
      const rc = await (await game.connect(p).rollDice(id, p.address)).wait();
      if (rc!.gasUsed > maxRollGas) maxRollGas = rc!.gasUsed;
    }
    await game.connect(players[0]).placeBid(id, 10, 4);
    const expected = (await trueCount(id, players, 4, true)) >= 10;
    const rc = await (await game.connect(players[1]).callLiar(id)).wait();
    console.log(`      gas: rollDice(5 dice) max ${maxRollGas}, callLiar(30 dice, wild) ${rc!.gasUsed}`);
    expect(rc!.gasUsed).to.be.lt(16_000_000n); // under the per-tx gas cap (EIP-7825)
    const verdict = await revealAndResolve(id, players[2]);
    expect(verdict).to.eq(expected);
  });
});
