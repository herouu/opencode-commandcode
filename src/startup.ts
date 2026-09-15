import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ModelEntry } from "./catalog.js";

export type { ModelEntry } from "./catalog.js";

export type CatalogSource = "bundled" | "cache" | "opt-in-local" | "remote";

/** 只有"新鲜"的来源才允许写缓存；bundled 是包内冻结快照，写进去会污染缓存。 */
export type CacheableSource = Extract<CatalogSource, "opt-in-local" | "remote">;

export type StartupSummary = {
  catalogSource: CatalogSource;
  commandCodeVersion: string | null;
  modelCount: number;
  reasoningModelCount: number;
  degraded: boolean;
  degradedReason: string | null;
  /** 所选目录的生成时间（旧格式缓存/未知来源为 null）。 */
  catalogGeneratedAt?: string | null;
};

/**
 * 缓存文件内容。`generatedAt` / `source` 为 null 表示旧格式（裸 ModelEntry[]），
 * 用于与包内 bundled 目录比较新鲜度。
 */
export type CatalogCacheEntry = {
  schemaVersion: 1;
  generatedAt: string | null;
  modelCount: number;
  source: CacheableSource | null;
  commandCodeVersion: string | null;
  models: ModelEntry[];
};

export type CatalogCacheWriteMeta = {
  generatedAt?: string;
  source?: CacheableSource;
  commandCodeVersion?: string | null;
};

const CACHE_FILE = "catalog-cache.json";

export function pluginStateDir(): string {
  const override = process.env.COMMANDCODE_PROVIDER_STATE_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".local/state/opencode/commandcode-provider");
}

function isNonEmptyArray(value: unknown): value is ModelEntry[] {
  return Array.isArray(value) && value.length > 0;
}

function asCacheableSource(value: unknown): CacheableSource | null {
  return value === "remote" || value === "opt-in-local" ? value : null;
}

export function readCatalogCacheEntry(dir = pluginStateDir()): CatalogCacheEntry | null {
  const path = join(dir, CACHE_FILE);
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }

  // 旧格式：裸 ModelEntry[]，不带时间戳，来源未知。
  if (isNonEmptyArray(parsed)) {
    return {
      schemaVersion: 1,
      generatedAt: null,
      modelCount: parsed.length,
      source: null,
      commandCodeVersion: null,
      models: parsed,
    };
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const entry = parsed as Partial<CatalogCacheEntry>;
  if (!isNonEmptyArray(entry.models)) return null;

  return {
    schemaVersion: 1,
    generatedAt: typeof entry.generatedAt === "string" ? entry.generatedAt : null,
    modelCount: entry.models.length,
    source: asCacheableSource(entry.source),
    commandCodeVersion:
      typeof entry.commandCodeVersion === "string" ? entry.commandCodeVersion : null,
    models: entry.models,
  };
}

export function readCatalogCache(dir = pluginStateDir()): ModelEntry[] | null {
  return readCatalogCacheEntry(dir)?.models ?? null;
}

export function writeCatalogCache(
  dir: string,
  models: ModelEntry[],
  meta: CatalogCacheWriteMeta = {},
): void {
  const entry: CatalogCacheEntry = {
    schemaVersion: 1,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    modelCount: models.length,
    source: meta.source ?? null,
    commandCodeVersion: meta.commandCodeVersion ?? null,
    models,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, CACHE_FILE), `${JSON.stringify(entry)}\n`, "utf-8");
}

export function writeStartupSummary(dir: string, summary: StartupSummary): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "startup.json"), `${JSON.stringify(summary)}\n`, "utf-8");
}
