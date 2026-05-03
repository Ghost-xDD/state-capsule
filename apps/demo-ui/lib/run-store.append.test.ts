import { describe, it, expect } from "vitest";
import { create, append, get, markDone } from "./run-store";

describe("run-store append (stdout chunking)", () => {
  it("parses [patcher] Applied N fix(es) when the line is split across chunks", () => {
    const taskId = crypto.randomUUID();
    create(taskId, "https://github.com/a/b", "x.ts");
    append(taskId, "[patcher] Applied ");
    expect(get(taskId)!.agents.patcher.count).toBeNull();
    append(taskId, "3 fix(es): bug-1, bug-2, bug-3\n");
    expect(get(taskId)!.agents.patcher.count).toBe(3);
    expect(get(taskId)!.agents.patcher.summary).toBe("3 fixes applied");
  });

  it("still parses when the bracket is split (worst-case flush boundary)", () => {
    const taskId = crypto.randomUUID();
    create(taskId, "https://github.com/a/b", "x.ts");
    append(taskId, "[patc");
    append(taskId, "her] Applied 2 fix(es): a, b\n");
    expect(get(taskId)!.agents.patcher.count).toBe(2);
  });

  it("one chunk with newline unchanged", () => {
    const taskId = crypto.randomUUID();
    create(taskId, "https://github.com/a/b", "x.ts");
    append(taskId, "[patcher] Applied 1 fix(es): bug-1\n");
    expect(get(taskId)!.agents.patcher.count).toBe(1);
  });

  it("flush trailing line without newline on markDone", () => {
    const taskId = crypto.randomUUID();
    create(taskId, "https://github.com/a/b", "x.ts");
    append(taskId, "[patcher] Applied 4 fix(es): a, b, c, d");
    expect(get(taskId)!.agents.patcher.count).toBeNull();
    markDone(taskId);
    expect(get(taskId)!.agents.patcher.count).toBe(4);
  });
});
