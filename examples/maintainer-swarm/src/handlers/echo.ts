/**
 * echo.ts — Placeholder handler for Phase 3.
 *
 * Every role uses this handler. It:
 *   1. Appends { role, received_at } to capsule facts
 *   2. Sets next_action to "forwarded by <role>"
 *   3. Returns the next role in the pipeline
 *
 * This proves the round-trip without any real agent intelligence.
 * Phase 4 replaces this with specialist handlers.
 */

import type { Handler, AgentRole } from "../runtime.js";

const PIPELINE: AgentRole[] = ["triager", "reproducer", "patcher", "reviewer"];

export const echoHandler: Handler = async ({ capsule, role }) => {
  const received_at = new Date().toISOString();

  const currentIdx = PIPELINE.indexOf(role);
  const nextRole   = currentIdx >= 0 && currentIdx < PIPELINE.length - 1
    ? PIPELINE[currentIdx + 1]
    : undefined;

  return {
    update: {
      holder:      role,
      facts:       [
        ...capsule.facts,
        `[${role}] echo received_at=${received_at}`,
      ],
      decisions:   [
        ...capsule.decisions,
        `[${role}] no-op (echo handler)`,
      ],
      next_action: `forwarded by ${role}`,
    },
    next_holder: nextRole,
  };
};
