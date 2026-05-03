/**
 * phase5.test.ts — Kill-and-resume unit tests.
 *
 * What this covers:
 *   1. Reproducer step-1 checkpoint is written when a checkpoint fn is provided
 *   2. Reproducer resumes from "planning-done" checkpoint (skips step 1 LLM call)
 *   3. Reproducer completes the full 2-step flow in a single run (no kill)
 *   4. fetchSealedSummary falls back gracefully when 0G Compute is not configured
 *   5. fetchSealedSummary local fallback returns expected shape
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Mock callLLM ──────────────────────────────────────────────────────────────

vi.mock("../src/llm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm.js")>();
  return { ...actual, callLLM: vi.fn() };
});

// ── Imports ───────────────────────────────────────────────────────────────────

import { StateCapsule, createMemoryStorage, fetchSealedSummary } from "@ghostxd/state-capsule-sdk";
import type { Capsule }       from "@ghostxd/state-capsule-sdk";
import type { CapsuleEnvelope } from "@ghostxd/state-capsule-sdk";
import { callLLM }            from "../src/llm.js";
import { reproducerHandler }  from "../src/handlers/reproducer.js";
import type { HandlerContext, CheckpointFn } from "../src/runtime.js";

// ── Golden responses ──────────────────────────────────────────────────────────

const GOLDEN_PLAN = {
  approach:   "test each function with minimal inputs that expose the defect",
  test_cases: [
    {
      bug_id:          "bug-1",
      function_name:   "memoizeAsync",
      trigger_input:   "two concurrent calls with the same key",
      expected_output: "fn called once, both results equal",
      actual_output:   "fn called twice due to race",
    },
    {
      bug_id:          "bug-2",
      function_name:   "chunk",
      trigger_input:   "chunk([1,2,3,4], 2)",
      expected_output: "[[1,2],[3,4]]",
      actual_output:   "[[1],[3]]",
    },
    {
      bug_id:          "bug-3",
      function_name:   "partition",
      trigger_input:   "partition([1,2,3,4], n => n%2===0)",
      expected_output: "[[2,4],[1,3]]",
      actual_output:   "[[1,3],[2,4]]",
    },
  ],
};

const GOLDEN_TESTS = {
  tests: [
    {
      bug_id:    "bug-1",
      test_name: "memoizeAsync: concurrent calls must not duplicate fn",
      code:      "import assert from 'node:assert'; assert.ok(true);",
    },
    {
      bug_id:    "bug-2",
      test_name: "chunk: slice end must be i+size not i+size-1",
      code:      "import assert from 'node:assert'; assert.ok(true);",
    },
    {
      bug_id:    "bug-3",
      test_name: "partition: matching items must go to pass bucket",
      code:      "import assert from 'node:assert'; assert.ok(true);",
    },
  ],
};

const GOLDEN_BUGS_FACT = JSON.stringify({
  bugs: [
    { id: "bug-1", name: "async-race",      location: "memoizeAsync", description: "race", reproduction_hint: "concurrent calls" },
    { id: "bug-2", name: "off-by-one",      location: "chunk",        description: "slice -1", reproduction_hint: "chunk([1,2,3,4],2)" },
    { id: "bug-3", name: "logic-inversion", location: "partition",    description: "swapped", reproduction_hint: "partition evens" },
  ],
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEnvelope(taskId: string, capsuleId: string): CapsuleEnvelope {
  return { type: "capsule.handoff", task_id: taskId, capsule_id: capsuleId, holder: "triager", sent_at: new Date().toISOString() };
}

function makeCtx(
  capsule: Capsule,
  checkpoint?: CheckpointFn,
): HandlerContext {
  return {
    capsule,
    role:     "reproducer",
    envelope: makeEnvelope(capsule.task_id, capsule.capsule_id),
    checkpoint,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 5 — kill-and-resume", () => {
  beforeEach(() => { vi.resetAllMocks(); });

  // ── 1. Full 2-step flow with checkpoint ────────────────────────────────────

  it("full run: writes planning checkpoint then tests; callLLM called twice", async () => {
    const TASK_ID = `p5-full-${Date.now()}`;
    const storage = createMemoryStorage();
    const sdk     = new StateCapsule({ storageAdapter: storage });

    vi.mocked(callLLM)
      .mockResolvedValueOnce(JSON.stringify(GOLDEN_PLAN))   // step 1: plan
      .mockResolvedValueOnce(JSON.stringify(GOLDEN_TESTS)); // step 2: tests

    const genesis = await sdk.createCapsule({
      task_id: TASK_ID,
      goal:    "Fix buggy-utils",
      holder:  "triager",
      facts:   [`[triager:bugs] ${GOLDEN_BUGS_FACT}`],
    });

    // Track all checkpoint calls.
    const checkpoints: Array<Capsule> = [];
    const checkpoint: CheckpointFn = async (update) => {
      const persisted = await sdk.updateCapsule({
        task_id:           TASK_ID,
        parent_capsule_id: genesis.capsule_id,
        ...update,
      });
      checkpoints.push(persisted);
      return persisted;
    };

    const result = await reproducerHandler(makeCtx(genesis, checkpoint));

    // Step 1 LLM: plan — Step 2 LLM: tests
    expect(vi.mocked(callLLM)).toHaveBeenCalledTimes(2);

    const planCallTag = (vi.mocked(callLLM).mock.calls[0]![0] as { tag: string }).tag;
    const testCallTag = (vi.mocked(callLLM).mock.calls[1]![0] as { tag: string }).tag;
    expect(planCallTag).toMatch(/reproducer:plan:/);
    expect(testCallTag).toMatch(/^reproducer:/);
    expect(testCallTag).not.toMatch(/plan/);

    // Checkpoint was called exactly once (after step 1).
    expect(checkpoints).toHaveLength(1);
    const checkpointFacts = checkpoints[0]!.facts;
    expect(checkpointFacts.some((f) => f.includes("[reproducer:step] planning-done"))).toBe(true);
    expect(checkpointFacts.some((f) => f.startsWith("[reproducer:plan]"))).toBe(true);

    // Final result has step=tests-written and the tests fact.
    expect(result.next_holder).toBe("patcher");
    const finalFacts = result.update.facts ?? [];
    expect(finalFacts.some((f) => f.includes("[reproducer:step] tests-written"))).toBe(true);
    expect(finalFacts.some((f) => f.startsWith("[reproducer:tests]"))).toBe(true);
  });

  // ── 2. Resume from planning-done checkpoint ────────────────────────────────

  it("resume: skips step 1 (planning-done in facts); callLLM called once", async () => {
    const TASK_ID = `p5-resume-${Date.now()}`;
    const storage = createMemoryStorage();
    const sdk     = new StateCapsule({ storageAdapter: storage });

    // Only the tests LLM response is needed on resume.
    vi.mocked(callLLM).mockResolvedValueOnce(JSON.stringify(GOLDEN_TESTS));

    // Create a capsule that already has the step-1 checkpoint baked in.
    const planFact  = `[reproducer:plan] ${JSON.stringify(GOLDEN_PLAN)}`;
    const stepFact  = `[reproducer:step] planning-done`;
    const bugsFact  = `[triager:bugs] ${GOLDEN_BUGS_FACT}`;

    const postCheckpoint = await sdk.createCapsule({
      task_id:     TASK_ID,
      goal:        "Fix buggy-utils",
      holder:      "reproducer",
      facts:       [bugsFact, stepFact, planFact],
      decisions:   ["[reproducer] Designed test plan: test each function"],
      next_action: "write-reproduction-tests",
    });

    // No checkpoint fn needed — resuming container just returns the final result.
    const result = await reproducerHandler(makeCtx(postCheckpoint));

    // Only the tests LLM call (step 2) should fire.
    expect(vi.mocked(callLLM)).toHaveBeenCalledTimes(1);
    const tag = (vi.mocked(callLLM).mock.calls[0]![0] as { tag: string }).tag;
    expect(tag).toMatch(/^reproducer:/);
    expect(tag).not.toMatch(/plan/);

    // Final facts should include plan facts from the checkpoint + new tests.
    const finalFacts = result.update.facts ?? [];
    expect(finalFacts.some((f) => f.includes("[reproducer:step] tests-written"))).toBe(true);
    expect(finalFacts.some((f) => f.startsWith("[reproducer:tests]"))).toBe(true);
    // Plan fact preserved from checkpoint capsule.
    expect(finalFacts.some((f) => f.startsWith("[reproducer:plan]"))).toBe(true);

    expect(result.next_holder).toBe("patcher");
  });

  // ── 3. No checkpoint fn (test / offline path) ──────────────────────────────

  it("no checkpoint fn: still produces correct output (inline state only)", async () => {
    const TASK_ID = `p5-nockpt-${Date.now()}`;
    const storage = createMemoryStorage();
    const sdk     = new StateCapsule({ storageAdapter: storage });

    vi.mocked(callLLM)
      .mockResolvedValueOnce(JSON.stringify(GOLDEN_PLAN))
      .mockResolvedValueOnce(JSON.stringify(GOLDEN_TESTS));

    const genesis = await sdk.createCapsule({
      task_id: TASK_ID,
      goal:    "Fix buggy-utils",
      holder:  "triager",
      facts:   [`[triager:bugs] ${GOLDEN_BUGS_FACT}`],
    });

    // No checkpoint fn passed.
    const result = await reproducerHandler(makeCtx(genesis));

    expect(vi.mocked(callLLM)).toHaveBeenCalledTimes(2);
    expect(result.next_holder).toBe("patcher");
    const finalFacts = result.update.facts ?? [];
    expect(finalFacts.some((f) => f.startsWith("[reproducer:tests]"))).toBe(true);
    expect(finalFacts.some((f) => f.includes("[reproducer:step] tests-written"))).toBe(true);
  });

  // ── 4. fetchSealedSummary local fallback ──────────────────────────────────

  it("fetchSealedSummary: falls back gracefully when 0G Compute is not configured", async () => {
    // Ensure 0G Compute env vars are absent.
    const origUrl    = process.env["OG_COMPUTE_SERVICE_URL"];
    const origSecret = process.env["OG_COMPUTE_SECRET"];
    delete process.env["OG_COMPUTE_SERVICE_URL"];
    delete process.env["OG_COMPUTE_SECRET"];

    try {
      const storage = createMemoryStorage();
      const sdk     = new StateCapsule({ storageAdapter: storage });
      const capsule = await sdk.createCapsule({
        task_id:     "sealed-fallback-test",
        goal:        "Fix async race in memoizeAsync",
        holder:      "reproducer",
        facts:       ["bug: memoizeAsync has a race condition", "[reproducer:step] planning-done"],
        decisions:   ["Designed test plan"],
        next_action: "write-reproduction-tests",
      });

      const summary = await fetchSealedSummary(capsule);

      expect(summary.attested).toBe(false);
      expect(summary.model).toBe("local-fallback");
      expect(summary.capsule_id).toBe(capsule.capsule_id);
      expect(typeof summary.summary).toBe("string");
      expect(summary.summary.length).toBeGreaterThan(10);
      expect(summary.speedup_ms).toBe(0);
      expect(["high", "medium", "low"]).toContain(summary.confidence);
    } finally {
      if (origUrl    !== undefined) process.env["OG_COMPUTE_SERVICE_URL"] = origUrl;
      if (origSecret !== undefined) process.env["OG_COMPUTE_SECRET"]      = origSecret;
    }
  });

  // ── 5. Missing triager:bugs throws ────────────────────────────────────────

  it("reproducer: throws if triager:bugs fact is absent (even on resume path)", async () => {
    const TASK_ID = `p5-err-${Date.now()}`;
    const storage = createMemoryStorage();
    const sdk     = new StateCapsule({ storageAdapter: storage });

    // Capsule has a planning checkpoint but no bugs fact.
    const capsule = await sdk.createCapsule({
      task_id: TASK_ID,
      goal:    "Fix buggy-utils",
      holder:  "reproducer",
      facts:   ["[reproducer:step] planning-done"], // bugs fact missing
    });

    await expect(
      reproducerHandler(makeCtx(capsule)),
    ).rejects.toThrow(/triager:bugs/);
  });
});
