import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "tsdown";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const outDir = path.join(repoRoot, "dist");

const TOP_LEVEL_PUBLIC_SURFACE_EXTENSIONS = new Set([
  ".ts",
  ".js",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
]);

function normalizePackageEntry(value) {
  return typeof value === "string" ? value.trim().replaceAll("\\", "/") : "";
}

function isTypeScriptEntry(entry) {
  return /\.(?:c|m)?ts$/u.test(entry);
}

function packageEntryKey(entry) {
  return normalizePackageEntry(entry)
    .replace(/^\.\//u, "")
    .replace(/\.[^.]+$/u, "");
}

function collectPluginSourceEntries() {
  let packageEntries = Array.isArray(packageJson.openclaw?.extensions)
    ? packageJson.openclaw.extensions.filter(
        (entry) => typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
  const setupEntry =
    typeof packageJson.openclaw?.setupEntry === "string" &&
    packageJson.openclaw.setupEntry.trim().length > 0
      ? packageJson.openclaw.setupEntry
      : undefined;
  if (setupEntry) {
    packageEntries = Array.from(new Set([...packageEntries, setupEntry]));
  }
  return packageEntries.length > 0 ? packageEntries : ["./index.ts"];
}

function collectTopLevelPublicSurfaceEntries() {
  return fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .flatMap((dirent) => {
      if (!dirent.isFile()) {
        return [];
      }
      const ext = path.extname(dirent.name);
      if (!TOP_LEVEL_PUBLIC_SURFACE_EXTENSIONS.has(ext)) {
        return [];
      }
      const normalizedName = dirent.name.toLowerCase();
      if (
        normalizedName.endsWith(".d.ts") ||
        /^config-api\.(?:[cm]?[jt]s)$/u.test(normalizedName) ||
        normalizedName.includes(".test.") ||
        normalizedName.includes(".spec.") ||
        normalizedName === "vitest.config.ts" ||
        normalizedName.startsWith("vitest.")
      ) {
        return [];
      }
      return [`./${dirent.name}`];
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function collectExternalDependencyNames() {
  return new Set(
    [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.peerDependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
    ].filter(Boolean),
  );
}

function createNeverBundleDependencyMatcher() {
  const externalDependencies = collectExternalDependencyNames();
  return (id) => {
    if (id === "openclaw" || id.startsWith("openclaw/")) {
      return true;
    }
    for (const dependency of externalDependencies) {
      if (id === dependency || id.startsWith(`${dependency}/`)) {
        return true;
      }
    }
    return false;
  };
}

const sourceEntries = [
  ...new Set([...collectPluginSourceEntries(), ...collectTopLevelPublicSurfaceEntries()]),
].filter(Boolean);

if (!sourceEntries.some(isTypeScriptEntry)) {
  console.error("[build] no TypeScript entries to compile");
  process.exit(1);
}

const entry = Object.fromEntries(
  sourceEntries.map((sourceEntry) => [
    packageEntryKey(sourceEntry),
    path.join(repoRoot, sourceEntry.replace(/^\.\//u, "")),
  ]),
);

fs.rmSync(outDir, { recursive: true, force: true });

await build({
  clean: false,
  config: false,
  dts: false,
  deps: {
    neverBundle: createNeverBundleDependencyMatcher(),
  },
  entry,
  env: {
    NODE_ENV: "production",
  },
  fixedExtension: false,
  logLevel: "info",
  outDir,
  platform: "node",
});

console.error(`[build] compiled ${sourceEntries.length} entries to dist/`);
