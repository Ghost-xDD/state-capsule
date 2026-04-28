/**
 * single-process-resume.test.ts
 *
 * Phase 1 smoke test — proves the kill-and-resume primitive works
 * end-to-end using in-memory storage (no real 0G needed for this test).
 *
 * What this proves:
 *   - createCapsule produces a valid signed capsule
 *   - updateCapsule extends the chain correctly
 *   - restoreCapsule retrieves the latest head from a fresh client
 *     (simulating a process that has never seen the task before)
 *   - verifyHandoff validates the full signature chain
 *   - migrations.ts handles same-version pass-through
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  StateCapsule,
  createMemoryStorage,
  verifyCapsuleSignature,
  generateKeyPair,
  toHex,
  migrate,
  SCHEMA_VERSION,
} from "../src/index.js";
import type { Capsule } from "../src/index.js";

// ── Shared storage so both clients see the same state ────────────────────────
// This simulates the shared 0G Storage backend.

describe("Phase 1 — single-process resume", () => {
  const sharedStorage = createMemoryStorage();

  const agentA = new StateCapsule({ storageAdapter: sharedStorage });
  // agentB uses the SAME storage but is a completely separate client instance
  // with its own key — simulates a fresh process that restores from storage.
  const agentB = new StateCapsule({ storageAdapter: sharedStorage });

  const TASK_ID = `test-task-${Date.now()}`;
  const capsules: Capsule[] = [];

  it("createCapsule — genesis capsule is valid and signed", async () => {
    const c0 = await agentA.createCapsule({
      task_id:         TASK_ID,
      goal:            "Fix async race condition in queue.js",
      holder:          "triager",
      facts:           ["failing test: queue.test.js:42"],
      constraints:     ["do not break the public API"],
      pending_actions: ["reproduce the race", "apply mutex patch"],
      next_action:     "reproduce the race",
    });

    capsules.push(c0);

    expect(c0.task_id).toBe(TASK_ID);
    expect(c0.schema_version).toBe(SCHEMA_VERSION);
    expect(c0.parent_capsule_id).toBeNull();
    expect(c0.capsule_id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(c0.signature).toMatch(/^0x/);

    // Signature must be valid
    const { signature, ...signable } = c0;
    expect(verifyCapsuleSignature(signable, signature, c0.created_by)).toBe(true);
  });

  it("updateCapsule × 3 — extends chain with correct parent links", async () => {
    const c1 = await agentA.updateCapsule({
      task_id:           TASK_ID,
      parent_capsule_id: capsules[0]!.capsule_id,
      holder:            "reproducer",
      facts:             [
        "failing test: queue.test.js:42",
        "race window: 12-15ms",
        "failing seed: 42",
      ],
      next_action: "narrow failure window",
    });
    capsules.push(c1);

    const c2 = await agentA.updateCapsule({
      task_id:           TASK_ID,
      parent_capsule_id: c1.capsule_id,
      holder:            "reproducer",
      decisions:         ["use mutex lock on dequeue"],
      next_action:       "apply mutex patch",
    });
    capsules.push(c2);

    const c3 = await agentA.updateCapsule({
      task_id:           TASK_ID,
      parent_capsule_id: c2.capsule_id,
      holder:            "patcher",
      pending_actions:   ["apply mutex patch", "rerun failing test"],
      next_action:       "apply mutex patch",
    });
    capsules.push(c3);

    expect(capsules).toHaveLength(4);
    expect(capsules[1]!.parent_capsule_id).toBe(capsules[0]!.capsule_id);
    expect(capsules[2]!.parent_capsule_id).toBe(capsules[1]!.capsule_id);
    expect(capsules[3]!.parent_capsule_id).toBe(capsules[2]!.capsule_id);

    // All capsule IDs must be distinct
    const ids = capsules.map((c) => c.capsule_id);
    expect(new Set(ids).size).toBe(4);
  });

  it("restoreCapsule — fresh client (agentB) retrieves c3 from storage", async () => {
    // agentB has never seen this task — it only has access to shared storage
    const restored = await agentB.restoreCapsule(TASK_ID);

    expect(restored.capsule_id).toBe(capsules[3]!.capsule_id);
    expect(restored.task_id).toBe(TASK_ID);
    expect(restored.holder).toBe("patcher");
    expect(restored.decisions).toContain("use mutex lock on dequeue");
    expect(restored.facts).toContain("race window: 12-15ms");

    // Signature on the restored capsule is valid
    const { signature, ...signable } = restored;
    expect(
      verifyCapsuleSignature(signable, signature, restored.created_by)
    ).toBe(true);
  });

  it("verifyHandoff — full signature chain from c0 to c3 is valid", async () => {
    const valid = await agentA.verifyHandoff(capsules);
    expect(valid).toBe(true);
  });

  it("verifyHandoff — tampered chain fails verification", async () => {
    const tampered = capsules.map((c, i) =>
      i === 1 ? { ...c, facts: ["TAMPERED"] } : c
    );
    const valid = await agentA.verifyHandoff(tampered);
    expect(valid).toBe(false);
  });

  it("verifyHandoff — broken parent link fails verification", async () => {
    const broken = [...capsules];
    broken[2] = { ...broken[2]!, parent_capsule_id: "0x" + "aa".repeat(32) };
    const valid = await agentA.verifyHandoff(broken);
    expect(valid).toBe(false);
  });

  it("migrations — same-version capsule passes through unchanged", () => {
    const raw = { schema_version: SCHEMA_VERSION, task_id: "t1", goal: "g" };
    const result = migrate(raw as Record<string, unknown>);
    expect(result).toBe(raw); // same reference — no migration ran
  });

  it("schema — capsule_id is deterministic (same payload → same id)", async () => {
    const { deriveCapsuleId } = await import("../src/sign.js");
    const payload = {
      capsule_id:        "0x" + "00".repeat(32),
      task_id:           "determinism-test",
      schema_version:    SCHEMA_VERSION,
      parent_capsule_id: null,
      created_by:        "0x" + "aa".repeat(32),
      created_at:        "2026-04-28T00:00:00.000Z",
      goal:              "test",
      facts:             [],
      constraints:       [],
      decisions:         [],
      pending_actions:   [],
      next_action:       "",
      counterparties:    [],
      log_root:          null,
      holder:            "triager",
    };
    const id1 = await deriveCapsuleId(payload);
    const id2 = await deriveCapsuleId(payload);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
