// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, ebool, euint8} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title Hidden Number — a single-player confidential guessing game on the Zama FHEVM
/// @notice The contract draws an encrypted secret between 1 and 64 with on-chain FHE randomness.
///         The player has 7 guesses. Each guess is compared against the secret while it stays
///         encrypted; the result (an encrypted hint: 0 = lower, 1 = higher, 2 = correct) can only be
///         decrypted by the player. Nobody — not the chain, not validators, not the deployer — ever
///         sees the secret, unless the player chooses to reveal it to themself at the end.
contract HiddenNumber is ZamaEthereumConfig {
    uint8 public constant MAX_ATTEMPTS = 7;
    uint8 public constant MAX_NUMBER = 64;

    // Hint codes (encrypted on-chain, decrypted only by the player)
    uint8 public constant HINT_LOWER = 0; // the secret is LOWER than the guess
    uint8 public constant HINT_HIGHER = 1; // the secret is HIGHER than the guess
    uint8 public constant HINT_CORRECT = 2;

    struct Game {
        uint32 gameNumber; // how many games this player has started (1, 2, 3, ...)
        bool active; // a game is in progress (guesses allowed until MAX_ATTEMPTS)
        bool revealed; // the player has asked to reveal the secret (game over)
        uint8 attempts;
        euint8 secret;
        ebool won; // encrypted OR of every (secret == guess)
        uint8[] guesses;
        euint8[] hints;
    }

    struct GameView {
        uint32 gameNumber;
        bool active;
        bool revealed;
        uint8 attempts;
        uint8[] guesses;
        bytes32[] hintHandles;
        bytes32 wonHandle;
        bytes32 secretHandle; // zero until revealed
    }

    mapping(address player => Game) private _games;

    event GameStarted(address indexed player, uint32 indexed gameNumber);
    event Guessed(address indexed player, uint32 indexed gameNumber, uint8 attempt, uint8 guess, bytes32 hintHandle);
    event SecretRevealed(address indexed player, uint32 indexed gameNumber, bytes32 secretHandle);

    error NoActiveGame();
    error OutOfRange();
    error NoAttemptsLeft();

    /// @notice Start a new game (replaces any previous one). Draws an encrypted secret in [1, 64].
    function newGame() external {
        Game storage g = _games[msg.sender];
        g.gameNumber += 1;
        g.active = true;
        g.revealed = false;
        g.attempts = 0;
        delete g.guesses;
        delete g.hints;

        // randEuint8(64) is uniform in [0, 63] (upper bound must be a power of two); +1 => [1, 64]
        euint8 secret = FHE.add(FHE.randEuint8(MAX_NUMBER), 1);
        FHE.allowThis(secret); // the contract keeps access to compare future guesses
        g.secret = secret;

        ebool won = FHE.asEbool(false);
        FHE.allowThis(won);
        FHE.allow(won, msg.sender);
        g.won = won;

        emit GameStarted(msg.sender, g.gameNumber);
    }

    /// @notice Guess a plaintext number in [1, 64]. Stores an encrypted hint only the player can decrypt.
    function guess(uint8 value) external {
        Game storage g = _games[msg.sender];
        if (!g.active) revert NoActiveGame();
        if (value < 1 || value > MAX_NUMBER) revert OutOfRange();
        if (g.attempts >= MAX_ATTEMPTS) revert NoAttemptsLeft();

        ebool isEqual = FHE.eq(g.secret, value);
        ebool isHigher = FHE.gt(g.secret, value);
        euint8 hint = FHE.select(
            isEqual,
            FHE.asEuint8(HINT_CORRECT),
            FHE.select(isHigher, FHE.asEuint8(HINT_HIGHER), FHE.asEuint8(HINT_LOWER))
        );
        FHE.allowThis(hint);
        FHE.allow(hint, msg.sender);

        ebool won = FHE.or(g.won, isEqual);
        FHE.allowThis(won);
        FHE.allow(won, msg.sender);
        g.won = won;

        g.guesses.push(value);
        g.hints.push(hint);
        g.attempts += 1;

        emit Guessed(msg.sender, g.gameNumber, g.attempts, value, FHE.toBytes32(hint));
    }

    /// @notice End the current game and let the player (and only the player) decrypt the secret.
    ///         Can be called at any time — after 7 guesses, after winning, or to give up.
    function revealSecret() external {
        Game storage g = _games[msg.sender];
        if (!g.active) revert NoActiveGame();
        g.active = false;
        g.revealed = true;
        FHE.allow(g.secret, msg.sender);
        emit SecretRevealed(msg.sender, g.gameNumber, FHE.toBytes32(g.secret));
    }

    /// @notice Public view of a player's current game. All hints stay encrypted (handles only).
    function getGame(address player) external view returns (GameView memory v) {
        Game storage g = _games[player];
        v.gameNumber = g.gameNumber;
        v.active = g.active;
        v.revealed = g.revealed;
        v.attempts = g.attempts;
        v.guesses = g.guesses;
        uint256 n = g.hints.length;
        v.hintHandles = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            v.hintHandles[i] = FHE.toBytes32(g.hints[i]);
        }
        v.wonHandle = FHE.toBytes32(g.won);
        v.secretHandle = g.revealed ? FHE.toBytes32(g.secret) : bytes32(0);
    }

    function attemptsLeft(address player) external view returns (uint8) {
        Game storage g = _games[player];
        return g.active ? MAX_ATTEMPTS - g.attempts : 0;
    }
}
