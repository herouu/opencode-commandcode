import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { loadCatalogFromLocalCommandCode, type ModelEntry } from "../src/catalog.js";
import { readCatalogCacheEntry } from "../src/startup.js";
import type { CacheableSource, CatalogSource } from "../src/startup.js";
import type { CatalogManifest } from "../src/manifest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 本文件位于 core/，比包根低一层；包内静态目录（models.json 等）仍在包根。
const PACKAGE_ROOT = join(__dirname, "..");
const MODELS_PATH = join(PACKAGE_ROOT, "models.json");
const VERSION_PATH = join(PACKAGE_ROOT, "_version.txt");
const MANIFEST_PATH = join(PACKAGE_ROOT, "manifest.json");

function loadBundledModels(): ModelEntry[] | null {
  try {
    return JSON.parse(readFileSync(MODELS_PATH, "utf-8"));
  } catch {
    return null;
  }
}

// 运行时从远程 URL 拉取 models.json（ModelEntry[] 格式）。
// 与包内静态文件完全解耦：目录内容由远端仓库的 CI 维护，用户无需升级 npm 包即可拿到新模型。
async function fetchRemoteCatalog(url: string, timeoutMs = 8000): Promise<ModelEntry[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) return null;
      const models = data as ModelEntry[];
      if (models.length === 0 || typeof models[0]?.id !== "string") return null;
      return models;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

function readBundledManifest(): CatalogManifest | null {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as CatalogManifest;
  } catch {
    return null;
  }
}

