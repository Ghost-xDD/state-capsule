/**
 * State Capsule × LangChain adapter.
 *
 * Two integration points:
 *   1. StateCapsuleMemory  — BaseMemory subclass. Plug directly into any
 *                            LangChain chain or agent as the `memory:` option.
 *   2. withCapsuleMemory   — higher-order function that wraps any Runnable
 *                            and calls saveContext after every invocation.
 *
 * Usage:
 *   import { StateCapsuleMemory } from "@state-capsule/adapter-langchain";
 *   const memory = new StateCapsuleMemory(sdk, { taskId: "fix-bug", holder: "agent" });
 *   const chain  = prompt.pipe(llm).pipe(parser);
 *   const result = await chain.invoke({ input: "plan?" }, { memory });
 */

import { BaseMemory }       from "@langchain/core/memory";
import type { InputValues, MemoryVariables, OutputValues } from "@langchain/core/memory";
import type { StateCapsule, Capsule } from "@state-capsule/sdk";

export type { StateCapsule, Capsule };

// ── Options ───────────────────────────────────────────────────────────────────

export interface StateCapsuleMemoryOptions {
  /** Unique task ID. */
  taskId: string;
  /** Agent role / holder identity. */
  holder: string;
  /** Goal text for the genesis capsule. Defaults to `taskId`. */
  goal?: string;
  /** Variable key injected into chain inputs. Default: "capsule_context". */
  memoryKey?: string;
}

// ── StateCapsuleMemory ────────────────────────────────────────────────────────

/**
 * LangChain `BaseMemory` subclass backed by State Capsule.
 *
 * `loadMemoryVariables` → restores the latest capsule, returns structured
 *   context string under `memoryKey`.
 * `saveContext`         → checkpoints input + output as a new capsule update.
 */
export class StateCapsuleMemory extends BaseMemory {
  readonly sdk: StateCapsule;

  private readonly _opts: Required<StateCapsuleMemoryOptions>;
  private _capsuleId: string | null = null;

  override get memoryKeys(): string[] {
    return [this._opts.memoryKey];
  }

  constructor(sdk: StateCapsule, opts: StateCapsuleMemoryOptions) {
    super();
    this.sdk   = sdk;
    this._opts = {
      taskId:    opts.taskId,
      holder:    opts.holder,
      goal:      opts.goal      ?? `LangChain task: ${opts.taskId}`,
      memoryKey: opts.memoryKey ?? "capsule_context",
    };
  }

  override async loadMemoryVariables(_values: InputValues): Promise<MemoryVariables> {
    try {
      const capsule       = await this.sdk.restoreCapsule(this._opts.taskId);
      this._capsuleId     = capsule.capsule_id;
      return { [this._opts.memoryKey]: _capsuleToContext(capsule) };
    } catch {
      return { [this._opts.memoryKey]: "" };
    }
  }

  override async saveContext(
    inputValues:  InputValues,
    outputValues: OutputValues,
  ): Promise<void> {
    const inputText  = String(inputValues["input"]  ?? JSON.stringify(inputValues));
    const outputText = String(outputValues["output"] ?? JSON.stringify(outputValues));

    let capsule: Capsule;
    if (!this._capsuleId) {
      capsule = await this.sdk.createCapsule({
        task_id:   this._opts.taskId,
        goal:      this._opts.goal,
        holder:    this._opts.holder,
        facts:     [`input: ${inputText}`],
        decisions: [`output: ${outputText}`],
      });
    } else {
      const prev = await this.sdk.restoreCapsule(this._opts.taskId);
      capsule = await this.sdk.updateCapsule({
        task_id:           this._opts.taskId,
        parent_capsule_id: this._capsuleId,
        holder:            this._opts.holder,
        facts:             [...prev.facts,     `input: ${inputText}`],
        decisions:         [...prev.decisions, `output: ${outputText}`],
      });
    }
    this._capsuleId = capsule.capsule_id;
  }

  override async clear(): Promise<void> {
    this._capsuleId = null;
  }
}

// ── Runnable wrapper ──────────────────────────────────────────────────────────

export interface SimpleRunnable<I, O> {
  invoke(input: I): Promise<O>;
}

/**
 * Wrap any LangChain Runnable so every successful invocation is checkpointed
 * via `memory.saveContext`.
 *
 * @example
 *   const chain   = RunnableSequence.from([prompt, llm, parser]);
 *   const wrapped = withCapsuleMemory(chain, memory, {
 *     toInput:  (i) => ({ input: i }),
 *     toOutput: (o) => ({ output: String(o) }),
 *   });
 *   const result = await wrapped.invoke("what's the plan?");
 */
export function withCapsuleMemory<I, O>(
  runnable: SimpleRunnable<I, O>,
  memory:   StateCapsuleMemory,
  opts?: {
    toInput?:  (i: I) => InputValues;
    toOutput?: (o: O) => OutputValues;
  },
): SimpleRunnable<I, O> {
  return {
    async invoke(input: I): Promise<O> {
      const output = await runnable.invoke(input);
      const iv = opts?.toInput  ? opts.toInput(input)   : (input  as unknown as InputValues);
      const ov = opts?.toOutput ? opts.toOutput(output) : (output as unknown as OutputValues);
      await memory.saveContext(iv, ov);
      return output;
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _capsuleToContext(c: {
  goal:            string;
  facts:           string[];
  decisions:       string[];
  pending_actions: string[];
  next_action:     string;
}): string {
  const parts: string[] = [`Goal: ${c.goal}`];
  if (c.facts.length)           parts.push(`Facts:\n${c.facts.map(f => `- ${f}`).join("\n")}`);
  if (c.decisions.length)       parts.push(`Decisions:\n${c.decisions.map(d => `- ${d}`).join("\n")}`);
  if (c.pending_actions.length) parts.push(`Pending:\n${c.pending_actions.map(a => `- ${a}`).join("\n")}`);
  if (c.next_action)            parts.push(`Next: ${c.next_action}`);
  return parts.join("\n\n");
}
