/**
 * V1 adapter（兼容 opencode v1，经由 plugin/index.ts 的 server() 导出）
 *
 * opencode v1 的插件约定是「模块默认导出（或 ./server 子路径导出）一个函数，调用后返回 hooks 对象」。
 * 本文件只保留 V1 专属的 hooks 形状（config / auth），所有目录加载、缓存与摘要逻辑
 * 都在 core/ 中，两个版本的 adapter 共用同一份实现。
 *
 * 不引入 opencode v1 的插件 SDK 类型：hooks 结构用本地类型描述，
 * 避免为了类型再新增一个构建期依赖。
 */
import { generateOpencodeModels } from "../src/catalog.js";
import {
  buildStartupSummary,
  ensureProviderBlock,
  loadPluginConfig,
  persistCatalogCache,
  persistStartupSummary,
  resolveCatalog,
  resolveCatalogUrl,
  resolvePackagePathOverride,
} from "../core/index.js";

/** V1 auth hook 的入参形状（opencode 传入的凭据读取器）。 */
type V1AuthCredential = { type: string; key?: string } | null;

/** V1 hooks 结构：与 one-package 组合前的 V1 形态返回值逐字段一致。 */
export type V1PluginHooks = {
  config: (config: Record<string, unknown>) => Promise<void>;
  auth: {
    provider: string;
    methods: Array<{
      type: string;
      label: string;
    }>;
    loader: (getAuth: () => Promise<V1AuthCredential>) => Promise<Record<string, unknown>>;
  };
};

export async function server(): Promise<V1PluginHooks> {
  return {
    config: async (config: Record<string, unknown>) => {
      const pluginCfg = loadPluginConfig();
      const debug = pluginCfg.debugStartupLogs === true;
      const override = resolvePackagePathOverride(pluginCfg);
      const remoteUrl = resolveCatalogUrl(pluginCfg);

      const cc = ensureProviderBlock(config);

      if (cc.models) return;

      const resolution = await resolveCatalog({ remoteUrl, override, debug });

      persistCatalogCache(resolution);

      cc.models = generateOpencodeModels(resolution.models);

      const summary = buildStartupSummary(resolution);
      persistStartupSummary(summary, debug);
    },

    auth: {
      provider: "commandcode",
      methods: [
        {
          type: "api",
          label: "API Key",
        },
      ],
      loader: async (getAuth: () => Promise<V1AuthCredential>) => {
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

export default server;
