/**
 * phase4.test.ts — Phase 4 specialist-handler unit tests.
 *
 * Strategy:
 *   • callLLM is mocked via vi.mock — no real LLM call is made.
 *   • Each handler's golden JSON response is pre-defined below.
 *   • A real in-memory StateCapsule chain is used so capsule wiring
 *     (updateCapsule, restoreCapsule, parent links) is tested end-to-end.
 *   • BUGGY_UTILS_PATH is set in test/setup.ts so handlers can read the
 *     real source file from disk.
 *
 * Coverage:
 *   1. Full pipeline: triager → reproducer → patcher → reviewer
 *   2. Each handler's facts, decisions, and next_holder output
 *   3. Error paths: missing upstream facts throw rather than silently fail
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ── Mock callLLM BEFORE any handler imports ───────────────────────────────────
// vi.mock is hoisted by vitest so this runs before the import block below.

vi.mock("../src/llm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm.js")>();
  return {
    ...actual,                     // keep real extractJSON
    callLLM: vi.fn(),              // stub — configured per-test below
  };
});

// ── Imports (after mock registration) ────────────────────────────────────────

import { StateCapsule, createMemoryStorage } from "@state-capsule/sdk";
import type { Capsule }                       from "@state-capsule/sdk";
import type { CapsuleEnvelope }               from "@state-capsule/sdk";
import { callLLM }                            from "../src/llm.js";
import { triagerHandler }                     from "../src/handlers/triager.js";
import { reproducerHandler }                  from "../src/handlers/reproducer.js";
import { patcherHandler }                     from "../src/handlers/patcher.js";
import { reviewerHandler }                    from "../src/handlers/reviewer.js";
import type { HandlerContext }                from "../src/runtime.js";

// ── Golden LLM responses ──────────────────────────────────────────────────────

const GOLDEN_BUGS = {
  bugs: [
    {
      id:                "bug-1",
      name:              "async-race-in-memoizeAsync",
      location:          "memoizeAsync",
      description:
        "In-flight requests are not tracked. Concurrent calls for the same key " +
        "all miss the cache simultaneously and independently execute fn(key), " +
        "causing duplicate work and potential data inconsistency.",
      reproduction_hint:
        "Call the memoized function twice concurrently with the same key; " +
        "fn will be invoked twice instead of once.",
    },
    {
      id:                "bug-2",
      name:              "off-by-one-in-chunk",
      location:          "chunk",
      description:
        "arr.slice(i, i + size - 1) is used instead of arr.slice(i, i + size). " +
        "The subtraction of 1 silently drops the last element of every chunk.",
      reproduction_hint:
        "chunk([1, 2, 3, 4], 2) returns [[1], [3]] instead of [[1, 2], [3, 4]].",
    },
    {
      id:                "bug-3",
      name:              "logic-inversion-in-partition",
      location:          "partition",
      description:
        "The true/false branches are swapped: matching items go to the fail " +
        "bucket and non-matching items to the pass bucket.",
      reproduction_hint:
        "partition([1,2,3,4], n => n%2===0) returns [[1,3],[2,4]] instead of [[2,4],[1,3]].",
    },
  ],
};

const GOLDEN_TESTS = {
  tests: [
    {
      bug_id:    "bug-1",
      test_name: "memoizeAsync: concurrent calls for same key must not duplicate fn invocations",
      code: [
        "import assert from 'node:assert';",
        "let calls = 0;",
        "const slowFn = async (k) => { await new Promise(r => setTimeout(r, 20)); return ++calls; };",
        "const mem = memoizeAsync(slowFn);",
        "const [r1, r2] = await Promise.all([mem('x'), mem('x')]);",
        "assert.strictEqual(calls, 1, 'fn must be called exactly once');",
        "assert.strictEqual(r1, r2, 'both results must be identical');",
      ].join("\n"),
    },
    {
      bug_id:    "bug-2",
      test_name: "chunk: every chunk must contain exactly size elements except possibly the last",
      code: [
        "import assert from 'node:assert';",
        "const result = chunk([1, 2, 3, 4], 2);",
        "assert.deepStrictEqual(result, [[1, 2], [3, 4]]);",
      ].join("\n"),
    },
    {
      bug_id:    "bug-3",
      test_name: "partition: elements matching predicate must appear in the first (pass) bucket",
      code: [
        "import assert from 'node:assert';",
        "const [evens, odds] = partition([1, 2, 3, 4], n => n % 2 === 0);",
        "assert.deepStrictEqual(evens, [2, 4]);",
        "assert.deepStrictEqual(odds,  [1, 3]);",
      ].join("\n"),
    },
  ],
};

// Reproducer now needs a plan LLM call (step 1) before writing tests (step 2).
const GOLDEN_PLAN = {
  approach:   "test each function with minimal inputs that expose the defect",
  test_cases: [
    { bug_id: "bug-1", function_name: "memoizeAsync", trigger_input: "concurrent calls", expected_output: "fn called once", actual_output: "fn called twice" },
    { bug_id: "bug-2", function_name: "chunk", trigger_input: "chunk([1,2,3,4],2)", expected_output: "[[1,2],[3,4]]", actual_output: "[[1],[3]]" },
    { bug_id: "bug-3", function_name: "partition", trigger_input: "evens predicate", expected_output: "[[2,4],[1,3]]", actual_output: "[[1,3],[2,4]]" },
  ],
};

const PATCHED_SOURCE = `
export function memoizeAsync(fn) {
  const cache    = new Map();
  const inFlight = new Map();
  return async (key) => {
    if (cache.has(key))    return cache.get(key);
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = fn(key).then((v) => { cache.set(key, v); inFlight.delete(key); return v; });
    inFlight.set(key, promise);
    return promise;
  };
}
export function chunk(arr, size) {
  if (size <= 0) throw new RangeError(\`chunk: size must be > 0, got \${size}\`);
  const result = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}
export function partition(arr, predicate) {
  const pass = [], fail = [];
  for (const item of arr) (predicate(item) ? pass : fail).push(item);
  return [pass, fail];
}
`.trim();

const GOLDEN_PATCH = {
  patched_source: PATCHED_SOURCE,
  changes: [
    { bug_id: "bug-1", description: "Track in-flight promises to deduplicate concurrent calls." },
    { bug_id: "bug-2", description: "Changed slice end from i+size-1 to i+size." },
    { bug_id: "bug-3", description: "Swapped pass/fail push targets." },
  ],
};

const GOLDEN_VERDICT = {
  verdict:         "APPROVED",
  confidence:      "high",
  reasoning:
    "All three bugs are correctly fixed. memoizeAsync deduplicates concurrent calls, " +
    "chunk uses the correct slice end index, and partition routes items to the correct bucket. " +
    "No API changes or regressions introduced.",
  unresolved_bugs: [] as string[],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEnvelope(taskId: string, capsuleId: string, holder: string): CapsuleEnvelope {
  return {
    type:       "capsule.handoff",
    task_id:    taskId,
    capsule_id: capsuleId,
    holder,
    sent_at:    new Date().toISOString(),
  };
}

function makeCtx(capsule: Capsule, role: HandlerContext["role"]): HandlerContext {
  return {
    capsule,
    role,
    envelope: makeEnvelope(capsule.task_id, capsule.capsule_id, role),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 4 — specialist handlers", () => {
  const TASK_ID = `phase4-test-${Date.now()}`;
  const storage = createMemoryStorage();
  const sdk     = new StateCapsule({ storageAdapter: storage });

  beforeEach(() => {
    // resetAllMocks clears the mockResolvedValueOnce queue (clearAllMocks does not).
    vi.resetAllMocks();
  });

  // ── 1. Full pipeline ────────────────────────────────────────────────────────

  it("full pipeline: triager → reproducer → patcher → reviewer", async () => {
    const mockLLM = vi.mocked(callLLM);

    // Seed responses in call order.
    // Reproducer now makes 2 LLM calls: plan (step 1) then tests (step 2).
    mockLLM
      .mockResolvedValueOnce(JSON.stringify(GOLDEN_BUGS))    // triager
      .mockResolvedValueOnce(JSON.stringify(GOLDEN_PLAN))    // reproducer: step 1 plan
      .mockResolvedValueOnce(JSON.stringify(GOLDEN_TESTS))   // reproducer: step 2 tests
      .mockResolvedValueOnce(JSON.stringify(GOLDEN_PATCH))   // patcher
      .mockResolvedValueOnce(JSON.stringify(GOLDEN_VERDICT)); // reviewer

    // ── Genesis capsule ───────────────────────────────────────────────────────

    let capsule = await sdk.createCapsule({
      task_id: TASK_ID,
      goal:
        "Review examples/buggy-utils/src/index.ts and fix all bugs. " +
        "Three functions are exported: memoizeAsync, chunk, partition — each contains one defect.",
      holder:          "seed",
      facts:           ["Source file: /app/examples/buggy-utils/src/index.ts"],
      constraints:     ["Do not change the public API signatures"],
      pending_actions: ["triage", "reproduce", "patch", "review"],
      next_action:     "triage",
    });

    // ── Stage 1: Triager ──────────────────────────────────────────────────────

    const triagerResult = await triagerHandler(makeCtx(capsule, "triager"));

    expect(triagerResult.next_holder).toBe("reproducer");
    expect(triagerResult.update.next_action).toBe("reproduce");
    expect(triagerResult.update.holder).toBe("triager");

    const triagerFacts = triagerResult.update.facts ?? [];
    const bugsFact     = triagerFacts.find((f) => f.startsWith("[triager:bugs]"));
    expect(bugsFact).toBeDefined();

    // Parsed output should have all 3 bugs
    const bugsJson = bugsFact!.replace("[triager:bugs] ", "");
    const parsed   = JSON.parse(bugsJson) as typeof GOLDEN_BUGS;
    expect(parsed.bugs).toHaveLength(3);
    expect(parsed.bugs.map((b) => b.id)).toEqual(["bug-1", "bug-2", "bug-3"]);

    // Human-readable per-bug facts appended
    const bugSummaries = triagerFacts.filter((f) => f.startsWith("[triager] bug-"));
    expect(bugSummaries).toHaveLength(3);

    const triagerDecisions = triagerResult.update.decisions ?? [];
    expect(triagerDecisions.some((d) => d.includes("Triaged 3 bug"))).toBe(true);

    // Persist capsule update
    capsule = await sdk.updateCapsule({
      task_id:           TASK_ID,
      parent_capsule_id: capsule.capsule_id,
      ...triagerResult.update,
    });

    // ── Stage 2: Reproducer ───────────────────────────────────────────────────

    capsule = await sdk.restoreCapsule(TASK_ID);
    const reproResult = await reproducerHandler(makeCtx(capsule, "reproducer"));

    expect(reproResult.next_holder).toBe("patcher");
    expect(reproResult.update.next_action).toBe("patch");
    expect(reproResult.update.holder).toBe("reproducer");

    const reproFacts    = reproResult.update.facts ?? [];
    const testsFact     = reproFacts.find((f) => f.startsWith("[reproducer:tests]"));
    expect(testsFact).toBeDefined();

    const testsJson   = testsFact!.replace("[reproducer:tests] ", "");
    const parsedTests = JSON.parse(testsJson) as typeof GOLDEN_TESTS;
    expect(parsedTests.tests).toHaveLength(3);

    const reproDecisions = reproResult.update.decisions ?? [];
    expect(reproDecisions.some((d) => d.includes("Wrote 3"))).toBe(true);

    capsule = await sdk.updateCapsule({
      task_id:           TASK_ID,
      parent_capsule_id: capsule.capsule_id,
      ...reproResult.update,
    });

    // ── Stage 3: Patcher ──────────────────────────────────────────────────────

    capsule = await sdk.restoreCapsule(TASK_ID);
    const patchResult = await patcherHandler(makeCtx(capsule, "patcher"));

    expect(patchResult.next_holder).toBe("reviewer");
    expect(patchResult.update.next_action).toBe("review");
    expect(patchResult.update.holder).toBe("patcher");

    const patchFacts = patchResult.update.facts ?? [];
    const patchFact  = patchFacts.find((f) => f.startsWith("[patcher:patch]"));
    expect(patchFact).toBeDefined();

    const patchJson   = patchFact!.replace("[patcher:patch] ", "");
    const parsedPatch = JSON.parse(patchJson) as typeof GOLDEN_PATCH;
    expect(parsedPatch.changes).toHaveLength(3);
    expect(parsedPatch.patched_source).toContain("inFlight");   // race fix
    expect(parsedPatch.patched_source).toContain("i + size)");  // off-by-one fix

    const patchDecisions = patchResult.update.decisions ?? [];
    expect(patchDecisions.some((d) => d.includes("Applied 3"))).toBe(true);

    capsule = await sdk.updateCapsule({
      task_id:           TASK_ID,
      parent_capsule_id: capsule.capsule_id,
      ...patchResult.update,
    });

    // ── Stage 4: Reviewer (terminal) ─────────────────────────────────────────

    capsule = await sdk.restoreCapsule(TASK_ID);
    const reviewResult = await reviewerHandler(makeCtx(capsule, "reviewer"));

    // Terminal stage — no next_holder
    expect(reviewResult.next_holder).toBeUndefined();
    expect(reviewResult.update.next_action).toBe("pipeline-complete");
    expect(reviewResult.update.holder).toBe("reviewer");

    const reviewFacts   = reviewResult.update.facts ?? [];
    const verdictFact   = reviewFacts.find((f) => f.startsWith("[reviewer:verdict]"));
    expect(verdictFact).toBeDefined();

    const verdictJson   = verdictFact!.replace("[reviewer:verdict] ", "");
    const parsedVerdict = JSON.parse(verdictJson) as typeof GOLDEN_VERDICT;
    expect(parsedVerdict.verdict).toBe("APPROVED");
    expect(parsedVerdict.unresolved_bugs).toHaveLength(0);

    const reviewDecisions = reviewResult.update.decisions ?? [];
    expect(reviewDecisions.some((d) => d.includes("APPROVED"))).toBe(true);

    // Reproducer makes 2 LLM calls (plan + tests); total is 5.
    expect(mockLLM).toHaveBeenCalledTimes(5);

    // Verify call tags follow naming convention
    const tags = mockLLM.mock.calls.map((c) => (c[0] as { tag: string }).tag);
    expect(tags[0]).toBe(`triager:${TASK_ID}`);
    expect(tags[1]).toMatch(/^reproducer:plan:/);     // step-1 plan
    expect(tags[2]).toBe(`reproducer:${TASK_ID}`);   // step-2 tests
    expect(tags[3]).toBe(`patcher:${TASK_ID}`);
    expect(tags[4]).toBe(`reviewer:${TASK_ID}`);
  });

  // ── 2. REJECTED verdict path ────────────────────────────────────────────────

  it("reviewer: REJECTED verdict sets next_action to needs-rework", async () => {
    const TASK_ID_REJ = `phase4-reject-${Date.now()}`;
    const sdk2 = new StateCapsule({ storageAdapter: createMemoryStorage() });

    const bugsFact  = `[triager:bugs] ${JSON.stringify(GOLDEN_BUGS)}`;
    const testsFact = `[reproducer:tests] ${JSON.stringify(GOLDEN_TESTS)}`;
    const patchFact = `[patcher:patch] ${JSON.stringify(GOLDEN_PATCH)}`;

    const rejectedVerdict = {
      verdict:         "REJECTED",
      confidence:      "medium",
      reasoning:       "Bug-2 is still present — slice end index unchanged.",
      unresolved_bugs: ["bug-2"],
    };

    vi.mocked(callLLM).mockResolvedValueOnce(JSON.stringify(rejectedVerdict));

    let capsule = await sdk2.createCapsule({
      task_id:  TASK_ID_REJ,
      goal:     "Fix buggy-utils",
      holder:   "patcher",
      facts:    [bugsFact, testsFact, patchFact],
      decisions: [],
    });

    const result = await reviewerHandler(makeCtx(capsule, "reviewer"));

    expect(result.next_holder).toBeUndefined();
    expect(result.update.next_action).toBe("needs-rework");
    const decisions = result.update.decisions ?? [];
    expect(decisions.some((d) => d.includes("REJECTED"))).toBe(true);
    expect((result.update.facts ?? []).some((f) => f.includes("bug-2"))).toBe(true);
  });

  // ── 3. Error paths ──────────────────────────────────────────────────────────

  it("reproducer: throws if [triager:bugs] fact is absent", async () => {
    const TASK_ID_ERR = `phase4-err-repro-${Date.now()}`;
    const sdk3 = new StateCapsule({ storageAdapter: createMemoryStorage() });

    const capsule = await sdk3.createCapsule({
      task_id: TASK_ID_ERR,
      goal:    "Fix buggy-utils",
      holder:  "triager",
      facts:   [], // deliberately empty
    });

    await expect(
      reproducerHandler(makeCtx(capsule, "reproducer")),
    ).rejects.toThrow(/triager:bugs/);
  });

  it("patcher: throws if [reproducer:tests] fact is absent", async () => {
    const TASK_ID_ERR = `phase4-err-patch-${Date.now()}`;
    const sdk4 = new StateCapsule({ storageAdapter: createMemoryStorage() });

    const capsule = await sdk4.createCapsule({
      task_id: TASK_ID_ERR,
      goal:    "Fix buggy-utils",
      holder:  "reproducer",
      // has bugs fact but no tests fact
      facts:   [`[triager:bugs] ${JSON.stringify(GOLDEN_BUGS)}`],
    });

    await expect(
      patcherHandler(makeCtx(capsule, "patcher")),
    ).rejects.toThrow(/reproducer:tests/);
  });

  it("reviewer: throws if [patcher:patch] fact is absent", async () => {
    const TASK_ID_ERR = `phase4-err-review-${Date.now()}`;
    const sdk5 = new StateCapsule({ storageAdapter: createMemoryStorage() });

    const capsule = await sdk5.createCapsule({
      task_id: TASK_ID_ERR,
      goal:    "Fix buggy-utils",
      holder:  "patcher",
      facts:   [
        `[triager:bugs] ${JSON.stringify(GOLDEN_BUGS)}`,
        `[reproducer:tests] ${JSON.stringify(GOLDEN_TESTS)}`,
        // patcher:patch missing
      ],
    });

    await expect(
      reviewerHandler(makeCtx(capsule, "reviewer")),
    ).rejects.toThrow(/patcher:patch/);
  });
});
