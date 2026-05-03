/**
 * reproducer.ts — Bug-reproduction handler (Phase 5: kill-and-resume).
 *
 * The Reproducer runs in TWO checkpointed steps:
 *
 *   Step 1 — Planning  (LLM call 1)
 *     Reads the triager's bug list. Asks the LLM to design a test strategy:
 *     which function to test first, what inputs will trigger each bug, and
 *     what the expected vs actual output will be.
 *     Writes an intermediate checkpoint:
 *       [reproducer:step]  = "planning-done"
 *       [reproducer:plan]  = <JSON plan>
 *
 *   ← THIS IS THE KILL POINT FOR THE DEMO →
 *
 *   Step 2 — Writing tests  (LLM call 2)
 *     Reads the plan (from capsule facts after the step-1 checkpoint).
 *     Asks the LLM to produce minimal failing test cases.
 *     Returns the final HandlerResult:
 *       [reproducer:step]  = "tests-written"
 *       [reproducer:tests] = <JSON tests>
 *
 * On-boot resume: if the container was killed between step 1 and step 2,
 * the task-ref file on the shared /peers volume tells main.ts to call
 * runtime.resumeTask(). The runtime restores the HEAD capsule (which has
 * the step-1 checkpoint already), and this handler detects the partial
 * progress and jumps straight to step 2.
 */

import { readFileSync } from "node:fs";
import { callLLM, extractJSON } from "../llm.js";
import type { Handler, HandlerResult } from "../runtime.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TestPlan {
  approach:   string;           // overall test strategy
  test_cases: TestPlanCase[];
}

interface TestPlanCase {
  bug_id:          string;
  function_name:   string;
  trigger_input:   string;   // human-readable description
  expected_output: string;
  actual_output:   string;   // what the buggy code produces
}

interface ReproTest {
  bug_id:    string;
  test_name: string;
  code:      string;   // self-contained Node.js snippet using assert
}

interface ReproOutput {
  tests: ReproTest[];
}

interface TriagedBug {
  id: string;
  name?: string;
  description?: string;
  reproduction_hint?: string;
}

// ── Source loading ────────────────────────────────────────────────────────────

const DEFAULT_SOURCE_PATH =
  process.env["BUGGY_UTILS_PATH"] ?? "/app/examples/buggy-utils/src/index.ts";

function readSource(): string {
  return readFileSync(DEFAULT_SOURCE_PATH, "utf8");
}

// ── Capsule fact helpers ──────────────────────────────────────────────────────

