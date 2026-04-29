/**
 * reviewer.ts — Code-review handler (terminal stage).
 *
 * Reads the full capsule history (bugs, tests, patch) and calls the LLM to
 * review whether the proposed patch correctly resolves all bugs without
 * introducing regressions. Writes the final verdict and closes the pipeline
 * (no next_holder).
 *
 * Writes to capsule:
 *   facts:    one "[reviewer:verdict] <JSON>" entry + human-readable verdict
 *   decisions: APPROVED or REJECTED line
 *   next_action: "pipeline-complete" | "needs-rework"
 *   next_holder: undefined (terminal)
 */

import { callLLM, extractJSON } from "../llm.js";
import type { Handler, HandlerResult } from "../runtime.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type Confidence = "high" | "medium" | "low";
type Verdict    = "APPROVED" | "REJECTED";

interface ReviewOutput {
  verdict:          Verdict;
  confidence:       Confidence;
  reasoning:        string;
  unresolved_bugs?: string[];   // bug IDs not properly fixed
}

// ── Capsule fact extraction ───────────────────────────────────────────────────

function extractTaggedFact(facts: string[], tag: string): string | null {
  const prefix = `[${tag}] `;
  const found  = facts.find((f) => f.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM = `\
You are a senior code reviewer. You will be given:
  1. A list of bugs that were identified in the original source
  2. Failing test cases that reproduced each bug
  3. A proposed patch (corrected source file)

Review the patch carefully:
  • Does it fix every reported bug?
  • Does it preserve the original public API?
  • Does it avoid introducing new defects?

Respond with ONLY a JSON object in this exact shape:
{
  "verdict": "APPROVED" | "REJECTED",
  "confidence": "high" | "medium" | "low",
  "reasoning": "<concise explanation of your verdict>",
  "unresolved_bugs": ["bug-N"]   // empty array if all fixed
}

Do not wrap the JSON in markdown fences or add any prose outside the JSON.`;

// ── Handler ───────────────────────────────────────────────────────────────────

export const reviewerHandler: Handler = async ({ capsule }) => {
  const bugsJson    = extractTaggedFact(capsule.facts, "triager:bugs");
  const testsJson   = extractTaggedFact(capsule.facts, "reproducer:tests");
  const patchJson   = extractTaggedFact(capsule.facts, "patcher:patch");

  if (!bugsJson)  throw new Error("[reviewer] No triager:bugs fact in capsule");
  if (!testsJson) throw new Error("[reviewer] No reproducer:tests fact in capsule");
  if (!patchJson) throw new Error("[reviewer] No patcher:patch fact in capsule");

  // Extract the patched source from the patcher's JSON for readability in prompt
  let patchedSource = "";
  try {
    const patch = JSON.parse(patchJson) as { patched_source?: string };
    patchedSource = patch.patched_source ?? patchJson;
  } catch {
    patchedSource = patchJson;
  }

  console.log("[reviewer] Reviewing patch…");

  const raw = await callLLM({
    tag:    `reviewer:${capsule.task_id}`,
    system: SYSTEM,
    user: [
      `Identified bugs:`,
      bugsJson,
      ``,
      `Reproduction tests:`,
      testsJson,
      ``,
      `Proposed patched source:`,
      `\`\`\`typescript`,
      patchedSource,
      `\`\`\``,
    ].join("\n"),
    maxTokens: 1024,
  });

  let output: ReviewOutput;
  try {
    output = JSON.parse(extractJSON(raw)) as ReviewOutput;
  } catch {
    console.error("[reviewer] Failed to parse LLM output, defaulting to REJECTED");
    output = {
      verdict:    "REJECTED",
      confidence: "low",
      reasoning:  "Could not parse review output",
      unresolved_bugs: [],
    };
  }

  const { verdict, confidence, reasoning, unresolved_bugs = [] } = output;
  const isApproved = verdict === "APPROVED";

  console.log(
    `[reviewer] ${verdict} (${confidence}) — ${reasoning.slice(0, 120)}`,
  );

  const result: HandlerResult = {
    update: {
      holder: "reviewer",
      facts: [
        ...capsule.facts,
        `[reviewer:verdict] ${JSON.stringify(output)}`,
        `[reviewer] ${verdict} (confidence=${confidence}): ${reasoning}`,
        ...(unresolved_bugs.length
          ? [`[reviewer] Unresolved bugs: ${unresolved_bugs.join(", ")}`]
          : []),
      ],
      decisions: [
        ...capsule.decisions,
        `[reviewer] ${verdict} — patch ${isApproved ? "accepted" : "rejected"}`,
      ],
      next_action: isApproved ? "pipeline-complete" : "needs-rework",
    },
    // Terminal stage — no next_holder
  };

  return result;
};
