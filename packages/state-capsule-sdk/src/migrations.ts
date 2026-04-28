/**
 * migrations.ts — schema migration registry.
 *
 * When restoring an old capsule, the SDK checks its schema_version against
 * the current SCHEMA_VERSION and runs any registered migrations in order.
 * For v0.1.0 the registry is empty — but it must exist so the machinery is
 * tested before we need it.
 */

import type { Capsule } from "./schema.js";
import { SCHEMA_VERSION } from "./schema.js";

type MigrationFn = (capsule: Record<string, unknown>) => Record<string, unknown>;

interface Migration {
  from: string;
  to:   string;
  run:  MigrationFn;
}

// Ordered list of registered migrations (oldest first).
const MIGRATIONS: Migration[] = [
  // Example for future use:
  // { from: "0.1.0", to: "0.2.0", run: (c) => ({ ...c, new_field: "default" }) },
];

/**
 * Migrate a raw capsule object from its `schema_version` to the current
 * SCHEMA_VERSION, applying registered migrations in sequence.
 *
 * Throws if no migration path exists from the capsule's version.
 * Returns the capsule unchanged if already at the current version.
 */
export function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  let version = (raw["schema_version"] as string | undefined) ?? "0.1.0";

  if (version === SCHEMA_VERSION) return raw;

  let current = raw;
  while (version !== SCHEMA_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === version);
    if (!step) {
      throw new Error(
        `No migration path from schema_version "${version}" to "${SCHEMA_VERSION}". ` +
        `Register a migration in migrations.ts.`
      );
    }
    current = step.run(current);
    version = step.to;
  }

  return current;
}

/**
 * Convenience wrapper: apply migrations then cast to Capsule.
 * Callers are responsible for re-validating with CapsuleSchema afterwards.
 */
export function migrateCapsule(raw: Record<string, unknown>): Capsule {
  return migrate(raw) as unknown as Capsule;
}