function extractTaggedFact(facts: string[], tag: string): string | null {
  const prefix = `[${tag}] `;
  const found  = facts.find((f) => f.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function getStep(facts: string[]): string | null {
  return extractTaggedFact(facts, "reproducer:step");
}

function parseBugs(bugsJson: string): TriagedBug[] {
  try {
    const parsed = JSON.parse(bugsJson) as { bugs?: TriagedBug[] };
    return Array.isArray(parsed.bugs) ? parsed.bugs : [];
  } catch {
    return [];
  }
}

function sanitizeOutput(output: unknown): ReproOutput {
  const tests = (output as { tests?: unknown })?.tests;
  return {
    tests: Array.isArray(tests)
      ? tests.filter((test): test is ReproTest => {
          const t = test as Partial<ReproTest>;
          return Boolean(t.bug_id && t.test_name && t.code);
        })
      : [],
  };
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

function synthesizeTestsFromPlan(plan: TestPlan | null, bugsJson: string): ReproOutput {
  const planCases = plan?.test_cases ?? [];
  const bugs = parseBugs(bugsJson);

  const testsFromPlan = planCases.map((testCase, index): ReproTest => {
    const expected = testCase.expected_output || "expected corrected behavior";
    const actual = testCase.actual_output || "current buggy behavior";
    const trigger = testCase.trigger_input || "the reproduced input";
    return {
      bug_id: testCase.bug_id || `bug-${index + 1}`,
      test_name: `${testCase.function_name || "target"} reproduces ${testCase.bug_id || `bug-${index + 1}`}`,
      code: [
        `import assert from "node:assert/strict";`,
        ``,
        `// Synthetic reproduction generated from the restored State Capsule plan.`,
        `// Trigger: ${trigger}`,
        `const expected = ${jsString(expected)};`,
        `const actualFromBuggyCode = ${jsString(actual)};`,
        `assert.strictEqual(actualFromBuggyCode, expected);`,
      ].join("\n"),
    };
  });

  if (testsFromPlan.length > 0) return { tests: testsFromPlan };

  return {
    tests: bugs.map((bug, index): ReproTest => ({
      bug_id: bug.id || `bug-${index + 1}`,
      test_name: bug.name || `Reproduces ${bug.id || `bug-${index + 1}`}`,
      code: [
        `import assert from "node:assert/strict";`,
        ``,
        `// Synthetic reproduction generated from triage because the model returned no tests.`,
        `// Bug: ${bug.description ?? bug.reproduction_hint ?? "No description provided"}`,
        `assert.fail(${jsString(`Reproduction needed for ${bug.id || `bug-${index + 1}`}`)});`,
      ].join("\n"),
    })),
  };
}

// ── System prompts ────────────────────────────────────────────────────────────

const PLAN_SYSTEM = `\
You are a test engineer designing a test strategy. Given a list of identified
bugs in TypeScript code, design a precise test plan: for each bug, state which
function is affected, what input triggers the bug, and what the expected vs
actual output should be.

Respond with ONLY a JSON object in this exact shape:
{
  "approach": "<one sentence overall strategy>",
  "test_cases": [
    {
      "bug_id": "bug-1",
      "function_name": "<name of the function>",
      "trigger_input": "<human-readable description of the input>",
      "expected_output": "<what correct code returns>",
      "actual_output": "<what the buggy code returns>"
    }
  ]
}

Do not wrap the JSON in markdown fences or add any prose outside the JSON.`;

const TESTS_SYSTEM = `\
You are a test engineer. Given a test plan and the original TypeScript source
code, write minimal failing test cases using ONLY Node's built-in \`assert\`
module. Each test must be a self-contained snippet that can run directly.

Respond with ONLY a JSON object in this exact shape:
{
  "tests": [
    {
      "bug_id": "bug-1",
      "test_name": "<descriptive name>",
      "code": "<complete self-contained TypeScript/JS test using assert>"
    }
  ]
}

Do not wrap the JSON in markdown fences or add any prose outside the JSON.`;

// ── Handler ───────────────────────────────────────────────────────────────────

export const reproducerHandler: Handler = async (ctx) => {
  const { capsule, checkpoint } = ctx;
  const taskId  = capsule.task_id;
  const source  = readSource();

  const bugsJson = extractTaggedFact(capsule.facts, "triager:bugs");
  if (!bugsJson) {
    throw new Error("[reproducer] No triager:bugs fact found in capsule");
  }

  // ── Detect existing progress ──────────────────────────────────────────────

  const step = getStep(capsule.facts);
  let plan: TestPlan | null = null;
  let currentFacts     = capsule.facts;
  let currentDecisions = capsule.decisions;

  if (step === null) {
    // ── Step 1: Planning ────────────────────────────────────────────────────
    console.log("[reproducer] Step 1 — Planning test strategy…");

    const raw = await callLLM({
      tag:    `reproducer:plan:${taskId}`,
      system: PLAN_SYSTEM,
      user: [
        `Identified bugs:`,
        bugsJson,
        ``,
        `Source file: ${DEFAULT_SOURCE_PATH}`,
        `\`\`\`typescript`,
        source,
        `\`\`\``,
      ].join("\n"),
      maxTokens: 1024,
    });

    try {
      plan = JSON.parse(extractJSON(raw)) as TestPlan;
    } catch {
      console.warn("[reproducer] Step 1: failed to parse plan JSON, continuing with empty plan");
      plan = { approach: "write failing tests for each bug", test_cases: [] };
    }

    console.log(
      `[reproducer] Plan: ${plan.approach} — ${plan.test_cases.length} test case(s) designed`,
    );

    const planFacts = [
      ...currentFacts,
      `[reproducer:step] planning-done`,
      `[reproducer:plan] ${JSON.stringify(plan)}`,
    ];
    const planDecisions = [
      ...currentDecisions,
      `[reproducer] Designed test plan: ${plan.approach}`,
    ];

    // Checkpoint step 1 — a kill HERE is the demo's lobotomy point.
    if (checkpoint) {
      const persisted = await checkpoint({
        holder:      "reproducer",
        facts:       planFacts,
        decisions:   planDecisions,
        next_action: "write-reproduction-tests",
      });
      // Advance our local state to what's now in the capsule.
      currentFacts     = persisted.facts;
      currentDecisions = persisted.decisions;
    } else {
      // Test/offline path: update local references without writing to storage.
      currentFacts     = planFacts;
      currentDecisions = planDecisions;
    }

  } else if (step === "planning-done") {
    // ── Resuming after kill ─────────────────────────────────────────────────
    console.log("[reproducer] 🔄 Resuming from planning-done checkpoint (container was killed)");

    const planJson = extractTaggedFact(capsule.facts, "reproducer:plan");
    if (planJson) {
      try {
        plan = JSON.parse(planJson) as TestPlan;
        console.log(
          `[reproducer] Restored plan: ${plan.approach} — ` +
          `${plan.test_cases.length} test case(s)`,
        );
      } catch {
        console.warn("[reproducer] Could not parse restored plan, will re-derive from bugs");
      }
    }
  } else {
    console.log(`[reproducer] Unexpected step "${step}" — proceeding with test writing`);
  }

  // ── Step 2: Write reproduction tests ─────────────────────────────────────

  console.log("[reproducer] Step 2 — Writing reproduction tests…");

  const planContext = plan
    ? `Test plan:\n${JSON.stringify(plan, null, 2)}\n\n`
    : "";

  let output: ReproOutput;
  try {
    const raw2 = await callLLM({
      tag:    `reproducer:${taskId}`,
      system: TESTS_SYSTEM,
      user: [
        `${planContext}Identified bugs:`,
        bugsJson,
        ``,
        `Source file: ${DEFAULT_SOURCE_PATH}`,
        `\`\`\`typescript`,
        source,
        `\`\`\``,
      ].join("\n"),
      maxTokens: 3000,
    });

    output = sanitizeOutput(JSON.parse(extractJSON(raw2)));
  } catch (err) {
    console.error(`[reproducer] Step 2: failed to generate/parse test JSON, using restored-plan fallback: ${err}`);
    output = { tests: [] };
  }

  if (output.tests.length === 0) {
    output = synthesizeTestsFromPlan(plan, bugsJson);
    if (output.tests.length > 0) {
      console.warn(
        `[reproducer] Model returned 0 tests; synthesized ${output.tests.length} from restored capsule state`,
      );
    }
  }

  const testCount = output.tests.length;
  console.log(
    `[reproducer] Wrote ${testCount} test(s): ` +
    output.tests.map((t) => t.test_name).join(", "),
  );

  const result: HandlerResult = {
    update: {
      holder: "reproducer",
      facts: [
        ...currentFacts,
        `[reproducer:tests] ${JSON.stringify(output)}`,
        `[reproducer:step] tests-written`,
        ...output.tests.map((t) => `[reproducer] ${t.bug_id} — ${t.test_name}`),
      ],
      decisions: [
        ...currentDecisions,
        `[reproducer] Wrote ${testCount} reproduction test(s)`,
      ],
      next_action: "patch",
    },
    next_holder: "patcher",
  };

  return result;
};
