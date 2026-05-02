/**
 * ens.test.ts — Unit tests for the state-capsule-ens package.
 *
 * Uses a mock NameStone registrar (no HTTP calls).
 * Covers:
 *   1. NameStoneRegistrar: issueSubname, setTextRecords, resolveSubname, burnSubname
 *   2. TaskPointer: publish, update, resolve, burn
 *   3. DelegationManager: issueDelegation, verifyDelegation (valid + expired), revokeDelegation
 *   4. buildEnsUpdateHook: no-op when registrar is null; updates when configured
 *   5. createRegistrarFromEnv: returns null when env vars absent
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NameStoneConfig } from "../src/registrar.js";
import { NameStoneRegistrar, createRegistrarFromEnv } from "../src/registrar.js";
import { TaskPointer, taskLabel, buildEnsUpdateHook } from "../src/task-pointer.js";
import { DelegationManager, buildDelegationIssuer, buildDelegationRevoker } from "../src/delegation.js";

// ── Mock registrar ────────────────────────────────────────────────────────────

/** In-memory NameStone registrar for unit tests (no HTTP). */
class MockRegistrar extends NameStoneRegistrar {
  public store: Map<string, Record<string, string>> = new Map();
  public calls: Array<{ method: string; args: unknown[] }> = [];

  constructor() {
    // Provide dummy config — we override all methods, so it's never used.
    super({ apiKey: "test-key", domain: "test.eth" } as NameStoneConfig);
    // Expose domain for TaskPointer and DelegationManager internals.
    (this as unknown as { cfg: { domain: string } }).cfg = { domain: "test.eth" };
  }

  override async issueSubname(label: string, textRecords: Record<string, string>): Promise<string> {
    this.calls.push({ method: "issueSubname", args: [label, textRecords] });
    this.store.set(label, { ...textRecords });
    return `${label}.test.eth`;
  }

  override async setTextRecords(label: string, textRecords: Record<string, string>): Promise<void> {
    this.calls.push({ method: "setTextRecords", args: [label, textRecords] });
    const existing = this.store.get(label) ?? {};
    this.store.set(label, { ...existing, ...textRecords });
  }

  override async resolveSubname(label: string): Promise<Record<string, string> | null> {
    this.calls.push({ method: "resolveSubname", args: [label] });
    return this.store.get(label) ?? null;
  }

