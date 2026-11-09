// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, ebool, euint8, euint16} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title Sealed Bluff — confidential Liar's Dice on the Zama FHEVM
/// @notice 2–6 players, 5 dice each. Dice are rolled on-chain as encrypted values with FHE randomness.
///         Each player can decrypt only their own dice (user decryption). When "Liar!" is called the
///         contract counts the matching dice while they are still encrypted and only the one-bit verdict
///         ("was the bid true?") is made publicly decryptable. Individual dice are never revealed.
contract SealedBluff is ZamaEthereumConfig {
    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------
    uint8 public constant MIN_PLAYERS = 2;
    uint8 public constant MAX_PLAYERS = 6;
    uint8 public constant START_DICE = 5;
    uint32 public constant MIN_TURN_TIMEOUT = 30; // seconds
    uint32 public constant MAX_TURN_TIMEOUT = 1 days;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------
    enum Phase {
        Lobby, // waiting for players to join
        Rolling, // new round: every alive player's cup is being rolled (encrypted)
        Bidding, // players bid in turn, or the player on turn calls "Liar!"
        AwaitingReveal, // the encrypted verdict is publicly decryptable; anyone may resolve
        Finished // one player left with dice
    }

    struct Table {
        address creator;
        uint8 maxPlayers;
        bool onesWild;
        uint32 turnTimeout;
        Phase phase;
        uint32 round;
        uint8 currentTurn; // index into players[] of whoever must act now (Bidding)
        uint8 alivePlayers;
        uint8 rolledCount; // players rolled in the current round
        uint8 totalDice; // dice in play this round (public information)
        uint8 bidQty;
        uint8 bidFace;
        address lastBidder;
        address challenger;
        uint64 turnDeadline;
        address winner;
        ebool verdict; // encrypted "count >= bidQty" — the only value ever made public
        address[] players;
    }

    struct RoundResult {
        uint32 round;
        address bidder;
        address challenger; // for a timeout this is the caller who enforced it
        uint8 bidQty;
        uint8 bidFace;
        bool bidWasTrue;
        bool timeout;
        address loser;
        uint8 loserDiceLeft;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------
    uint256 public tableCount;
    mapping(uint256 => Table) private _tables;
    mapping(uint256 => mapping(address => uint8)) private _diceCount;
    mapping(uint256 => mapping(address => bool)) private _seated;
    mapping(uint256 => mapping(address => uint32)) private _rolledRound;
    mapping(uint256 => mapping(address => euint8[5])) private _dice;
    mapping(uint256 => RoundResult[]) private _history;

    // ---------------------------------------------------------------------
    // Events (one for every action)
    // ---------------------------------------------------------------------
    event TableCreated(
        uint256 indexed tableId,
        address indexed creator,
        uint8 maxPlayers,
        bool onesWild,
        uint32 turnTimeout
    );
    event PlayerJoined(uint256 indexed tableId, address indexed player, uint8 seat);
    event GameStarted(uint256 indexed tableId, uint8 players);
    event RoundStarted(uint256 indexed tableId, uint32 indexed round, address starter, uint8 totalDice);
    event DiceRolled(uint256 indexed tableId, uint32 indexed round, address indexed player, uint8 diceCount);
    event BiddingOpened(uint256 indexed tableId, uint32 indexed round, address firstBidder, uint64 deadline);
    event BidPlaced(uint256 indexed tableId, uint32 indexed round, address indexed bidder, uint8 quantity, uint8 face);
    event LiarCalled(
        uint256 indexed tableId,
        uint32 indexed round,
        address indexed challenger,
        address bidder,
        uint8 quantity,
        uint8 face,
        bytes32 verdictHandle
    );
    event RoundResolved(
        uint256 indexed tableId,
        uint32 indexed round,
        bool bidWasTrue,
        address loser,
        uint8 loserDiceLeft
    );
    event TimeoutPenalty(
        uint256 indexed tableId,
        uint32 indexed round,
        address indexed staller,
        address caller,
        uint8 diceLeft
    );
    event PlayerEliminated(uint256 indexed tableId, address indexed player);
    event GameWon(uint256 indexed tableId, address indexed winner, uint32 rounds);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error TableNotFound();
    error WrongPhase(Phase expected, Phase actual);
    error BadConfig();
    error TableFull();
    error AlreadySeated();
    error NotSeated();
    error NotCreator();
    error NotEnoughPlayers();
    error PlayerOut();
    error AlreadyRolled();
    error NotYourTurn();
    error InvalidBid();
    error BidNotHigher();
    error NoBidYet();
    error TurnNotExpired();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------
    modifier exists(uint256 tableId) {
        if (tableId == 0 || tableId > tableCount) revert TableNotFound();
        _;
    }

    modifier inPhase(uint256 tableId, Phase p) {
        Phase actual = _tables[tableId].phase;
        if (actual != p) revert WrongPhase(p, actual);
        _;
    }

    // ---------------------------------------------------------------------
    // Lobby
    // ---------------------------------------------------------------------

    /// @notice Open a new table. The creator takes seat 0.
    /// @param maxPlayers 2..6
    /// @param onesWild if true, 1s count as any face (except when the bid face is 1 itself)
    /// @param turnTimeout seconds a player has to bid / call before anyone may penalise them
    function createTable(uint8 maxPlayers, bool onesWild, uint32 turnTimeout) external returns (uint256 tableId) {
        if (maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) revert BadConfig();
        if (turnTimeout < MIN_TURN_TIMEOUT || turnTimeout > MAX_TURN_TIMEOUT) revert BadConfig();

        tableId = ++tableCount;
        Table storage t = _tables[tableId];
        t.creator = msg.sender;
        t.maxPlayers = maxPlayers;
        t.onesWild = onesWild;
        t.turnTimeout = turnTimeout;
        t.phase = Phase.Lobby;

        emit TableCreated(tableId, msg.sender, maxPlayers, onesWild, turnTimeout);
        _seat(tableId, msg.sender);
    }

    /// @notice Take a seat at a table that has not started yet.
    function joinTable(uint256 tableId) external exists(tableId) inPhase(tableId, Phase.Lobby) {
        _seat(tableId, msg.sender);
    }

    /// @notice The creator starts the game once at least two players are seated. Round 1 begins.
    function startGame(uint256 tableId) external exists(tableId) inPhase(tableId, Phase.Lobby) {
        Table storage t = _tables[tableId];
        if (msg.sender != t.creator) revert NotCreator();
        if (t.players.length < MIN_PLAYERS) revert NotEnoughPlayers();

        t.alivePlayers = uint8(t.players.length);
        for (uint256 i = 0; i < t.players.length; i++) {
            _diceCount[tableId][t.players[i]] = START_DICE;
        }
        emit GameStarted(tableId, uint8(t.players.length));
        _startRound(tableId, 0);
    }

    // ---------------------------------------------------------------------
    // Rolling
    // ---------------------------------------------------------------------

    /// @notice Roll (encrypted) dice for `player` in the current round.
    /// @dev Anyone may trigger the roll for anyone: the values come from the FHE randomness
    ///      generator, so the caller cannot influence or see them. This means a player can never
    ///      stall the game in the rolling phase. Rolling is split per player to stay well inside
    ///      the per-transaction HCU limit (5 dice ≈ 3.6M HCU).
    function rollDice(uint256 tableId, address player) external exists(tableId) inPhase(tableId, Phase.Rolling) {
        Table storage t = _tables[tableId];
        if (!_seated[tableId][player]) revert NotSeated();
        uint8 n = _diceCount[tableId][player];
        if (n == 0) revert PlayerOut();
        if (_rolledRound[tableId][player] == t.round) revert AlreadyRolled();
        _rolledRound[tableId][player] = t.round;

        euint8[5] storage cup = _dice[tableId][player];
        for (uint8 i = 0; i < START_DICE; i++) {
            if (i < n) {
                // Uniform 16-bit encrypted random value, reduced to 0..5 then shifted to 1..6.
                // (65536 mod 6 = 4, so the modulo bias is < 0.01%.)
                euint16 r = FHE.randEuint16();
                euint8 face = FHE.add(FHE.asEuint8(FHE.rem(r, 6)), 1);
                FHE.allowThis(face); // contract keeps access to count dice later
                FHE.allow(face, player); // only the owner can user-decrypt this die
                cup[i] = face;
            } else {
                cup[i] = euint8.wrap(bytes32(0)); // lost die: empty slot
            }
        }

        emit DiceRolled(tableId, t.round, player, n);

        t.rolledCount += 1;
        if (t.rolledCount == t.alivePlayers) {
            t.phase = Phase.Bidding;
            t.turnDeadline = uint64(block.timestamp) + t.turnTimeout;
            emit BiddingOpened(tableId, t.round, t.players[t.currentTurn], t.turnDeadline);
        }
    }

    // ---------------------------------------------------------------------
    // Bidding
    // ---------------------------------------------------------------------

    /// @notice Bid that at least `quantity` dice on the table show `face`.
    ///         Must be strictly higher than the current bid: more dice, or the same number of a higher face.
    function placeBid(
        uint256 tableId,
        uint8 quantity,
        uint8 face
    ) external exists(tableId) inPhase(tableId, Phase.Bidding) {
        Table storage t = _tables[tableId];
        if (t.players[t.currentTurn] != msg.sender) revert NotYourTurn();
        if (face < 1 || face > 6 || quantity < 1 || quantity > t.totalDice) revert InvalidBid();
        if (!(quantity > t.bidQty || (quantity == t.bidQty && face > t.bidFace))) revert BidNotHigher();

        t.bidQty = quantity;
        t.bidFace = face;
        t.lastBidder = msg.sender;
        t.currentTurn = _nextAlive(tableId, t.currentTurn);
        t.turnDeadline = uint64(block.timestamp) + t.turnTimeout;

        emit BidPlaced(tableId, t.round, msg.sender, quantity, face);
    }

    /// @notice The player on turn challenges the last bid.
    /// @dev Counts matching dice homomorphically: for each die, match = (d == face) [ || d == 1 when wild ],
    ///      count += select(match, 1, 0). Then verdict = (count >= bidQty) as an ebool and ONLY the
    ///      verdict is made publicly decryptable. The count and every die stay encrypted.
    ///      Worst case (30 dice, wild): ~8.3M HCU total, ~2.9M HCU depth — inside the 20M / 5M limits.
    function callLiar(uint256 tableId) external exists(tableId) inPhase(tableId, Phase.Bidding) {
        Table storage t = _tables[tableId];
        if (t.bidQty == 0) revert NoBidYet();
        if (t.players[t.currentTurn] != msg.sender) revert NotYourTurn();

        euint8 count = _countMatches(tableId, t.bidFace, t.onesWild && t.bidFace != 1);

        ebool verdict = FHE.ge(count, t.bidQty);
        FHE.allowThis(verdict);
        FHE.makePubliclyDecryptable(verdict);

        t.verdict = verdict;
        t.challenger = msg.sender;
        t.phase = Phase.AwaitingReveal;

        emit LiarCalled(tableId, t.round, msg.sender, t.lastBidder, t.bidQty, t.bidFace, FHE.toBytes32(verdict));
    }

    // ---------------------------------------------------------------------
    // Resolution (public decryption + on-chain proof check)
    // ---------------------------------------------------------------------

    /// @notice Apply the verdict. Anyone may call this with the result of the relayer's publicDecrypt
    ///         for the verdict handle. The KMS signatures are verified on-chain, so a fake result reverts.
    /// @param bidWasTrue the decrypted verdict (true = at least bidQty dice matched)
    /// @param decryptionProof `decryptionProof` returned by `instance.publicDecrypt([verdictHandle])`
    function resolveChallenge(
        uint256 tableId,
        bool bidWasTrue,
        bytes calldata decryptionProof
    ) external exists(tableId) inPhase(tableId, Phase.AwaitingReveal) {
        Table storage t = _tables[tableId];

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(t.verdict);
        FHE.checkSignatures(handles, abi.encode(bidWasTrue), decryptionProof);

        // Phase change below is the replay protection: the same proof cannot be applied twice.
        address loser = bidWasTrue ? t.challenger : t.lastBidder;
        uint8 left = _loseDie(tableId, loser);

        _history[tableId].push(
            RoundResult({
                round: t.round,
                bidder: t.lastBidder,
                challenger: t.challenger,
                bidQty: t.bidQty,
                bidFace: t.bidFace,
                bidWasTrue: bidWasTrue,
                timeout: false,
                loser: loser,
                loserDiceLeft: left
            })
        );
        emit RoundResolved(tableId, t.round, bidWasTrue, loser, left);

        _afterPenalty(tableId, loser);
    }

    // ---------------------------------------------------------------------
    // Timeout
    // ---------------------------------------------------------------------

    /// @notice If the player on turn has not acted before the deadline, anyone may call this.
    ///         The staller loses one die and a new round (with a fresh roll) begins.
    function claimTimeout(uint256 tableId) external exists(tableId) inPhase(tableId, Phase.Bidding) {
        Table storage t = _tables[tableId];
        if (block.timestamp <= t.turnDeadline) revert TurnNotExpired();

        address staller = t.players[t.currentTurn];
        uint8 left = _loseDie(tableId, staller);

        _history[tableId].push(
            RoundResult({
                round: t.round,
                bidder: t.lastBidder,
                challenger: msg.sender,
                bidQty: t.bidQty,
                bidFace: t.bidFace,
                bidWasTrue: false,
                timeout: true,
                loser: staller,
                loserDiceLeft: left
            })
        );
        emit TimeoutPenalty(tableId, t.round, staller, msg.sender, left);

        _afterPenalty(tableId, staller);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    struct TableView {
        address creator;
        uint8 maxPlayers;
        bool onesWild;
        uint32 turnTimeout;
        Phase phase;
        uint32 round;
        uint8 currentTurn;
        uint8 alivePlayers;
        uint8 totalDice;
        uint8 bidQty;
        uint8 bidFace;
        address lastBidder;
        address challenger;
        uint64 turnDeadline;
        address winner;
        bytes32 verdictHandle;
        uint8 playerCount;
    }

    /// @notice All public state of a table in one call.
    function getTable(uint256 tableId) external view exists(tableId) returns (TableView memory v) {
        Table storage t = _tables[tableId];
        v.creator = t.creator;
        v.maxPlayers = t.maxPlayers;
        v.onesWild = t.onesWild;
        v.turnTimeout = t.turnTimeout;
        v.phase = t.phase;
        v.round = t.round;
        v.currentTurn = t.currentTurn;
        v.alivePlayers = t.alivePlayers;
        v.totalDice = t.totalDice;
        v.bidQty = t.bidQty;
        v.bidFace = t.bidFace;
        v.lastBidder = t.lastBidder;
        v.challenger = t.challenger;
        v.turnDeadline = t.turnDeadline;
        v.winner = t.winner;
        v.verdictHandle = FHE.toBytes32(t.verdict);
        v.playerCount = uint8(t.players.length);
    }

    function getPlayers(
        uint256 tableId
    )
        external
        view
        exists(tableId)
        returns (address[] memory players, uint8[] memory diceCounts, bool[] memory rolled)
    {
        Table storage t = _tables[tableId];
        uint256 n = t.players.length;
        players = t.players;
        diceCounts = new uint8[](n);
        rolled = new bool[](n);
        for (uint256 i = 0; i < n; i++) {
            diceCounts[i] = _diceCount[tableId][t.players[i]];
            rolled[i] = _rolledRound[tableId][t.players[i]] == t.round && t.round > 0;
        }
    }

    /// @notice Encrypted handles of `player`'s current dice. Handles are opaque; only `player`
    ///         (via user decryption) and this contract can use them.
    function getDice(
        uint256 tableId,
        address player
    ) external view exists(tableId) returns (bytes32[5] memory handles) {
        euint8[5] storage cup = _dice[tableId][player];
        for (uint256 i = 0; i < 5; i++) {
            handles[i] = euint8.unwrap(cup[i]);
        }
    }

    function getVerdictHandle(uint256 tableId) external view exists(tableId) returns (bytes32) {
        return FHE.toBytes32(_tables[tableId].verdict);
    }

    function getChallenger(uint256 tableId) external view exists(tableId) returns (address) {
        return _tables[tableId].challenger;
    }

    function getHistory(uint256 tableId) external view exists(tableId) returns (RoundResult[] memory) {
        return _history[tableId];
    }

    function diceCountOf(uint256 tableId, address player) external view returns (uint8) {
        return _diceCount[tableId][player];
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /// @dev Homomorphic count of dice showing `face` (plus 1s if `wild`) across all alive cups.
    function _countMatches(uint256 tableId, uint8 face, bool wild) private returns (euint8 count) {
        address[] storage ps = _tables[tableId].players;
        euint8 one = FHE.asEuint8(1);
        euint8 zero = FHE.asEuint8(0);
        count = zero;
        for (uint256 p = 0; p < ps.length; p++) {
            uint8 n = _diceCount[tableId][ps[p]];
            for (uint8 i = 0; i < n; i++) {
                euint8 d = _dice[tableId][ps[p]][i];
                ebool isMatch = FHE.eq(d, face);
                if (wild) {
                    isMatch = FHE.or(isMatch, FHE.eq(d, uint8(1)));
                }
                count = FHE.add(count, FHE.select(isMatch, one, zero));
            }
        }
    }

    function _seat(uint256 tableId, address player) private {
        Table storage t = _tables[tableId];
        if (_seated[tableId][player]) revert AlreadySeated();
        if (t.players.length >= t.maxPlayers) revert TableFull();
        _seated[tableId][player] = true;
        t.players.push(player);
        emit PlayerJoined(tableId, player, uint8(t.players.length - 1));
    }

    function _startRound(uint256 tableId, uint8 starterIdx) private {
        Table storage t = _tables[tableId];
        t.round += 1;
        t.phase = Phase.Rolling;
        t.rolledCount = 0;
        t.bidQty = 0;
        t.bidFace = 0;
        t.lastBidder = address(0);
        t.challenger = address(0);
        t.currentTurn = starterIdx;

        uint8 total = 0;
        for (uint256 i = 0; i < t.players.length; i++) {
            total += _diceCount[tableId][t.players[i]];
        }
        t.totalDice = total;
        emit RoundStarted(tableId, t.round, t.players[starterIdx], total);
    }

    function _loseDie(uint256 tableId, address player) private returns (uint8 left) {
        left = _diceCount[tableId][player] - 1;
        _diceCount[tableId][player] = left;
        if (left == 0) {
            _tables[tableId].alivePlayers -= 1;
            emit PlayerEliminated(tableId, player);
        }
    }

    /// @dev After a die is lost: either declare a winner or start the next round.
    ///      The player who lost the die opens the next round (or the next alive player if they are out).
    function _afterPenalty(uint256 tableId, address loser) private {
        Table storage t = _tables[tableId];
        if (t.alivePlayers == 1) {
            for (uint256 i = 0; i < t.players.length; i++) {
                if (_diceCount[tableId][t.players[i]] > 0) {
                    t.winner = t.players[i];
                    break;
                }
            }
            t.phase = Phase.Finished;
            emit GameWon(tableId, t.winner, t.round);
            return;
        }
        uint8 idx = _indexOf(tableId, loser);
        uint8 starter = _diceCount[tableId][loser] > 0 ? idx : _nextAlive(tableId, idx);
        _startRound(tableId, starter);
    }

    function _nextAlive(uint256 tableId, uint8 from) private view returns (uint8) {
        Table storage t = _tables[tableId];
        uint256 n = t.players.length;
        for (uint256 step = 1; step <= n; step++) {
            uint8 idx = uint8((uint256(from) + step) % n);
            if (_diceCount[tableId][t.players[idx]] > 0) return idx;
        }
        return from;
    }

    function _indexOf(uint256 tableId, address player) private view returns (uint8) {
        address[] storage ps = _tables[tableId].players;
        for (uint256 i = 0; i < ps.length; i++) {
            if (ps[i] == player) return uint8(i);
        }
        revert NotSeated();
    }
}
