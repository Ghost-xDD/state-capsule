/**
 * spike-axl.ts
 *
 * De-risk: Boot 2 AXL daemons locally and confirm round-trip /send → /recv.
 *
 * Prerequisites:
 *   - AXL binary built from https://github.com/gensyn-ai/axl (make build)
 *   - Set AXL_BINARY_PATH in .env, or pass as first CLI arg
 *   - openssl available on PATH (for keygen)
 *
 * Usage:
 *   tsx scripts/spikes/spike-axl.ts [/path/to/axl/binary]
 *
 * What this proves:
 *   - Two AXL nodes can discover each other
 *   - POST /send delivers a message to the peer
 *   - GET /recv returns that message on the other end
 *   - Round-trip latency is within acceptable range for the demo
 */

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../../.env"), override: true });

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Config ──────────────────────────────────────────────────────────────────

const AXL_BINARY =
  process.argv[2] ??
  process.env["AXL_BINARY_PATH"] ??
  "../axl/node";

const NODE1_API_PORT = 9201;
const NODE1_LISTEN_PORT = 9211;
const NODE2_API_PORT = 9202;

const WORKSPACE = join(tmpdir(), "state-capsule-spike-axl");

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[spike-axl] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[spike-axl] FAIL: ${msg}`);
  process.exit(1);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function axlGet(port: number, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return res;
}

async function axlPost(
  port: number,
  path: string,
  body: string | Uint8Array,
  headers: Record<string, string> = {}
) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", ...headers },
    body,
  });
  return res;
}

async function getTopology(port: number): Promise<{ our_public_key: string }> {
  const res = await axlGet(port, "/topology");
  if (!res.ok) fail(`/topology on port ${port} returned ${res.status}`);
  return res.json() as Promise<{ our_public_key: string }>;
}

// ── Node management ──────────────────────────────────────────────────────────

function genKey(dir: string): string {
  const keyPath = join(dir, "private.pem");
  execSync(`openssl genpkey -algorithm ed25519 -out ${keyPath}`, {
    stdio: "ignore",
  });
  return keyPath;
}

function writeConfig(
  dir: string,
  keyPath: string,
  listenPort: number | null,
  apiPort: number,
  peers: string[]
) {
  const config: Record<string, unknown> = {
    PrivateKeyPath: keyPath,
    Peers: peers,
    Listen: listenPort ? [`tls://0.0.0.0:${listenPort}`] : [],
    api_port: apiPort,
  };
  const configPath = join(dir, "node-config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Verify binary exists
  if (!existsSync(AXL_BINARY)) {
    fail(
      `AXL binary not found at: ${AXL_BINARY}\n` +
        `  Build it with: cd $(dirname ${AXL_BINARY}) && make build\n` +
        `  Or set AXL_BINARY_PATH in .env`
    );
  }

  // Clean + create workspace
  if (existsSync(WORKSPACE)) rmSync(WORKSPACE, { recursive: true });
  mkdirSync(join(WORKSPACE, "node1"), { recursive: true });
  mkdirSync(join(WORKSPACE, "node2"), { recursive: true });

  log(`Workspace: ${WORKSPACE}`);

  // Generate keys
  const key1 = genKey(join(WORKSPACE, "node1"));
  const key2 = genKey(join(WORKSPACE, "node2"));
  log("Ed25519 keys generated for both nodes");

  // Node1 is the bootstrap hub; it listens on a fixed port
  const config1 = writeConfig(
    join(WORKSPACE, "node1"),
    key1,
    NODE1_LISTEN_PORT,
    NODE1_API_PORT,
    []
  );
  // Node2 peers to Node1
  const config2 = writeConfig(
    join(WORKSPACE, "node2"),
    key2,
    null,
    NODE2_API_PORT,
    [`tls://127.0.0.1:${NODE1_LISTEN_PORT}`]
  );

  // Start Node1
  log(`Starting Node1 (api=:${NODE1_API_PORT}, listen=:${NODE1_LISTEN_PORT})`);
  const proc1 = spawn(AXL_BINARY, ["-config", config1], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc1.stderr.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) process.stderr.write(`[node1] ${line}\n`);
  });

  // Wait for Node1 to be ready
  await sleep(2000);

  // Start Node2
  log(`Starting Node2 (api=:${NODE2_API_PORT})`);
  const proc2 = spawn(AXL_BINARY, ["-config", config2], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc2.stderr.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) process.stderr.write(`[node2] ${line}\n`);
  });

  // Wait for both to peer
  await sleep(3000);

  try {
    // Get peer IDs
    const topo1 = await getTopology(NODE1_API_PORT);
    const topo2 = await getTopology(NODE2_API_PORT);
    const peer1Id = topo1.our_public_key;
    const peer2Id = topo2.our_public_key;
    log(`Node1 peer ID: ${peer1Id}`);
    log(`Node2 peer ID: ${peer2Id}`);

    // Send a message from Node1 → Node2
    const payload = Buffer.from(`hello-from-node1-${Date.now()}`);
    const t0 = Date.now();

    const sendRes = await axlPost(
      NODE1_API_PORT,
      "/send",
      payload,
      { "X-Destination-Peer-Id": peer2Id }
    );
    if (!sendRes.ok) fail(`/send returned ${sendRes.status}`);
    const sentBytes = sendRes.headers.get("X-Sent-Bytes");
    log(`/send ok — ${sentBytes} bytes sent`);

    // Poll /recv on Node2 (up to 5s)
    let received = false;
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      const recvRes = await axlGet(NODE2_API_PORT, "/recv");
      if (recvRes.status === 204) continue;
      if (!recvRes.ok) fail(`/recv returned ${recvRes.status}`);

      const fromPeerId = recvRes.headers.get("X-From-Peer-Id");
      const body = Buffer.from(await recvRes.arrayBuffer()).toString();
      const latency = Date.now() - t0;

      log(`/recv ok — from=${fromPeerId} body="${body}" latency=${latency}ms`);

      if (body !== payload.toString()) {
        fail(`payload mismatch: expected "${payload}" got "${body}"`);
      }
      // AXL truncates the peer ID in X-From-Peer-Id; verify shared prefix (first 28 hex chars)
      if (!peer1Id.startsWith(fromPeerId?.slice(0, 28) ?? "")) {
        fail(`sender mismatch: expected prefix of ${peer1Id} got ${fromPeerId}`);
      }

      console.log(`\n✅  AXL spike PASSED — round-trip latency: ${latency}ms\n`);
      received = true;
      break;
    }

    if (!received) fail("message never arrived on Node2 within 5s");
  } finally {
    proc1.kill();
    proc2.kill();
    rmSync(WORKSPACE, { recursive: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
