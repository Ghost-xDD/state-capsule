/**
 * patcher.ts — Bug-fix handler.
 *
 * Reads the triager's bug list and the reproducer's failing tests from the
 * capsule, then calls the LLM to produce a corrected version of the source
 * file. The patched source and a per-bug changelog are written back to the
 * capsule for the reviewer.
 *
 * Writes to capsule:
 *   facts:    one "[patcher:patch] <JSON>" entry + change summaries
 *   decisions: patch verdict line
 *   next_action: "review"
 *   next_holder: "reviewer"
 */

import { readFileSync } from "node:fs";
import { callLLM, extractJSON } from "../llm.js";
import type { Handler, HandlerResult } from "../runtime.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PatchChange {
  bug_id:      string;
  description: string;   // what was changed and why
}

interface PatchOutput {
  patched_source: string;       // full corrected file contents
  changes:        PatchChange[];
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
You are a software engineer applying targeted bug fixes. You will be given:
  1. A list of identified bugs with descriptions
  2. Failing test cases that reproduce each bug
  3. The original TypeScript source file

Produce a corrected version of the entire source file that fixes ALL reported
bugs without changing the public API or introducing regressions.

Respond with ONLY a JSON object in this exact shape:
{
  "patched_source": "<complete corrected TypeScript source file>",
  "changes": [
    {
      "bug_id": "bug-1",
      "description": "<what was changed and why>"
    }
  ]
}

Do not wrap the JSON in markdown fences or add any prose outside the JSON.`;

// ── Handler ───────────────────────────────────────────────────────────────────

export const patcherHandler: Handler = async ({ capsule }) => {
  const bugsJson  = extractTaggedFact(capsule.facts, "triager:bugs");
  const testsJson = extractTaggedFact(capsule.facts, "reproducer:tests");

  if (!bugsJson)  throw new Error("[patcher] No triager:bugs fact in capsule");
  if (!testsJson) throw new Error("[patcher] No reproducer:tests fact in capsule");

  const source = readSource();

  console.log("[patcher] Generating patch…");

  const raw = await callLLM({
    tag:    `patcher:${capsule.task_id}`,
    system: SYSTEM,
    user: [
      `Identified bugs:`,
      bugsJson,
      ``,
      `Failing reproduction tests:`,
      testsJson,
      ``,
      `Original source file: ${DEFAULT_SOURCE_PATH}`,
      `\`\`\`typescript`,
      source,
      `\`\`\``,
    ].join("\n"),
    maxTokens: 4000,
  });

  let output: PatchOutput;
  try {
    output = JSON.parse(extractJSON(raw)) as PatchOutput;
  } catch {
    console.error("[patcher] Failed to parse LLM output, storing raw");
    output = { patched_source: "", changes: [] };
  }

  const changeCount = output.changes.length;
  console.log(
    `[patcher] Applied ${changeCount} fix(es): ` +
    output.changes.map((c) => c.bug_id).join(", "),
  );

  const result: HandlerResult = {
    update: {
      holder: "patcher",
      facts: [
        ...capsule.facts,
        `[patcher:patch] ${JSON.stringify(output)}`,
        ...output.changes.map(
          (c) => `[patcher] ${c.bug_id} — ${c.description}`,
        ),
      ],
      decisions: [
        ...capsule.decisions,
        `[patcher] Applied ${changeCount} fix(es) to buggy-utils`,
      ],
      next_action: "review",
    },
    next_holder: "reviewer",
  };

  return result;
};
