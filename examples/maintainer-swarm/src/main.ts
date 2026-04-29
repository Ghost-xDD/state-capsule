/**
 * main.ts — Container entrypoint for each MaintainerSwarm agent.
 *
 * Reads AGENT_ROLE from env, resolves peer IDs from the shared /peers/ volume
 * (written by each container's entrypoint.sh after AXL starts), and begins
 * the AgentRuntime with the echo handler.
 */

import { readFileSync } from "node:fs";
import { AgentRuntime, type AgentRole } from "./runtime.js";
import { echoHandler } from "./handlers/echo.js";
import { axlUrlFromEnv } from "@state-capsule/sdk";

const VALID_ROLES: AgentRole[] = ["triager", "reproducer", "patcher", "reviewer"];
const PEERS_DIR = process.env["PEERS_DIR"] ?? "/peers";

function requireRole(): AgentRole {
  const role = process.env["AGENT_ROLE"];
  if (!role || !VALID_ROLES.includes(role as AgentRole)) {
    console.error(`AGENT_ROLE must be one of: ${VALID_ROLES.join(", ")}. Got: "${role}"`);
    process.exit(1);
  }
  return role as AgentRole;
}

function readPeerRegistry(): Partial<Record<AgentRole, string>> {
  const result: Partial<Record<AgentRole, string>> = {};
  for (const role of VALID_ROLES) {
    // Env var takes precedence (useful for tests)
    const envVal = process.env[`PEER_ID_${role.toUpperCase()}`];
    if (envVal) { result[role] = envVal; continue; }

    // Read from shared /peers/ registry file written by entrypoint.sh
    try {
      const id = readFileSync(`${PEERS_DIR}/${role}`, "utf8").trim();
      if (id) result[role] = id;
    } catch { /* file not yet written — will discover via mesh */ }
  }
  return result;
}

async function main() {
  const role   = requireRole();
  const axlUrl = axlUrlFromEnv();

  console.log(`[main] Starting ${role} agent`);
  console.log(`[main] AXL URL: ${axlUrl}`);

  const roleToPeerId = readPeerRegistry();
  const knownRoles   = Object.keys(roleToPeerId);
  console.log(`[main] Known peer IDs: [${knownRoles.join(", ")}]`);

  const runtime = new AgentRuntime({
    role,
    axlUrl,
    pollIntervalMs: 500,
    roleToPeerId:   roleToPeerId as Record<AgentRole, string>,
    ...(process.env["CAPSULE_PRIVATE_KEY"] ? { privateKey: process.env["CAPSULE_PRIVATE_KEY"] } : {}),
  });

  runtime.register(echoHandler);

  process.on("SIGTERM", () => { runtime.stop(); process.exit(0); });
  process.on("SIGINT",  () => { runtime.stop(); process.exit(0); });

  await runtime.start();
}

main().catch((err) => {
  console.error("[main] Fatal:", err);
  process.exit(1);
});
