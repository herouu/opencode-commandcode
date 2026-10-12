/**
 * V2 adapter（opencode v2，@opencode/plugin 的 Plugin.define 形态）
 *
 * V2 用 Plugin.define({ id, setup }) 取代 V1 的「默认导出函数」；
 * setup 通过 ctx.provider.transform 注册 provider，通过 ctx.integration.transform
 * 注册 integration 的认证方法（对应 V1 的 `auth` hook）。业务逻辑（配置读取、
 * 目录加载、缓存与摘要落盘）全部来自 core/，本文件只做 V2 专属的
 * Provider.Info / Model.Info 映射与认证方法接线。
 *
 * 为什么 V2 必须接 ctx.integration.transform（V2 源码依据，勿删）：
 * 1) `opencode auth login` 的候选列表就是 **integration 注册表**
 *    （CLI `cli.auth.integrations` → `client.integration.list()`，插件侧唯一入口是
 *    `ctx.integration.transform`）。`ctx.provider.transform` 只写 provider 记录、
 *    不产生 integration，因此只注册 provider 时 `auth login commandcode` 会报
 *    `Integration not found: commandcode`。
 * 2) `auth login` 会过滤掉只有 env 方法的 integration（等价于
 *    `methods.filter(m => m.type !== "env")`，过滤后为空则不进候选列表）。所以必须注册
 *    至少一个 **key 方法**（交互式手输 API Key），env 方法单独存在时只会让
 *    `auth list` 显示为已连接，不会出现在 login 列表里。
 * 3) **activate 坑（必踩）**：`packages/core/src/provider.ts` 的可用性判定等价于
 *    `activation === "enabled" ∨ 该 integration 有 connection ∨ (provider.integrationID 未定义 ∧ 无同名 integration)`。
 *    一旦注册了 id 为 `commandcode` 的 integration，第三个条件就永远为假；若此时环境变量
 *    未设且无凭证，**整个 provider 会变成不可用**（模型列表为空）。因此注册 integration 的
 *    同时必须把 provider 的 `activation` 钉死为 `"enabled"`（内置 config 插件同样做法）。
 * 4) 凭证消费无需额外接线：model resolver 用 `provider.integrationID ?? provider.id` 找到本
 *    integration 并 resolve 出 credential，最终 **覆盖** `settings.apiKey`。所以
 *    `settings.apiKey: "{env:COMMANDCODE_API_KEY}"` 保留为「无 credential 时的兜底」，
 *    而 env 方法注册后 `process.env.COMMANDCODE_API_KEY` 命中即算一条 `type: "env"` 的
 *    connection，原有环境变量通路完全不变。
 *
 * 已知取舍（V1 → V2）：
 * V1 的 `dispose` hook 本插件从未使用（V1 形态就没有 dispose），故 setup 返回空清理
 * 函数即可，无迁移逻辑（V2 用 setup 的返回值替代 V1 dispose）。
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

/** 插件注册的 provider ID（与原 V1 形态保持一致），同时用作 V2 integration ID。 */
const PROVIDER_ID = "commandcode";

/** integration 的展示名（auth 列表 / 选择器里显示的标题，默认会退化成裸 id）。 */
const INTEGRATION_DISPLAY_NAME = "Command Code";

/**
 * V2 integration 的 key 方法 label：`auth login` 交互时提示用户手输 API Key。
 * 该方法的存在是「integration 能被 auth login 选中」的关键（只有 env 方法会被过滤掉）。
 */
const INTEGRATION_KEY_LABEL = "CommandCode API Key";

/** V2 integration 的 env 方法：这些环境变量命中时算一条 env connection（auth list 显示已连接）。 */
const INTEGRATION_ENV_NAMES = ["COMMANDCODE_API_KEY"] as const;

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
            // credential（auth login 存入）会覆盖这里的值；本行只作为无 credential 时的兜底
            // （V2 Provider.Info 没有独立的 env / apiKey 字段，env 通路见下方 integration 的 env 方法）。
            apiKey: "{env:COMMANDCODE_API_KEY}",
          },
        },
        models: modelInfos,
      });

      // 注册 integration 后，provider 可用性判定的「无同名 integration」分支失效，必须把
      // activation 钉成 "enabled"（详见文件头第 3 条）。上面的 add 已带上该字段，这里的
      // update 是幂等兜底：即使 `commandcode` 记录由 config / registry 来源先建立，也强制启用。
      editor.update(PROVIDER_ID, (info) => {
        info.activation = "enabled";
      });
    });

    // 注册 integration 认证方法：key 方法让 `opencode auth login` 能选到 commandcode
    // （只有 env 方法会被 login 列表过滤掉），env 方法让已设置的环境变量显示为已连接。
    // 方法注册本身会自动创建 id 为 commandcode 的 integration 记录（name 默认取 id）。
    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { type: "key", label: INTEGRATION_KEY_LABEL },
      });

      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { type: "env", names: [...INTEGRATION_ENV_NAMES] },
      });

      // 展示名改成可读标题（auth 列表 / 选择器里显示 "Command Code" 而不是裸 id）。
      editor.update(PROVIDER_ID, (integration: { id: string; name: string }) => {
        integration.name = INTEGRATION_DISPLAY_NAME;
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
