/**
 * V2 adapter（opencode v2，@opencode/plugin 的 Plugin.define 形态）
 *
 * V2 用 Plugin.define({ id, setup }) 取代 V1 的「默认导出函数」；
 * setup 通过 ctx.provider.transform 注册 provider。业务逻辑（配置读取、目录加载、
 * 缓存与摘要落盘）全部来自 core/，本文件只做 V2 专属的 Provider.Info / Model.Info 映射。
 *
 * 已知取舍（V1 → V2）：
 * 1) V1 的 `auth` hook 在 V2 对应 `ctx.integration.transform`（把 auth 数据转成
 *    integration connection）。本插件是「自定义 provider」场景，API key 通过
 *    `settings.apiKey: "{env:COMMANDCODE_API_KEY}"` 的 env 模板传递更简单可靠，
 *    因此 V2 版**不使用** ctx.integration.transform，避免 integration ID 冲突。
 * 2) V1 的 `dispose` hook 本插件从未使用（V1 形态就没有 dispose），
 *    故 setup 返回空清理函数即可，无迁移逻辑（V2 用 setup 的返回值替代 V1 dispose）。
 */
import { Model, Plugin, Provider } from "@opencode/plugin";
import {
  DEFAULT_BASE_URL,
  loadPluginConfig,
  resolveCatalogUrl,
  resolvePackagePathOverride,
} from "../core/config.js";
import { resolveCatalog } from "../core/source.js";
import { buildStartupSummary, persistCatalogCache, persistStartupSummary } from "../core/sync.js";
import type { ModelEntry } from "../src/catalog.js";

/** 插件注册的 provider ID（与原 V1 形态保持一致）。 */
const PROVIDER_ID = "commandcode";

// opencode v2 的包名重映射（@ai-sdk/* -> @opencode/ai/providers/*）只对
// config/registry 来源的 provider 生效；插件注册的 provider 必须直接
// 使用内部模块名，否则会尝试从 npm 安装不含 model() 导出的旧包。
const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible";

// V2 的 cost 字段带 Money.USDPerMillionTokens 品牌（brand 只收窄 TS 类型，不改变运行时数值）。
// 这里只做类型层收窄，而不是 import `@opencode/schema/money`：opencode v2 运行时只向插件
// 提供 `effect` 与 `@opencode/plugin` 两个模块，直接按包名 import schema 子路径会在用户侧
// 解析失败（插件 node_modules 不随包安装 devDependencies）。
type UsdPerMillionTokens = Model.Cost["input"];

function usdPerMillionTokens(value: number): UsdPerMillionTokens {
  return value as UsdPerMillionTokens;
}

// 将 ModelEntry 转换为 V2 Model.Info 对象（opencode >= 2.0.26 schema）
// v2 变化：cost 为数组；variants 为 {id, settings}；modalities/reasoning/reasoningEfforts
// 字段已移除，分别改用 capabilities.input/output 与 variant 的 settings.reasoningEffort。
function entryToModelInfo(providerID: string, entry: ModelEntry): Model.Info {
  const id = Model.ID.make(entry.id);
  const base = Model.Info.default(Provider.ID.make(providerID), id);
  const modalities = entry.modalities ?? { input: ["text"], output: ["text"] };

  return {
    ...base,
    name: entry.name,
    capabilities: {
      tools: entry.tool_call,
      input: modalities.input ?? ["text"],
      output: modalities.output ?? ["text"],
    },
    cost: [
      Model.Cost.make({
        input: usdPerMillionTokens(entry.cost.input),
        output: usdPerMillionTokens(entry.cost.output),
        cache: {
          read: usdPerMillionTokens(entry.cost.cache_read ?? 0),
          write: usdPerMillionTokens(entry.cost.cache_write ?? 0),
        },
      }),
    ],
    limit: entry.limit ?? base.limit,
    ...(entry.reasoningEfforts && entry.reasoningEfforts.length > 0
      ? {
          variants: entry.reasoningEfforts.map((effort) => ({
            id: Model.VariantID.make(effort),
            settings: { reasoningEffort: effort },
          })),
        }
      : {}),
  };
}

export const commandcodePlugin = Plugin.define({
  id: PROVIDER_ID,
  async setup(ctx) {
    const pluginCfg = loadPluginConfig();
    const debug = pluginCfg.debugStartupLogs === true;
    const override = resolvePackagePathOverride(pluginCfg);
    const remoteUrl = resolveCatalogUrl(pluginCfg);

    const resolution = await resolveCatalog({ remoteUrl, override, debug });

    persistCatalogCache(resolution);

    // 将 ModelEntry[] 转换为 V2 Model.Info[] 并通过 provider.transform 注册
    const modelInfos = resolution.models.map((entry) => entryToModelInfo(PROVIDER_ID, entry));

    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(Provider.ID.make(PROVIDER_ID)),
          name: "Command Code",
          activation: "enabled",
          package: PROVIDER_PACKAGE,
          settings: {
            baseURL: DEFAULT_BASE_URL,
            provider: PROVIDER_ID,
            // V1 的 auth hook → V2 未采用 integration.transform，改用 settings.apiKey 的
            // env 模板传钥（V2 Provider.Info 没有独立的 env / apiKey 字段）。
            apiKey: "{env:COMMANDCODE_API_KEY}",
          },
        },
        models: modelInfos,
      });
    });

    const summary = buildStartupSummary(resolution);
    persistStartupSummary(summary, debug);

    // 对应 V1 的 dispose 迁移：本插件没有 interval / timer 等持久资源，无需清理。
    return () => {
      /* 无持久资源可清理 */
    };
  },
});

export default commandcodePlugin;
