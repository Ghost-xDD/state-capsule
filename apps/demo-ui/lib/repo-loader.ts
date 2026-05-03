/**
 * repo-loader.ts — Clone a GitHub repo and pick the best source file.
 *
 * Walks the cloned tree, excludes generated/dependency directories, ranks
 * every .ts/.js file by byte size, and returns the largest one as the target
 * for the triager (equivalent to BUGGY_UTILS_PATH in the existing pipeline).
 */

import { execSync } from "node:child_process";
import { mkdtempSync, statSync, readdirSync } from "node:fs";
import { join, extname, relative, sep } from "node:path";
import os from "node:os";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".turbo",
  "out",
  ".cache",
]);

const LOW_SIGNAL_DIRS = new Set([
  "__tests__",
  "__fixtures__",
  "fixtures",
  "test",
  "tests",
  "spec",
  "e2e",
]);

const SKIP_FILES = new Set([
  "index.d.ts",
  "vite.config.ts",
  "vitest.config.ts",
  "jest.config.ts",
  "webpack.config.js",
  "rollup.config.js",
]);

function walk(dir: string): string[] {
  let files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(walk(full));
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if ([".ts", ".tsx", ".js", ".jsx"].includes(ext) && !SKIP_FILES.has(entry.name)) {
        files.push(full);
      }
    }
  }
  return files;
}

export interface CloneResult {
  dir: string;
  file: string;
  relFile: string;
  totalFiles: number;
}

export async function cloneAndPick(repoUrl: string): Promise<CloneResult> {
  const dir = mkdtempSync(join(os.tmpdir(), "capsule-"));

  execSync(`git clone --depth 1 -- ${JSON.stringify(repoUrl)} ${JSON.stringify(dir)}`, {
    timeout: 90_000,
    stdio: "pipe",
  });

  const files = walk(dir);
  if (files.length === 0) {
    throw new Error("No TypeScript/JavaScript source files found in the repository.");
  }

  // Prefer implementation files over tests/fixtures. The patcher demo looks
  // fake when the target is a giant test fixture, even if that is the largest
  // JavaScript file in the repo.
  const ranked = files
    .map((f) => {
      const rel = relative(dir, f);
      const parts = rel.split(sep);
      const inSourceDir = parts.some((p) => ["src", "source", "lib"].includes(p));
      const lowSignal = parts.some((p) => LOW_SIGNAL_DIRS.has(p)) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
      const ext = extname(f);
      const extScore = ext === ".ts" || ext === ".tsx" ? 1_000 : 0;

      return {
        f,
        size: statSync(f).size,
        score:
          (inSourceDir ? 20_000 : 0) +
          (lowSignal ? -30_000 : 0) +
          extScore +
          Math.min(statSync(f).size, 12_000),
      };
    })
    .sort((a, b) => b.score - a.score || b.size - a.size);

  const best = ranked[0]!;
  return {
    dir,
    file: best.f,
    relFile: relative(dir, best.f),
    totalFiles: files.length,
  };
}
