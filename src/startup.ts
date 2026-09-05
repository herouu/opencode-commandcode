import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ModelEntry } from "./catalog.js";

export type { ModelEntry } from "./catalog.js";

export type StartupSummary = {
  catalogSource: "bundled" | "cache" | "opt-in-local" | "remote";
  commandCodeVersion: string | null;
  modelCount: number;
  reasoningModelCount: number;
  degraded: boolean;
  degradedReason: string | null;
};

export function pluginStateDir(): string {
  const override = process.env.COMMANDCODE_PROVIDER_STATE_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".local/state/opencode/commandcode-provider");
}

export function readCatalogCache(dir = pluginStateDir()): ModelEntry[] | null {
  const path = join(dir, "catalog-cache.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed as ModelEntry[];
  } catch {
    return null;
  }
}

export function writeCatalogCache(dir: string, models: ModelEntry[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "catalog-cache.json"), JSON.stringify(models) + "\n", "utf-8");
}

export function writeStartupSummary(dir: string, summary: StartupSummary): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "startup.json"), JSON.stringify(summary) + "\n", "utf-8");
}
