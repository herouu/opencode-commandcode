/**
 * V2 专用组合入口（组合薄壳）
 *
 * 本文件是 **opencode v2** 的入口：组合对象同时带 `id` / `setup`（来自 plugin/v2.ts 的
 * Plugin.define，经顶层 await 动态 import 懒加载）与 `server`（V1 hooks 工厂，见下）。
 *
 * ⚠️ V1 不要通过目录挂载本插件（即 `plugin: [".../opencode-commandcode"]`）。
 * 真机 v1.18.29 实证：v1 的配置挂载路径对「含顶层 await(TLA) 的入口模块」求值会**崩溃**
 * （`opencode models` 列出 0 个 commandcode 模型），即使 TLA 内部有 try/catch 也救不了——
 * 崩溃发生在 v1 插件加载器求值入口模块的阶段。
 * **V1 请直接挂 `plugin/v1.ts`**（纯同步 V1 adapter，不 import `@opencode/plugin`）：
 * 子路径 `@herouucn/opencode-commandcode/plugin.v1`，本地路径 `.../plugin/v1.ts`。
 * 该子路径入口是 V1 的**唯一正确用法**，不是「更早版本 v1 的兼容退路」。
 *
 * 本文件的懒加载（顶层 await + 动态 import）只是当前形态，**并非让 V1 目录挂载生效的手段**：
 * 真机证明它并没有救活 v1 的目录挂载（v1 运行时不注入 `@opencode/plugin`，
 * 故静态 import plugin/v2.ts 同样会让 V1 崩）。V1 走的是另一条入口 `plugin/v1.ts`，
 * 本文件的 `server` re-export 仅为保持组合对象形状与回归兼容。
 *
 * 业务逻辑一律在 core/ 中，本文件只做版本组合。
 */
import { server } from "./v1.js";

export type { ModelEntry } from "../src/catalog.js";

export { server };

/** V2 adapter 的形态（`plugin/v2.ts` 的 `Plugin.define` 返回值）。类型查询不产生运行时 import。 */
type V2Plugin = typeof import("./v2.js").commandcodePlugin;

/**
 * V2 适配器实例。V2 环境下由下面的动态 import 赋值；非 V2 环境（如 V1 运行时，其不注入
 * `@opencode/plugin`）回退为只含 id 的 stub。注意：该 stub 只是防御性兜底，V1 不应依赖本入口
 * （V1 目录挂载会在入口求值阶段直接崩溃，见文件头注释）。
 * 用 `let` + 确定赋值，是为了让组合对象在类型上仍保持 `id` / `setup` 的完整形状。
 */
let v2Plugin: V2Plugin;

try {
  const v2Module = await import("./v2.js");
  v2Plugin = v2Module.commandcodePlugin;
} catch {
  // 非 V2 环境：`@opencode/plugin` 不可解析，整个 V2 adapter 不可用（防御性兜底，V1 正常路径不走本文件）。
  // 此处只含 id 的 stub 仅为保持类型形状不变；V1 请挂 plugin/v1.ts，其不 import `@opencode/plugin`。
  v2Plugin = { id: "commandcode" } as V2Plugin;
}

export default {
  ...v2Plugin,
  server,
};
