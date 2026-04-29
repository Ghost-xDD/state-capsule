/**
 * main.ts — Container entrypoint for each MaintainerSwarm agent.
 *
 * Reads AGENT_ROLE from env and starts the AgentRuntime with the echo handler.
 * Phase 4 will swap echoHandler for the specialist handler for each role.
 */

import { AgentRuntime, resolveRolePeerIds, type AgentRole } from "./runtime.js";
import { echoHandler } from "./handlers/echo.js";
import { axlUrlFromEnv } from "@state-capsule/sdk";

const VALID_ROLES: AgentRole[] = ["triager", "reproducer", "patcher", "reviewer"];

function requireRole(): AgentRole {
  const role = process.env["AGENT_ROLE"];
  if (!role || !VALID_ROLES.includes(role as AgentRole)) {
    console.error(`AGENT_ROLE must be one of: ${VALID_ROLES.join(", ")}. Got: "${role}"`);
    process.exit(1);
  }
  return role as AgentRole;
}

async function main() {
  const role   = requireRole();
  const axlUrl = axlUrlFromEnv();

  console.log(`[main] Starting ${role} agent`);
  console.log(`[main] AXL URL: ${axlUrl}`);

  // Build runtime
  const runtime = new AgentRuntime({
    role,
    axlUrl,
    privateKey: process.env["CAPSULE_PRIVATE_KEY"],
    pollIntervalMs: 500,
  });

  // Resolve peer IDs for all roles from env vars (set in docker-compose)
  const { AxlClient } = await import("@state-capsule/sdk");
  const axl = new AxlClient({ baseUrl: axlUrl });
  const roleToPeerId = await resolveRolePeerIds(axl, VALID_ROLES);
  runtime["config"].roleToPeerId = roleToPeerId;

  // Register handler (echo for Phase 3; specialist for Phase 4)
  runtime.register(echoHandler);

  // Graceful shutdown
  process.on("SIGTERM", () => { runtime.stop(); process.exit(0); });
  process.on("SIGINT",  () => { runtime.stop(); process.exit(0); });

  await runtime.start();
}

main().catch((err) => {
  console.error("[main] Fatal:", err);
  process.exit(1);
});
