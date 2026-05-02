/**
 * task-pointer.ts — ENS task pointer management.
 *
 * Each task gets an ENS subname whose text records expose the live capsule
 * state so any agent (or human) can find the current head with a name lookup.
 *
 * Subname format: task-<8-char task_id prefix>.<parent>
 *   e.g. task-1a2b3c4d.maintainerswarm.eth
 *
 * Text records:
 *   capsule.head      — latest capsule_id (content-addressed)
 *   capsule.holder    — agent role currently holding the capsule
 *   capsule.log_root  — 0G Log root hash
 *   capsule.status    — "active" | "held" | "done"
 *   capsule.task_id   — the full task_id for programmatic lookup
 *
 * All writes are wrapped in try/catch — ENS failure never propagates to the
 * caller. The capsule write path is never gated on ENS.
 */

import type { NameStoneRegistrar } from "./registrar.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TaskPointerRecords {
  "capsule.head":     string;
  "capsule.holder":   string;
  "capsule.log_root": string;
  "capsule.status":   string;
  "capsule.task_id"?: string;
}

export interface ResolvedTaskPointer {
  label:              string;   // e.g. "task-1a2b3c4d"
  full_name:          string;   // e.g. "task-1a2b3c4d.maintainerswarm.eth"
  "capsule.head":     string;
  "capsule.holder":   string;
  "capsule.log_root": string;
  "capsule.status":   string;
  "capsule.task_id"?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Derive the subname label from a task_id.
 * Uses the first 8 characters for a compact, collision-resistant label.
 */
export function taskLabel(task_id: string): string {
  const slug = task_id.replace(/-/g, "").slice(0, 8);
  return `task-${slug}`;
}

// ── TaskPointer ───────────────────────────────────────────────────────────────

export class TaskPointer {
  constructor(private registrar: NameStoneRegistrar) {}

  /**
   * Publish a new task pointer. Idempotent — safe to call on any update.
   * Returns the full ENS name (label + parent).
   */
  async publish(
    task_id: string,
    records: TaskPointerRecords,
  ): Promise<string> {
    const label       = taskLabel(task_id);
    const textRecords = {
      ...records,
      "capsule.task_id": task_id,
    };
    return this.registrar.issueSubname(label, textRecords);
  }

  /**
   * Update the text records on an existing task pointer.
   * Merges with the provided partial records; callers supply all relevant fields.
   */
  async update(
    task_id:  string,
    records:  Partial<TaskPointerRecords>,
  ): Promise<void> {
    const label = taskLabel(task_id);
    // NameStone upserts all fields; pass what we have.
    await this.registrar.setTextRecords(label, records as Record<string, string>);
  }

  /**
   * Resolve the current text records for a task pointer.
   * Returns null if the task pointer does not exist.
   */
  async resolve(task_id: string): Promise<ResolvedTaskPointer | null> {
    const label   = taskLabel(task_id);
    const records = await this.registrar.resolveSubname(label);
    if (!records) return null;

    const domain    = (this.registrar as unknown as { cfg: { domain: string } }).cfg?.domain ?? "";
    const full_name = domain ? `${label}.${domain}` : label;

    const result: ResolvedTaskPointer = {
      label,
      full_name,
      "capsule.head":     records["capsule.head"]     ?? "",
      "capsule.holder":   records["capsule.holder"]   ?? "",
      "capsule.log_root": records["capsule.log_root"] ?? "",
      "capsule.status":   records["capsule.status"]   ?? "",
    };
    const tid = records["capsule.task_id"];
    if (tid !== undefined) result["capsule.task_id"] = tid;
    return result;
  }

  /**
   * Remove the task pointer (e.g. when a task is archived).
   */
  async burn(task_id: string): Promise<void> {
    await this.registrar.burnSubname(taskLabel(task_id));
  }
}

// ── Graceful wrapper ──────────────────────────────────────────────────────────

/**
 * Build an ENS update function suitable for use as the SDK's `onAfterUpdate` hook.
 *
 * Returns a function that:
 *   - Publishes / updates the task pointer on every capsule write
 *   - Never throws — logs a warning on failure
 *   - Is a no-op if registrar is null (env vars not configured)
 */
export function buildEnsUpdateHook(
  registrar: NameStoneRegistrar | null,
): ((capsule: {
  task_id:    string;
  capsule_id: string;
  holder:     string;
  log_root:   string | null;
  next_action?: string;
}) => Promise<void>) {
  if (!registrar) {
    return async () => {};
  }

  const pointer = new TaskPointer(registrar);

  return async (capsule) => {
    try {
      const status = capsule.next_action === "pipeline-complete" ? "done" : "active";
      await pointer.publish(capsule.task_id, {
        "capsule.head":     capsule.capsule_id,
        "capsule.holder":   capsule.holder,
        "capsule.log_root": capsule.log_root ?? "",
        "capsule.status":   status,
      });
    } catch (err) {
      console.warn(`[ens] task-pointer update failed (non-fatal): ${err}`);
    }
  };
}
