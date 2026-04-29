// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CapsuleRegistry
 * @notice On-chain anchor for State Capsule — records the latest capsule_id
 *         and log_root for each task, enforcing a linear write chain.
 *
 * Write model:
 *   - First write: parent_capsule_id must be bytes32(0).
 *   - Subsequent writes: parent_capsule_id must equal the current latest.
 *   - Any other parent is rejected (stale writer or replay attack).
 *
 * This gives concurrent writers a serialisable linearisation point.
 * The SDK performs a single rebase-and-retry on stale-parent revert.
 */
contract CapsuleRegistry {
    // ── Storage ───────────────────────────────────────────────────────────────

    /// @notice Latest anchored capsule_id per task.
    mapping(bytes32 => bytes32) public latestCapsuleId;

    /// @notice Latest 0G Storage log_root per task (blob root hash of the capsule).
    mapping(bytes32 => bytes32) public latestLogRoot;

    /// @notice Block number of the last anchor per task (replay-attack guard).
    mapping(bytes32 => uint256) public lastAnchoredAt;

    // ── Events ────────────────────────────────────────────────────────────────

    event CapsuleAnchored(
        bytes32 indexed taskId,
        bytes32 indexed capsuleId,
        bytes32 indexed parentCapsuleId,
        bytes32 logRoot,
        address sender,
        uint256 timestamp
    );

    // ── Errors ────────────────────────────────────────────────────────────────

    error StaleParent(bytes32 taskId, bytes32 expected, bytes32 got);
    error ZeroCapsuleId();
    error ZeroTaskId();

    // ── Write ─────────────────────────────────────────────────────────────────

    /**
     * @notice Anchor a capsule update on-chain.
     * @param taskId           keccak256 of the task identifier string.
     * @param parentCapsuleId  capsule_id of the parent (bytes32(0) for genesis).
     * @param newCapsuleId     capsule_id of the new capsule being anchored.
     * @param logRoot          0G Storage blob root hash for this capsule.
     */
    function anchor(
        bytes32 taskId,
        bytes32 parentCapsuleId,
        bytes32 newCapsuleId,
        bytes32 logRoot
    ) external {
        if (taskId     == bytes32(0)) revert ZeroTaskId();
        if (newCapsuleId == bytes32(0)) revert ZeroCapsuleId();

        bytes32 current = latestCapsuleId[taskId];

        // Enforce linear chain: parent must match the current head
        if (current != parentCapsuleId) {
            revert StaleParent(taskId, current, parentCapsuleId);
        }

        latestCapsuleId[taskId]  = newCapsuleId;
        latestLogRoot[taskId]    = logRoot;
        lastAnchoredAt[taskId]   = block.number;

        emit CapsuleAnchored(
            taskId,
            newCapsuleId,
            parentCapsuleId,
            logRoot,
            msg.sender,
            block.timestamp
        );
    }

    // ── Read ──────────────────────────────────────────────────────────────────

    /**
     * @notice Return the current head (capsule_id + log_root) for a task.
     */
    function head(bytes32 taskId)
        external
        view
        returns (bytes32 capsuleId, bytes32 logRoot)
    {
        return (latestCapsuleId[taskId], latestLogRoot[taskId]);
    }
}
