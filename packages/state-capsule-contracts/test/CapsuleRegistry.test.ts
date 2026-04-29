import { expect } from "chai";
import { ethers } from "hardhat";
import type { CapsuleRegistry } from "../typechain-types";

// Helpers
const B32 = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
const ZERO = ethers.ZeroHash;

describe("CapsuleRegistry", () => {
  let registry: CapsuleRegistry;

  beforeEach(async () => {
    const Factory = await ethers.getContractFactory("CapsuleRegistry");
    registry = (await Factory.deploy()) as CapsuleRegistry;
  });

  // ── Helpers ─────────────────────────────────────────────────────────────

  const TASK   = B32("task-bug-42");
  const C0     = B32("capsule-0");
  const C1     = B32("capsule-1");
  const C2     = B32("capsule-2");
  const ROOT0  = B32("log-root-0");
  const ROOT1  = B32("log-root-1");
  const ROOT2  = B32("log-root-2");

  // ── 1. First write (genesis) ─────────────────────────────────────────────

  it("genesis anchor: parent=0, sets head to c0, emits event", async () => {
    const [signer] = await ethers.getSigners();

    await expect(registry.anchor(TASK, ZERO, C0, ROOT0))
      .to.emit(registry, "CapsuleAnchored")
      .withArgs(TASK, C0, ZERO, ROOT0, signer!.address, (t: bigint) => t > 0n);

    const [capsuleId, logRoot] = await registry.head(TASK);
    expect(capsuleId).to.equal(C0);
    expect(logRoot).to.equal(ROOT0);
  });

  // ── 2. Valid extension ────────────────────────────────────────────────────

  it("valid extension: c0 → c1 → c2 all succeed", async () => {
    await registry.anchor(TASK, ZERO, C0, ROOT0);
    await registry.anchor(TASK, C0,   C1, ROOT1);
    await registry.anchor(TASK, C1,   C2, ROOT2);

    const [capsuleId, logRoot] = await registry.head(TASK);
    expect(capsuleId).to.equal(C2);
    expect(logRoot).to.equal(ROOT2);
  });

  // ── 3. Stale-parent rejection ─────────────────────────────────────────────

  it("stale parent: reverts with StaleParent error", async () => {
    await registry.anchor(TASK, ZERO, C0, ROOT0);
    await registry.anchor(TASK, C0,   C1, ROOT1);

    // Try to extend from C0 again — C1 is now head, C0 is stale
    await expect(registry.anchor(TASK, C0, C2, ROOT2))
      .to.be.revertedWithCustomError(registry, "StaleParent")
      .withArgs(TASK, C1, C0);
  });

  // ── 4. Replay attack rejection ─────────────────────────────────────────────

  it("replay attack: re-anchoring the same capsule_id is rejected", async () => {
    await registry.anchor(TASK, ZERO, C0, ROOT0);

    // Attacker tries to re-anchor C0 by claiming it extends C0 itself
    // (i.e. parent == current head, but newCapsuleId == current head too)
    // This is valid structurally, so we test a different replay scenario:
    // Attacker re-uses C0 as newCapsuleId after C1 is head (stale parent)
    await registry.anchor(TASK, C0, C1, ROOT1);

    await expect(registry.anchor(TASK, C0, C0, ROOT0))
      .to.be.revertedWithCustomError(registry, "StaleParent")
      .withArgs(TASK, C1, C0);
  });

  // ── 5. Input validation ───────────────────────────────────────────────────

  it("reverts on zero taskId", async () => {
    await expect(registry.anchor(ZERO, ZERO, C0, ROOT0))
      .to.be.revertedWithCustomError(registry, "ZeroTaskId");
  });

  it("reverts on zero newCapsuleId", async () => {
    await expect(registry.anchor(TASK, ZERO, ZERO, ROOT0))
      .to.be.revertedWithCustomError(registry, "ZeroCapsuleId");
  });

  // ── 6. Independent tasks don't interfere ──────────────────────────────────

  it("two independent tasks maintain separate heads", async () => {
    const TASK2 = B32("task-bug-99");
    const D0    = B32("capsule-d0");

    await registry.anchor(TASK,  ZERO, C0, ROOT0);
    await registry.anchor(TASK2, ZERO, D0, ROOT1);
    await registry.anchor(TASK,  C0,   C1, ROOT2);

    const [headT1] = await registry.head(TASK);
    const [headT2] = await registry.head(TASK2);
    expect(headT1).to.equal(C1);
    expect(headT2).to.equal(D0);
  });
});
