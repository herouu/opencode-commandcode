import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  generateOpencodeModels,
  loadCatalogFromLocalCommandCode,
  type ModelEntry,
} from "./src/catalog.js";
import {
  readCatalogCacheEntry,
  writeCatalogCache,
  writeStartupSummary,
  pluginStateDir,
} from "./src/startup.js";
import type { CacheableSource, CatalogSource, StartupSummary } from "./src/startup.js";
import type { CatalogManifest } from "./src/manifest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_PATH = join(__dirname, "models.json");
const VERSION_PATH = join(__dirname, "_version.txt");
const MANIFEST_PATH = join(__dirname, "manifest.json");

interface PluginFileConfig {
  disableModelSync?: boolean;
  commandCodePackagePath?: string;
  catalogUrl?: string;
  debugStartupLogs?: boolean;
}

// 默认远程目录源：本仓库自己的 main 分支（自给自足，不依赖上游仓库）。
// 本仓库的 catalog-sync CI 每 6 小时检测上游 command-code 新版本并直推 models.json 到 main。
// 可用环境变量 COMMANDCODE_CATALOG_URL 或 ~/.config/opencode/opencode-commandcode.json 的
// catalogUrl 覆盖为任意自定义源。
const DEFAULT_REMOTE_CATALOG_URL =
  "https://raw.githubusercontent.com/herouu/opencode-commandcode/main/models.json";

// 默认 OpenAI 兼容端点：与 @ai-sdk/openai-compatible 搭配，等价于 README 手动配置推荐值。
const DEFAULT_BASE_URL = "https://api.commandcode.ai/provider/v1/";

function loadPluginConfig(): PluginFileConfig {
  const dir = join(homedir(), ".config", "opencode");
  const configPath = join(dir, "opencode-commandcode.json");
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

export type { ModelEntry };

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

export default async function commandcodePlugin() {
  return {
    config: async (config: Record<string, unknown>) => {
      const providers = ((config as Record<string, unknown>).provider ??= {}) as Record<
        string,
        Record<string, unknown>
      >;
      const cc = (providers.commandcode ??= {}) as Record<string, unknown>;

      const pluginCfg = loadPluginConfig();
      const debug = pluginCfg.debugStartupLogs === true;
      const override =
        pluginCfg.commandCodePackagePath?.trim() ||
        process.env.COMMANDCODE_PACKAGE_PATH?.trim() ||
        "";

      if (!cc.npm) cc.npm = "@ai-sdk/openai-compatible";
      if (!cc.name) cc.name = "Command Code";
      if (!cc.env) cc.env = ["COMMANDCODE_API_KEY"];
      const options = (cc.options as Record<string, unknown> | undefined) ?? {};
      cc.options = options;
      if (typeof options.baseURL !== "string") options.baseURL = DEFAULT_BASE_URL;

      if (cc.models) return;

      let models: ModelEntry[] = [];
      let catalogSource: CatalogSource = "bundled";
      let commandCodeVersion: string | null = null;
      let catalogGeneratedAt: string | null = null;
      let degraded = false;
      let degradedReason: string | null = null;
      // 仅"新鲜"来源写缓存；bundled 是包内冻结快照，写进去会把旧目录钉死在缓存里。
      let cacheableSource: CacheableSource | null = null;

      const remoteUrl =
        pluginCfg.catalogUrl?.trim() ||
        process.env.COMMANDCODE_CATALOG_URL?.trim() ||
        DEFAULT_REMOTE_CATALOG_URL;

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

      if (models.length > 0 && cacheableSource) {
        try {
          writeCatalogCache(pluginStateDir(), models, {
            source: cacheableSource,
            commandCodeVersion,
          });
        } catch {
          // ignore cache write
        }
      }

      cc.models = generateOpencodeModels(models);

      const summary: StartupSummary = {
        catalogSource,
        commandCodeVersion,
        modelCount: models.length,
        reasoningModelCount: models.filter((m) => m.reasoning).length,
        degraded,
        degradedReason,
        catalogGeneratedAt,
      };
      try {
        writeStartupSummary(pluginStateDir(), summary);
      } catch {
        // ignore
      }
      if (debug) {
        console.warn("[commandcode]", JSON.stringify(summary));
      }
    },

    auth: {
      provider: "commandcode",
      methods: [
        {
          type: "api",
          label: "API Key",
        },
      ],
      loader: async (getAuth: () => Promise<{ type: string; key?: string } | null>) => {
        try {
          const auth = await getAuth();
          if (!auth) return {};
          if (auth.type === "api" && auth.key) return { apiKey: auth.key };
          return {};
        } catch {
          return {};
        }
      },
    },
  };
}
