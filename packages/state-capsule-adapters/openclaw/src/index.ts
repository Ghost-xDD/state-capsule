/**
 * State Capsule × OpenClaw adapter.
 *
 * Wraps StateCapsule as OpenClaw's working memory: each memory flush is
 * checkpointed as a signed capsule on 0G Storage, giving every agent session
 * cryptographic continuity and cross-process restore.
 *
 * Usage:
 *   import { createStateCapsuleMemory } from "@state-capsule/adapter-openclaw";
 *   const memory = createStateCapsuleMemory(sdk, { taskId: "my-task", holder: "agent" });
 *   const md     = await memory.read();          // inject into system prompt
 *   await memory.write(md + "\n- new fact");     // flush after session turn
 */

import type { StateCapsule, Capsule } from "@state-capsule/sdk";

export type { StateCapsule, Capsule };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OpenClawMemoryOptions {
  /** Unique task or session ID. */
  taskId: string;
  /** Agent role / holder identity (e.g. "assistant", "triager"). */
  holder: string;
  /** Goal text for the genesis capsule. Defaults to `taskId`. */
  goal?: string;
  /** Optional hook called after every successful capsule write. */
  onWrite?: (capsule: Capsule) => void | Promise<void>;
}

export interface MemorySnapshot {
  taskId:    string;
  holder:    string;
  capsuleId: string;
  updatedAt: string;
}

// ── StateCapsuleMemory ────────────────────────────────────────────────────────

/**
 * OpenClaw-compatible memory adapter backed by State Capsule.
 *
 * - `read()`  — restore the latest capsule, render as Markdown.
 * - `write()` — create/update a capsule with the structured Markdown memory.
 * - `clear()` — reset in-memory head pointer (capsule chain is immutable).
 */
export class StateCapsuleMemory {
  private readonly sdk:  StateCapsule;
  private readonly opts: Required<Pick<OpenClawMemoryOptions, "taskId" | "holder" | "goal">>
                       & Pick<OpenClawMemoryOptions, "onWrite">;
  private _capsuleId: string | null = null;

  constructor(sdk: StateCapsule, opts: OpenClawMemoryOptions) {
    this.sdk  = sdk;
    this.opts = {
      taskId: opts.taskId,
      holder: opts.holder,
      goal:   opts.goal ?? `OpenClaw session: ${opts.taskId}`,
      onWrite: opts.onWrite,
    };
  }

  /**
   * Restore the latest memory snapshot as a Markdown string.
   * Returns an empty string if no capsule exists yet.
   */
  async read(): Promise<string> {
    try {
      const capsule = await this.sdk.restoreCapsule(this.opts.taskId);
      this._capsuleId = capsule.capsule_id;
      return _capsuleToMarkdown(capsule);
    } catch {
      return "";
    }
  }

  /**
   * Persist a Markdown memory blob as a new capsule link in the chain.
   * Creates the genesis capsule on the first call; extends the chain thereafter.
   */
  async write(content: string): Promise<MemorySnapshot> {
    const fields = _markdownToCapsuleFields(content);
    let capsule: Capsule;

    if (!this._capsuleId) {
      capsule = await this.sdk.createCapsule({
        task_id: this.opts.taskId,
        goal:    this.opts.goal,
        holder:  this.opts.holder,
        ...fields,
      });
    } else {
      capsule = await this.sdk.updateCapsule({
        task_id:           this.opts.taskId,
        parent_capsule_id: this._capsuleId,
        holder:            this.opts.holder,
        ...fields,
      });
    }

    this._capsuleId = capsule.capsule_id;
    if (this.opts.onWrite) await this.opts.onWrite(capsule);

    return {
      taskId:    capsule.task_id,
      holder:    capsule.holder,
      capsuleId: capsule.capsule_id,
      updatedAt: capsule.created_at,
    };
  }

  /**
   * Reset the in-memory head pointer.
   * Capsule chains are immutable; call `write("")` to emit an empty update.
   */
  async clear(): Promise<void> {
    this._capsuleId = null;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createStateCapsuleMemory(
  sdk:  StateCapsule,
  opts: OpenClawMemoryOptions,
): StateCapsuleMemory {
  return new StateCapsuleMemory(sdk, opts);
}

// ── Serialisation helpers ─────────────────────────────────────────────────────

interface CapsuleFields {
  facts:           string[];
  decisions:       string[];
  pending_actions: string[];
  next_action:     string;
}

function _capsuleToMarkdown(c: CapsuleFields & { goal?: string }): string {
  const lines: string[] = [];
  if (c.facts.length)           { lines.push("## Facts",           ...c.facts.map(f => `- ${f}`),           ""); }
  if (c.decisions.length)       { lines.push("## Decisions",       ...c.decisions.map(d => `- ${d}`),       ""); }
  if (c.pending_actions.length) { lines.push("## Pending Actions", ...c.pending_actions.map(a => `- ${a}`), ""); }
  if (c.next_action)            { lines.push(`## Next Action\n${c.next_action}`,                             ""); }
  return lines.join("\n").trimEnd();
}

function _markdownToCapsuleFields(md: string): CapsuleFields {
  const sections = md.split(/(?=^## )/m);

  const bullets = (heading: string): string[] =>
    (sections.find(s => s.startsWith(`## ${heading}`)) ?? "")
      .split("\n")
      .slice(1)
      .filter(l => l.startsWith("- "))
      .map(l => l.slice(2).trim());

  const naSection   = sections.find(s => s.startsWith("## Next Action"));
  const next_action = naSection?.split("\n").slice(1).find(l => l.trim()) ?? "";

  return {
    facts:           bullets("Facts"),
    decisions:       bullets("Decisions"),
    pending_actions: bullets("Pending Actions"),
    next_action,
  };
}
