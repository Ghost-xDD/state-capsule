/**
 * test/setup.ts — Run before every test file.
 *
 * Sets env vars that are read at module-load time by the handlers so that
 * they're correct before vitest imports any handler module.
 */

import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Point handlers at the real buggy-utils source (read from disk, no LLM call)
process.env["BUGGY_UTILS_PATH"] = resolve(
  __dirname,
  "../../buggy-utils/src/index.ts",
);

// callLLM is mocked in tests — STATE_CAPSULE_MODE is irrelevant, but set it
// to replay so that any accidental real call throws immediately rather than
// hitting a network.
process.env["STATE_CAPSULE_MODE"] = "replay";
process.env["STATE_CAPSULE_REPLAY_TRANSCRIPT"] = "/dev/null";
