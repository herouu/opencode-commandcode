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
  readCatalogCache,
  writeCatalogCache,
  writeStartupSummary,
  pluginStateDir,
} from "./src/startup.js";
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

export default async function commandcodePlugin() {
  return {
    config: async (config: Record<string, unknown>) => {
      if (!(config as Record<string, unknown>).provider) {
        (config as Record<string, unknown>).provider = { commandcode: {} };
      }
      const cc = (
        (config as Record<string, unknown>).provider as Record<string, Record<string, unknown>>
      )?.commandcode as Record<string, unknown> | undefined;
      if (!cc) return;

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
      let catalogSource: "bundled" | "cache" | "opt-in-local" | "remote" = "bundled";
      let commandCodeVersion: string | null = null;
      let degraded = false;
      let degradedReason: string | null = null;

      const remoteUrl =
        pluginCfg.catalogUrl?.trim() ||
        process.env.COMMANDCODE_CATALOG_URL?.trim() ||
        DEFAULT_REMOTE_CATALOG_URL;

      // 路线 3：优先运行时拉取远程目录，与 npm 包版本解耦。
      // 设为 "disabled" 可关闭远程拉取，回退到包内静态 models.json。
      const remoteEnabled = remoteUrl !== "disabled";
      if (remoteEnabled) {
        const remote = await fetchRemoteCatalog(remoteUrl);
        if (remote && remote.length > 0) {
          models = remote;
          catalogSource = "remote";
          commandCodeVersion = null;
        } else if (debug) {
          console.warn("[commandcode] remote catalog fetch failed, falling back to bundled/cache");
        }
      }

      if (models.length === 0 && override) {
        const localCatalog = loadCatalogFromLocalCommandCode({ packagePath: override });
        if (localCatalog && localCatalog.models.length > 0) {
          models = localCatalog.models;
          catalogSource = "opt-in-local";
          commandCodeVersion = localCatalog.version;
        }
      }

      if (models.length === 0) {
        const bundled = loadBundledModels();
        if (bundled) {
          models = bundled;
          catalogSource = "bundled";
          commandCodeVersion = readBundledVersion();
          const manifest = readBundledManifest();
          if (manifest?.status === "degraded" || manifest?.status === "broken") {
            degraded = true;
            degradedReason =
              manifest.status === "broken"
                ? "bundled catalog marked broken"
                : "bundled catalog has models with no listed price";
          }
        } else {
          const cached = readCatalogCache();
          if (cached) {
            models = cached;
            catalogSource = "cache";
            degraded = true;
            degradedReason = "bundled models.json unreadable; using last-good cache";
          } else {
            degraded = true;
            degradedReason = "no bundled catalog and no cache";
          }
        }
      }

      if (models.length > 0) {
        try {
          writeCatalogCache(pluginStateDir(), models);
        } catch {
          // ignore cache write
        }
      }

      cc.models = generateOpencodeModels(models);

      const summary = {
        catalogSource,
        commandCodeVersion,
        modelCount: models.length,
        reasoningModelCount: models.filter((m) => m.reasoning).length,
        degraded,
        degradedReason,
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
