/**
 * State Capsule × Vercel AI SDK adapter.
 *
 * Provides an `onStepFinish` handler that checkpoints every generation step
 * into a signed capsule on 0G Storage.  Drop it directly into `generateText`
 * or `streamText` — no other changes to your AI SDK code required.
 *
 * Usage:
 *   import { createCapsuleMiddleware } from "@state-capsule/adapter-vercel-ai";
 *
 *   const middleware = createCapsuleMiddleware(sdk, {
 *     taskId: "fix-bug-123",
 *     holder: "agent",
 *   });
 *
 *   const result = await generateText({
 *     model: openai("gpt-4o-mini"),
 *     prompt: "Fix this bug.",
 *     onStepFinish: middleware.onStepFinish,
 *   });
 *
 *   const capsule = await middleware.restore(); // full state after generation
 */

import type { StateCapsule, Capsule } from "@state-capsule/sdk";

export type { StateCapsule, Capsule };

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Minimal subset of the Vercel AI SDK `onStepFinish` event.
 * Kept narrow so the adapter compiles without `ai` as a compile-time dep.
 */
export interface StepFinishEvent {
  stepType?:    string;
  stepNumber?:  number;
  finishReason: string;
  usage?:       { promptTokens?: number; completionTokens?: number };
  text?:        string;
  toolCalls?:   Array<{ toolName: string; args: unknown; toolCallId?: string }>;
  toolResults?: Array<{ toolCallId?: string; result: unknown }>;
  isContinued?: boolean;
}

export interface CapsuleMiddlewareOptions {
  /** Unique task ID scoped to this agent run. */
  taskId:  string;
  /** Agent role / holder identity. */
  holder:  string;
  /** Goal text for the genesis capsule. Defaults to `taskId`. */
  goal?:   string;
  /** Fired after each capsule write — useful for logging or telemetry. */
  onCheckpoint?: (capsule: Capsule) => void | Promise<void>;
}

// ── CapsuleMiddleware ─────────────────────────────────────────────────────────

export class CapsuleMiddleware {
  private readonly sdk:  StateCapsule;
  private readonly opts: Required<Pick<CapsuleMiddlewareOptions, "taskId" | "holder" | "goal">>
                       & Pick<CapsuleMiddlewareOptions, "onCheckpoint">;

  private _capsuleId:  string   | null = null;
  private _stepBuffer: string[]        = [];

  constructor(sdk: StateCapsule, opts: CapsuleMiddlewareOptions) {
    this.sdk  = sdk;
    this.opts = {
      taskId:        opts.taskId,
      holder:        opts.holder,
      goal:          opts.goal ?? `Vercel AI task: ${opts.taskId}`,
      onCheckpoint:  opts.onCheckpoint,
    };
  }

  /**
   * Pass this as `onStepFinish` to `generateText` / `streamText`.
   *
   * Each step's text output is accumulated in `facts`.
   * Tool calls are recorded as `decisions`.
   * The final `finishReason` becomes `next_action`.
   */
  onStepFinish = async (event: StepFinishEvent): Promise<void> => {
    if (event.text?.trim()) this._stepBuffer.push(event.text.trim());

    const facts     = [...this._stepBuffer];
    const decisions = (event.toolCalls ?? []).map(
      tc => `tool:${tc.toolName}(${JSON.stringify(tc.args)})`,
    );
    const next_action     = event.isContinued ? "continue" : event.finishReason;
    const pending_actions = event.isContinued ? ["continue"] : [];

    let capsule: Capsule;
    if (!this._capsuleId) {
      capsule = await this.sdk.createCapsule({
        task_id:         this.opts.taskId,
        goal:            this.opts.goal,
        holder:          this.opts.holder,
        facts,
        decisions,
        pending_actions,
        next_action,
      });
    } else {
      capsule = await this.sdk.updateCapsule({
        task_id:           this.opts.taskId,
        parent_capsule_id: this._capsuleId,
        holder:            this.opts.holder,
        facts,
        decisions,
        pending_actions,
        next_action,
      });
    }

    this._capsuleId = capsule.capsule_id;
    if (this.opts.onCheckpoint) await this.opts.onCheckpoint(capsule);
  };

  /** Restore the latest checkpoint capsule. Returns `null` if none exists. */
  async restore(): Promise<Capsule | null> {
    try {
      return await this.sdk.restoreCapsule(this.opts.taskId);
    } catch {
      return null;
    }
  }

  /** Reset in-memory state. Does not delete persisted capsules. */
  reset(): void {
    this._capsuleId  = null;
    this._stepBuffer = [];
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createCapsuleMiddleware(
  sdk:  StateCapsule,
  opts: CapsuleMiddlewareOptions,
): CapsuleMiddleware {
  return new CapsuleMiddleware(sdk, opts);
}
