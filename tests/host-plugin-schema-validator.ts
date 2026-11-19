import { readdirSync, readFileSync } from "node:fs";

type HostValidationResult = {
  ok: boolean;
  value?: any;
  errors?: unknown;
};
type HostValidator = (params: {
  origin: string;
  schema: unknown;
  value: unknown;
  applyDefaults: boolean;
  cache: boolean;
}) => Promise<HostValidationResult> | HostValidationResult;

/** Discover the installed host validator without depending on bundle hashes or export aliases. */
export async function materializeWithHostValidator(schema: unknown, value: unknown): Promise<any> {
  const distDir = new URL("../node_modules/openclaw/dist/", import.meta.url);
  const candidates = readdirSync(distDir)
    .filter((name) => /^schema-validator-[^/]+\.mjs$/.test(name))
    .sort();
  let validator: HostValidator | undefined;
  for (const name of candidates) {
    const url = new URL(name, distDir);
    // Avoid importing unrelated modules: the implementation name is stable
    // even when the hashed filename and exported alias change.
    if (!readFileSync(url, "utf8").includes("function validatePluginSchemaValue")) continue;
    const module = await import(url.href);
    validator = Object.values(module).find(
      (candidate): candidate is HostValidator =>
        typeof candidate === "function" && candidate.name === "validatePluginSchemaValue",
    );
    if (validator) break;
  }
  if (!validator) throw new Error("Installed host validatePluginSchemaValue not found");
  const result = await validator({
    origin: "workspace",
    schema,
    value,
    applyDefaults: true,
    cache: false,
  });
  if (!result.ok) throw new Error("Host validation failed: " + JSON.stringify(result.errors));
  return result.value;
}
