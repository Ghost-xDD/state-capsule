/**
 * triager.ts — Bug-triage handler.
 *
 * Reads the buggy-utils source from disk, calls the LLM to identify all bugs,
 * and writes structured findings into the capsule so the reproducer can act.
 *
 * Writes to capsule:
 *   facts:    one "[triager:bugs] <JSON>" entry + human-readable summaries
 *   decisions: triage verdict line
 *   next_action: "reproduce"
 *   next_holder: "reproducer"
 */

import { readFileSync } from "node:fs";
import { callLLM, extractJSON } from "../llm.js";
import type { Handler, HandlerResult } from "../runtime.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TriagedBug {
  id:               string;   // e.g. "bug-1"
  name:             string;   // short label
  location:         string;   // function or file region
  description:      string;   // precise defect description
  reproduction_hint: string;  // clue for the reproducer
}

interface TriageOutput {
  bugs: TriagedBug[];
}

// ── Source loading ────────────────────────────────────────────────────────────

const DEFAULT_SOURCE_PATH =
  process.env["BUGGY_UTILS_PATH"] ?? "/app/examples/buggy-utils/src/index.ts";

function readSource(): string {
  try {
    return readFileSync(DEFAULT_SOURCE_PATH, "utf8");
  } catch (err) {
    throw new Error(
      `[triager] Cannot read source at ${DEFAULT_SOURCE_PATH}: ${err}`,
    );
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM = `\
You are a senior software engineer performing a bug triage review.
You will be given TypeScript source code. Carefully analyse every function and
identify all defects — look for: logic inversions, off-by-one errors, async/
concurrency races, uninitialized variables, incorrect conditions, or any other
bug that would cause incorrect behaviour or test failures.

Respond with ONLY a JSON object in this exact shape:
{
  "bugs": [
    {
      "id": "bug-1",
      "name": "<short label>",
      "location": "<function name>",
      "description": "<precise description of the defect>",
      "reproduction_hint": "<what input or scenario triggers the bug>"
    }
  ]
}

Do not wrap the JSON in markdown fences or add any prose outside the JSON.`;

// ── Handler ───────────────────────────────────────────────────────────────────

export const triagerHandler: Handler = async ({ capsule }) => {
  const source = readSource();

  console.log(`[triager] Triaging source (${source.length} chars)…`);

  const raw = await callLLM({
    tag:    `triager:${capsule.task_id}`,
    system: SYSTEM,
    user: [
      `Task: ${capsule.goal}`,
      ``,
      `Source file: ${DEFAULT_SOURCE_PATH}`,
      `\`\`\`typescript`,
      source,
      `\`\`\``,
    ].join("\n"),
    maxTokens: 2048,
  });

  let output: TriageOutput;
  try {
    output = JSON.parse(extractJSON(raw)) as TriageOutput;
  } catch {
    console.error("[triager] Failed to parse LLM output, storing raw");
    output = { bugs: [] };
  }

  const bugCount = output.bugs.length;
  console.log(`[triager] Found ${bugCount} bug(s): ${output.bugs.map((b) => b.name).join(", ")}`);

  const result: HandlerResult = {
    update: {
      holder:      "triager",
      facts: [
        ...capsule.facts,
        `[triager:bugs] ${JSON.stringify(output)}`,
        ...output.bugs.map(
          (b) => `[triager] ${b.id} — ${b.name} in ${b.location}: ${b.description}`,
        ),
      ],
      decisions: [
        ...capsule.decisions,
        `[triager] Triaged ${bugCount} bug(s) in buggy-utils`,
      ],
      next_action: "reproduce",
    },
    next_holder: "reproducer",
  };

  return result;
};