function readBundledVersion(): string | null {
  const manifest = readBundledManifest();
  if (manifest?.commandCodeVersion) return manifest.commandCodeVersion;
  if (!existsSync(VERSION_PATH)) return null;
  try {
    const parts = readFileSync(VERSION_PATH, "utf-8").split("\n");
    const first = parts[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

/**
 * 本地兜底候选（缓存 / 包内静态目录）。
 * `generatedAt` 为 null 表示旧格式缓存，无法判断时间戳，只能退化为比较模型数量。
 */
type CatalogCandidate = {
  models: ModelEntry[];
  source: "bundled" | "cache";
  generatedAt: string | null;
  modelCount: number;
  commandCodeVersion: string | null;
  bundledStatus: CatalogManifest["status"] | null;
};

function readBundledCandidate(): CatalogCandidate | null {
  const models = loadBundledModels();
  if (!models || models.length === 0) return null;
  const manifest = readBundledManifest();
  return {
    models,
    source: "bundled",
    generatedAt: manifest?.generatedAt ?? null,
    modelCount: models.length,
    commandCodeVersion: manifest?.commandCodeVersion ?? readBundledVersion(),
    bundledStatus: manifest?.status ?? null,
  };
}

/**
 * 新鲜度比较：Array.sort 比较器，负值表示 a 排在 b 前面（更优先）。
 * 1) 双方都有时间戳 → 新的优先
 * 2) 否则（旧格式缓存无时间戳）→ 模型数量多的优先
 * 3) 仍平手 → bundled 优先（随包版本，结果确定）
 */
function compareCatalogFreshness(a: CatalogCandidate, b: CatalogCandidate): number {
  if (a.generatedAt && b.generatedAt && a.generatedAt !== b.generatedAt) {
    return a.generatedAt < b.generatedAt ? 1 : -1;
  }
  if (a.modelCount !== b.modelCount) return b.modelCount - a.modelCount;
  return a.source === "bundled" ? 1 : -1;
}

/** 目录解析结果：与插件版本无关，V1 / V2 adapter 共用。 */
export type CatalogResolution = {
  models: ModelEntry[];
  catalogSource: CatalogSource;
  commandCodeVersion: string | null;
  catalogGeneratedAt: string | null;
  degraded: boolean;
  degradedReason: string | null;
  /** 仅"新鲜"来源写缓存；bundled 是包内冻结快照，写进去会把旧目录钉死在缓存里。 */
  cacheableSource: CacheableSource | null;
};

export type ResolveCatalogOptions = {
  /** 远程目录 URL；设为 "disabled" 关闭远程拉取。 */
  remoteUrl: string;
  /** 显式 opt-in 的本地 command-code 包路径（空字符串表示未启用）。 */
  override: string;
  /** 是否输出排障日志。 */
  debug: boolean;
};

/**
 * 目录加载顺序：remote → opt-in-local（显式 commandCodePackagePath）→ 本地兜底（缓存/包内）。
 * 逻辑与 V1/V2 两个 adapter 共用的目录加载顺序逐行等价（remote → opt-in-local → 本地兜底）。
 */
export async function resolveCatalog(options: ResolveCatalogOptions): Promise<CatalogResolution> {
  const { remoteUrl, override, debug } = options;

  let models: ModelEntry[] = [];
  let catalogSource: CatalogSource = "bundled";
  let commandCodeVersion: string | null = null;
  let catalogGeneratedAt: string | null = null;
  let degraded = false;
  let degradedReason: string | null = null;
  let cacheableSource: CacheableSource | null = null;

  // 路线 3：优先运行时拉取远程目录，与 npm 包版本解耦。
  // 设为 "disabled" 可关闭远程拉取，回到确定性的包内静态目录。
  const remoteEnabled = remoteUrl !== "disabled";
  if (remoteEnabled) {
    const remote = await fetchRemoteCatalog(remoteUrl);
    if (remote && remote.length > 0) {
      models = remote;
      catalogSource = "remote";
      commandCodeVersion = null;
      catalogGeneratedAt = new Date().toISOString();
      cacheableSource = "remote";
    } else if (debug) {
      console.warn(
        "[commandcode] remote catalog fetch failed, falling back to local cache/bundled",
      );
    }
  }

  if (models.length === 0 && override) {
    const localCatalog = loadCatalogFromLocalCommandCode({ packagePath: override });
    if (localCatalog && localCatalog.models.length > 0) {
      models = localCatalog.models;
      catalogSource = "opt-in-local";
      commandCodeVersion = localCatalog.version;
      cacheableSource = "opt-in-local";
    }
  }

  if (models.length === 0) {
    const bundledCandidate = readBundledCandidate();
    const cacheEntry = readCatalogCacheEntry();
    const cacheCandidate: CatalogCandidate | null = cacheEntry
      ? {
          models: cacheEntry.models,
          source: "cache",
          generatedAt: cacheEntry.generatedAt,
          modelCount: cacheEntry.models.length,
          commandCodeVersion: cacheEntry.commandCodeVersion,
          bundledStatus: null,
        }
      : null;

    let chosen: CatalogCandidate | null;
    if (remoteEnabled) {
      // 远程不可用：缓存与包内快照按新鲜度竞争，而不是固定优先级。
      // 缓存里是上次成功拉取的目录，通常比随包冻结的目录更新。
      chosen =
        [cacheCandidate, bundledCandidate]
          .filter((candidate): candidate is CatalogCandidate => candidate !== null)
          .sort(compareCatalogFreshness)[0] ?? null;
    } else {
      // 显式 disabled：保持确定性（用包内目录），缓存仅在包内目录不可读时兜底。
      chosen = bundledCandidate ?? cacheCandidate;
    }

    if (chosen) {
      models = chosen.models;
      catalogSource = chosen.source;
      commandCodeVersion = chosen.commandCodeVersion;
      catalogGeneratedAt = chosen.generatedAt;
      if (chosen.source === "cache") {
        degraded = true;
        degradedReason = remoteEnabled
          ? "remote catalog unavailable; using last-good cache"
          : "bundled catalog unreadable; using last-good cache";
      } else {
        if (remoteEnabled) {
          degraded = true;
          degradedReason =
            "remote catalog unavailable; using bundled catalog (frozen at package version)";
        }
        if (chosen.bundledStatus === "degraded" || chosen.bundledStatus === "broken") {
          degraded = true;
          degradedReason =
            chosen.bundledStatus === "broken"
              ? "bundled catalog marked broken"
              : "bundled catalog has models with no listed price";
        }
      }
    } else {
      degraded = true;
      degradedReason = "no cache and no bundled catalog";
    }
  }

  return {
    models,
    catalogSource,
    commandCodeVersion,
    catalogGeneratedAt,
    degraded,
    degradedReason,
    cacheableSource,
  };
}
