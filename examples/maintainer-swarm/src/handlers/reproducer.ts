/**
 * reproducer.ts — Bug-reproduction handler.
 *
 * Reads the triage output written by the triager, then calls the LLM to
 * generate minimal TypeScript test cases (using Node's built-in `assert`)
 * that expose each bug. Results are written back to the capsule so the
 * patcher has concrete failing tests to work against.
 *
 * This is the stage that gets killed mid-run in the Phase 5 kill-and-resume
 * demo. The capsule's last persisted state lets a fresh container pick up
 * exactly where it left off.
 *
 * Writes to capsule:
 *   facts:    one "[reproducer:tests] <JSON>" entry + test summaries
 *   decisions: reproduction verdict line
 *   next_action: "patch"
 *   next_holder: "patcher"
 */

import { readFileSync } from "node:fs";
import { callLLM, extractJSON } from "../llm.js";
import type { Handler, HandlerResult } from "../runtime.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReproTest {
  bug_id:    string;
  test_name: string;
  code:      string;   // self-contained Node.js script (uses assert)
}

interface ReproOutput {
  tests: ReproTest[];
}

// ── Source loading ────────────────────────────────────────────────────────────

const DEFAULT_SOURCE_PATH =
  process.env["BUGGY_UTILS_PATH"] ?? "/app/examples/buggy-utils/src/index.ts";

function readSource(): string {
  return readFileSync(DEFAULT_SOURCE_PATH, "utf8");
}

// ── Capsule fact extraction ───────────────────────────────────────────────────

function extractTaggedFact(facts: string[], tag: string): string | null {
  const prefix = `[${tag}] `;
  const found  = facts.find((f) => f.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM = `\
You are a test engineer. Given a list of identified bugs and the original
TypeScript source code, write minimal failing test cases that clearly reproduce
each bug. Use ONLY Node's built-in \`assert\` module — no external test
framework. Each test should be a self-contained snippet that can be pasted
into a Node REPL or script and run directly.

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

export const reproducerHandler: Handler = async ({ capsule }) => {
  const bugsJson = extractTaggedFact(capsule.facts, "triager:bugs");
  if (!bugsJson) {
    throw new Error("[reproducer] No triager:bugs fact found in capsule");
  }

  const source = readSource();

  console.log("[reproducer] Writing reproduction tests…");

  const raw = await callLLM({
    tag:    `reproducer:${capsule.task_id}`,
    system: SYSTEM,
    user: [
      `Identified bugs:`,
      bugsJson,
      ``,
      `Source file: ${DEFAULT_SOURCE_PATH}`,
      `\`\`\`typescript`,
      source,
      `\`\`\``,
    ].join("\n"),
    maxTokens: 3000,
  });

  let output: ReproOutput;
  try {
    output = JSON.parse(extractJSON(raw)) as ReproOutput;
  } catch {
    console.error("[reproducer] Failed to parse LLM output, storing raw");
    output = { tests: [] };
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
        ...capsule.facts,
        `[reproducer:tests] ${JSON.stringify(output)}`,
        ...output.tests.map(
          (t) => `[reproducer] ${t.bug_id} — ${t.test_name}`,
        ),
      ],
      decisions: [
        ...capsule.decisions,
        `[reproducer] Wrote ${testCount} reproduction test(s)`,
      ],
      next_action: "patch",
    },
    next_holder: "patcher",
  };

  return result;
};
