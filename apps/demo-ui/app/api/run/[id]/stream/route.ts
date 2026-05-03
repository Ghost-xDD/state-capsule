import { NextRequest } from "next/server";
import * as runStore from "@/lib/run-store";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const taskId = params.id;

  // EventSource auto-reconnects after the server closes the stream. Respect
  // the standard `Last-Event-ID` header so reconnects resume from the next
  // unread line instead of replaying everything (which made the UI look like
  // the pipeline ran twice).
  const lastIdHeader = req.headers.get("last-event-id");
  const lastEventId  = lastIdHeader ? parseInt(lastIdHeader, 10) : -1;
  let cursor = Number.isFinite(lastEventId) && lastEventId >= 0 ? lastEventId + 1 : 0;
  let activityCursor = 0;

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;

      function send(id: number | null, payload: object) {
        if (closed) return;
        const idLine = id !== null ? `id: ${id}\n` : "";
        controller.enqueue(
          enc.encode(`${idLine}data: ${JSON.stringify(payload)}\n\n`),
        );
      }

      controller.enqueue(enc.encode("retry: 86400000\n\n"));

      // Hash the agent state so we only emit when something actually changed.
      // Using `pulse` (incremented on every mutation in run-store) gives us a
      // cheap dirty-bit per agent.
      let lastAgentSig = "";

      function tick() {
        if (closed) return;
        const entry = runStore.get(taskId);

        if (!entry) {
          send(null, { type: "error", msg: "Run not found" });
          closed = true;
          controller.close();
          return;
        }

        // 1) Stream raw lines (still useful for the collapsible debug panel).
        while (cursor < entry.lines.length) {
          const idx  = cursor;
          const line = entry.lines[idx]!;
          send(idx, { type: "line", text: line });
          cursor++;
        }

        // 2) Stream structured agent state when it changes.
        const sig = (Object.values(entry.agents) as { pulse: number }[])
          .map((a) => a.pulse)
          .join(",");
        if (sig !== lastAgentSig) {
          send(null, {
            type:    "agents",
            agents:  entry.agents,
            capsule: entry.capsule,
          });
          lastAgentSig = sig;
        }

        // 3) Stream new activity events.
        while (activityCursor < entry.activity.length) {
          const ev = entry.activity[activityCursor]!;
          send(null, { type: "activity", event: ev });
          activityCursor++;
        }

        if (entry.done) {
          send(null, {
            type:    "done",
            capsule: entry.capsule,
            agents:  entry.agents,
            error:   entry.error,
            elapsed: Date.now() - entry.startedAt,
          });
          closed = true;
          controller.close();
          return;
        }

        setTimeout(tick, 150);
      }

      req.signal.addEventListener("abort", () => {
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      });

      tick();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":   "text/event-stream",
      "Cache-Control":  "no-cache, no-transform",
      Connection:       "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
