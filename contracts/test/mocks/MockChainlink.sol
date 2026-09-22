// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Settable Chainlink AggregatorV3 price feed.
contract MockAggregatorV3 {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId = 1;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function set(int256 answer_) external {
        answer = answer_;
        updatedAt = block.timestamp;
        roundId++;
    }

    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}

/// @dev Settable Chainlink L2 sequencer uptime feed: answer 0 = up, 1 = down; startedAt = since when.
contract MockSequencerFeed {
    int256 public answer;
    uint256 public startedAt;

    constructor() {
        startedAt = block.timestamp;
    }

    function set(bool down, uint256 since) external {
        answer = down ? int256(1) : int256(0);
        startedAt = since;
    }

    function decimals() external pure returns (uint8) {
        return 0;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, startedAt, startedAt, 1);
    }
}
