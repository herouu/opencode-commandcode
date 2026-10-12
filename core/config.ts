import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** 用户级配置文件（~/.config/opencode/opencode-commandcode.json）字段。 */
export interface PluginFileConfig {
  disableModelSync?: boolean;
  commandCodePackagePath?: string;
  catalogUrl?: string;
  debugStartupLogs?: boolean;
}

// 默认远程目录源：本仓库自己的 main 分支（自给自足，不依赖上游仓库）。
// 本仓库的 catalog-sync CI 每 6 小时检测上游 command-code 新版本并直推 models.json 到 main。
// 可用环境变量 COMMANDCODE_CATALOG_URL 或 ~/.config/opencode/opencode-commandcode.json 的
// catalogUrl 覆盖为任意自定义源。
export const DEFAULT_REMOTE_CATALOG_URL =
  "https://raw.githubusercontent.com/herouu/opencode-commandcode/main/models.json";

// 默认 OpenAI 兼容端点：与 @ai-sdk/openai-compatible 搭配，等价于 README 手动配置推荐值。
export const DEFAULT_BASE_URL = "https://api.commandcode.ai/provider/v1/";

export function loadPluginConfig(): PluginFileConfig {
  const dir = join(homedir(), ".config", "opencode");
  const configPath = join(dir, "opencode-commandcode.json");
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

/** 远程目录 URL 优先级：配置文件 > 环境变量 > 内置默认值。 */
export function resolveCatalogUrl(pluginCfg: PluginFileConfig): string {
  return (
    pluginCfg.catalogUrl?.trim() ||
    process.env.COMMANDCODE_CATALOG_URL?.trim() ||
    DEFAULT_REMOTE_CATALOG_URL
  );
}

/** 显式 opt-in 的本地 command-code 包路径覆盖：配置文件 > 环境变量。 */
export function resolvePackagePathOverride(pluginCfg: PluginFileConfig): string {
  return (
    pluginCfg.commandCodePackagePath?.trim() || process.env.COMMANDCODE_PACKAGE_PATH?.trim() || ""
  );
}

/**
 * 把 commandcode provider 的基础字段写入 opencode config 对象（npm / name / env / options.baseURL）。
 * 已存在的字段一律不覆盖。返回 provider 块本身，调用方自行判断是否已有 cc.models。
 */
export function ensureProviderBlock(config: Record<string, unknown>): Record<string, unknown> {
  const providers = ((config as Record<string, unknown>).provider ??= {}) as Record<
    string,
    Record<string, unknown>
  >;
  const cc = (providers.commandcode ??= {}) as Record<string, unknown>;

  if (!cc.npm) cc.npm = "@ai-sdk/openai-compatible";
  if (!cc.name) cc.name = "Command Code";
  if (!cc.env) cc.env = ["COMMANDCODE_API_KEY"];
  const options = (cc.options as Record<string, unknown> | undefined) ?? {};
  cc.options = options;
  if (typeof options.baseURL !== "string") options.baseURL = DEFAULT_BASE_URL;

  return cc;
}
