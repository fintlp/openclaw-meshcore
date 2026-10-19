/**
 * SDK surface guard: every openclaw/plugin-sdk/* value import used by the
 * plugin's shipped sources must exist as a real export of the installed
 * openclaw package. The inventory is collected by scanning the sources at
 * test time, so coverage never goes stale. Added after OpenClaw 2026.10.5
 * removed runStoppablePassiveMonitor and broke plugin load at gateway boot.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = join(REPO_ROOT, "src");

const IMPORT_FROM_RE = /import\s+(?!type\s)[^;]*?\{([^}]+)\}\s*from\s*"(openclaw\/plugin-sdk\/[a-z0-9-]+)"/gs;
const EXPORT_FROM_RE = /export\s+(?!type\s)[^;]*?\{([^}]+)\}\s*from\s*"(openclaw\/plugin-sdk\/[a-z0-9-]+)"/gs;

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const name of readdirSync(SRC_DIR)) {
    if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(join(SRC_DIR, name));
    }
  }
  for (const name of readdirSync(REPO_ROOT)) {
    if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts") &&
      name !== "vitest.config.ts"
    ) {
      out.push(join(REPO_ROOT, name));
    }
  }
  return out;
}

function collectInventory(): Map<string, Set<string>> {
  const inventory = new Map<string, Set<string>>();
  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf8");
    for (const re of [IMPORT_FROM_RE, EXPORT_FROM_RE]) {
      for (const match of text.matchAll(re)) {
        const subpath = match[2];
        const names = match[1]
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0 && !part.startsWith("type "))
          .map((part) => part.split(/\s+as\s+/)[0].trim())
          .filter((part) => part.length > 0);
        if (names.length === 0) {
          continue;
        }
        if (!inventory.has(subpath)) {
          inventory.set(subpath, new Set());
        }
        const bucket = inventory.get(subpath)!;
        for (const name of names) {
          bucket.add(name);
        }
      }
    }
  }
  return inventory;
}

describe("openclaw plugin-sdk surface", () => {
  it("every imported sdk name exists in the installed host package", async () => {
    const inventory = collectInventory();
    // Sanity: the scan must see the real surface, not silently collapse to nothing.
    expect(inventory.size).toBeGreaterThan(10);

    const failures: string[] = [];
    for (const [subpath, names] of inventory) {
      let mod: Record<string, unknown>;
      try {
        mod = (await import(/* @vite-ignore */ subpath)) as Record<string, unknown>;
      } catch (error) {
        failures.push(subpath + ": cannot import module: " + String(error));
        continue;
      }
      for (const name of names) {
        if (mod[name] === undefined) {
          failures.push(subpath + ": missing export \"" + name + "\"");
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