  override async burnSubname(label: string): Promise<void> {
    this.calls.push({ method: "burnSubname", args: [label] });
    this.store.delete(label);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("NameStoneRegistrar (mock)", () => {
  let reg: MockRegistrar;
  beforeEach(() => { reg = new MockRegistrar(); });

  it("issueSubname stores records and returns full name", async () => {
    const name = await reg.issueSubname("task-abc", { "capsule.holder": "triager" });
    expect(name).toBe("task-abc.test.eth");
    expect(reg.store.get("task-abc")).toEqual({ "capsule.holder": "triager" });
  });

  it("setTextRecords merges into existing records", async () => {
    await reg.issueSubname("task-abc", { a: "1", b: "2" });
    await reg.setTextRecords("task-abc", { b: "updated", c: "3" });
    expect(reg.store.get("task-abc")).toEqual({ a: "1", b: "updated", c: "3" });
  });

  it("resolveSubname returns null for unknown label", async () => {
    expect(await reg.resolveSubname("nonexistent")).toBeNull();
  });

  it("burnSubname removes the label", async () => {
    await reg.issueSubname("task-abc", { x: "1" });
    await reg.burnSubname("task-abc");
    expect(reg.store.has("task-abc")).toBe(false);
  });
});

describe("TaskPointer", () => {
  let reg: MockRegistrar;
  let tp:  TaskPointer;
  beforeEach(() => { reg = new MockRegistrar(); tp = new TaskPointer(reg); });

  it("taskLabel: produces task-<8-char slug>", () => {
    expect(taskLabel("1234-5678-abcd")).toBe("task-12345678");
    expect(taskLabel("abc")).toBe("task-abc");
  });

  it("publish: issues subname with all capsule fields", async () => {
    const TASK_ID = "mytask-1234-5678";
    const name = await tp.publish(TASK_ID, {
      "capsule.head":     "0xcafe",
      "capsule.holder":   "triager",
      "capsule.log_root": "0xbeef",
      "capsule.status":   "active",
    });

    const label = taskLabel(TASK_ID);
    expect(name).toBe(`${label}.test.eth`);

    const stored = reg.store.get(label)!;
    expect(stored["capsule.holder"]).toBe("triager");
    expect(stored["capsule.task_id"]).toBe(TASK_ID);
  });

  it("resolve: returns structured pointer or null", async () => {
    const TASK_ID = "resolve-test";
    await tp.publish(TASK_ID, {
      "capsule.head":     "0x01",
      "capsule.holder":   "patcher",
      "capsule.log_root": "0x02",
      "capsule.status":   "active",
    });

    const resolved = await tp.resolve(TASK_ID);
    expect(resolved).not.toBeNull();
    expect(resolved!["capsule.holder"]).toBe("patcher");
    expect(resolved!.label).toBe(taskLabel(TASK_ID));
    expect(resolved!.full_name).toContain("test.eth");

    expect(await tp.resolve("nonexistent-task")).toBeNull();
  });

  it("burn: removes the subname", async () => {
    const TASK_ID = "burn-test";
    await tp.publish(TASK_ID, {
      "capsule.head": "x", "capsule.holder": "reviewer",
      "capsule.log_root": "y", "capsule.status": "done",
    });
    await tp.burn(TASK_ID);
    expect(reg.store.has(taskLabel(TASK_ID))).toBe(false);
  });
});

describe("DelegationManager", () => {
  let reg: MockRegistrar;
  let dm:  DelegationManager;
  beforeEach(() => { reg = new MockRegistrar(); dm = new DelegationManager(reg); });

  it("issueDelegation: stores delegation records", async () => {
    const capsuleRef = "0xaabbccdd1122334455667788";
    const label = await dm.issueDelegation(capsuleRef, "triager", "reproducer", 3600);
    expect(label).toMatch(/^handoff-/);

    const stored = reg.store.get(label)!;
    expect(stored["delegation.capsule_ref"]).toBe(capsuleRef);
    expect(stored["delegation.from_role"]).toBe("triager");
    expect(stored["delegation.to_role"]).toBe("reproducer");
    expect(new Date(stored["delegation.expiry"]!).getTime()).toBeGreaterThan(Date.now());
  });

  it("verifyDelegation: returns valid=true for unexpired delegation", async () => {
    const capsuleRef = "0xfeed1234abcd5678feed";
    await dm.issueDelegation(capsuleRef, "patcher", "reviewer", 3600);
    const result = await dm.verifyDelegation(capsuleRef);

    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
    expect(result!["delegation.from_role"]).toBe("patcher");
    expect(result!["delegation.to_role"]).toBe("reviewer");
  });

  it("verifyDelegation: returns valid=false for expired delegation", async () => {
    const capsuleRef = "0xdeadbeef";
    const label = `handoff-${capsuleRef.replace(/^0x/, "").slice(0, 8)}`;
    // Manually insert an expired delegation
    reg.store.set(label, {
      "delegation.capsule_ref": capsuleRef,
      "delegation.from_role":   "triager",
      "delegation.to_role":     "reproducer",
      "delegation.expiry":      new Date(Date.now() - 60_000).toISOString(), // 1 min ago
    });

    const result = await dm.verifyDelegation(capsuleRef);
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(false);
  });

  it("verifyDelegation: returns null if subname not found", async () => {
    expect(await dm.verifyDelegation("0xnonexistent")).toBeNull();
  });

  it("revokeDelegation: burns the subname", async () => {
    const capsuleRef = "0x1234567890abcdef";
    await dm.issueDelegation(capsuleRef, "triager", "reproducer");
    const label = `handoff-${capsuleRef.replace(/^0x/, "").slice(0, 8)}`;
    expect(reg.store.has(label)).toBe(true);
    await dm.revokeDelegation(capsuleRef);
    expect(reg.store.has(label)).toBe(false);
  });
});

describe("buildEnsUpdateHook", () => {
  it("returns no-op function when registrar is null", async () => {
    const hook = buildEnsUpdateHook(null);
    // Should not throw
    await hook({ task_id: "x", capsule_id: "y", holder: "triager", log_root: null });
  });

  it("calls registrar.issueSubname on update", async () => {
    const reg   = new MockRegistrar();
    const hook  = buildEnsUpdateHook(reg);
    await hook({
      task_id:     "my-task-abc123",
      capsule_id:  "0xcapsule",
      holder:      "reproducer",
      log_root:    "0xlog",
      next_action: "patch",
    });

    const label   = taskLabel("my-task-abc123");
    const stored  = reg.store.get(label);
    expect(stored).toBeDefined();
    expect(stored!["capsule.holder"]).toBe("reproducer");
    expect(stored!["capsule.status"]).toBe("active");
  });

  it("marks status=done when next_action=pipeline-complete", async () => {
    const reg  = new MockRegistrar();
    const hook = buildEnsUpdateHook(reg);
    await hook({
      task_id:     "done-task",
      capsule_id:  "0xfinal",
      holder:      "reviewer",
      log_root:    null,
      next_action: "pipeline-complete",
    });
    expect(reg.store.get(taskLabel("done-task"))!["capsule.status"]).toBe("done");
  });
});

describe("createRegistrarFromEnv", () => {
  it("returns null when API key is absent", () => {
    const orig = process.env["NAMESTONE_API_KEY"];
    delete process.env["NAMESTONE_API_KEY"];
    expect(createRegistrarFromEnv()).toBeNull();
    if (orig !== undefined) process.env["NAMESTONE_API_KEY"] = orig;
  });

  it("returns a NameStoneRegistrar when both vars are set", () => {
    const origKey    = process.env["NAMESTONE_API_KEY"];
    const origDomain = process.env["ENS_PARENT_NAME"];
    process.env["NAMESTONE_API_KEY"] = "test-key";
    process.env["ENS_PARENT_NAME"]   = "maintainerswarm.eth";
    const result = createRegistrarFromEnv();
    expect(result).toBeInstanceOf(NameStoneRegistrar);
    if (origKey    !== undefined) process.env["NAMESTONE_API_KEY"] = origKey;    else delete process.env["NAMESTONE_API_KEY"];
    if (origDomain !== undefined) process.env["ENS_PARENT_NAME"]   = origDomain; else delete process.env["ENS_PARENT_NAME"];
  });
});

describe("graceful wrappers (buildDelegationIssuer / buildDelegationRevoker)", () => {
  it("buildDelegationIssuer: returns undefined when registrar is null", async () => {
    const issuer = buildDelegationIssuer(null);
    expect(await issuer("0xref", "triager", "reproducer")).toBeUndefined();
  });

  it("buildDelegationRevoker: no-op when registrar is null", async () => {
    const revoker = buildDelegationRevoker(null);
    await revoker("0xref"); // must not throw
  });

  it("buildDelegationIssuer: returns label when registrar is provided", async () => {
    const reg    = new MockRegistrar();
    const issuer = buildDelegationIssuer(reg);
    const label  = await issuer("0xabc123", "triager", "reproducer");
    expect(typeof label).toBe("string");
    expect(label).toMatch(/^handoff-/);
  });
});
