# AGENTS.md

herouu 独立维护的 `@herouucn/opencode-commandcode`（独立 fork，不再跟踪上游）。运行时模型目录通过远程拉取保持最新，全部自动化为 GitHub Actions，改动在 `main` 直接进行并 push。

## 项目结构

```
index.ts          # package main：createCommandCode + re-export plugin/ 组合对象的 default
core/             # 与插件版本无关的业务逻辑（配置、目录加载、缓存落盘）
plugin/           # V1 / V2 双版本 adapter（只做版本接线，不含业务逻辑）
  index.ts        #   V2 组合入口（懒加载 v2 adapter 拿 { id, setup } 再与 server 组合）；opencode 目录入口经根 index.ts re-export
  v1.ts           #   V1 专用入口：server() 返回 config / auth hooks（纯同步，不 import @opencode/plugin）
  v2.ts           #   V2 adapter：Plugin.define({ id, setup }) + ctx.provider.transform
src/              # AI SDK provider（createCommandCode）+ 目录提取 + 缓存/摘要写入
scripts/          # CI 与本地目录刷新脚本（catalog-sync-ci.ts、sync-models.ts）
tests/unit/       # bun test 单元测试
.github/workflows # catalog-sync.yml / ci.yml / release.yml
```

根路径只保留 `index.ts` 一个 `.ts` 文件；其余 `.ts` 一律归入 `core/` 或 `plugin/`。

## 工程约束

- **adapter 不写业务逻辑**：`plugin/v1.ts`、`plugin/v2.ts` 只做版本接线（V1 的 `config`/`auth` hooks、V2 的 `Plugin.define` + `ctx.provider.transform`）。所有目录加载、配置读取、缓存与摘要落盘一律在 `core/`。改业务逻辑只改 `core/`，两个 adapter 共用同一份实现。
- **`plugin/index.ts` 的 default 必须是含 `id`/`setup`/`server` 的组合对象**，且根 `index.ts` 的 default 与它是同一对象。opencode v2 解析本地目录插件时先试 `server.*` 再试 `index.*`，`plugin.ts` 不是自动候选——因此**不要在根路径新建 `plugin*.ts`，也不要创建 `server.ts`**（会抢占入口）。
- **双入口约束：V1 与 V2 各用各的入口，不要指望用单一同步入口同时服务两版**（真机实证：本地目录部署下做不到）。
  - **V2 用目录入口**：挂目录 → 根 `index.ts` → `plugin/index.ts`（V2 组合入口，懒加载 `plugin/v2.ts` 的 v2 adapter 拿 `{ id, setup }`）。**`plugin/index.ts` 是 V2 专用**。
  - **V1 必须直接挂 `plugin/v1.ts`**：npm 子路径 `"plugin": ["@herouucn/opencode-commandcode/plugin.v1"]`；本地路径 `"plugin": ["file:///absolute/path/to/opencode-commandcode/plugin/v1.ts"]`。它是**纯同步** V1 adapter，且**不 import `@opencode/plugin`**。
  - **原因（真机 v1.18.29 实证）**：① v1 的配置挂载路径对「含顶层 await(TLA) 的入口模块」求值会**崩溃**（`opencode models` 列出 0 个 commandcode 模型），TLA 内部有 try/catch 也救不了——崩溃发生在 v1 插件加载器求值入口模块的阶段；② v1 运行时不注入 `@opencode/plugin`（只有 v2 注入），所以入口静态 import `plugin/v2.ts` 同样会让 V1 崩。即 V1 挂目录（`plugin: [".../opencode-commandcode"]`）必崩，只能走 `plugin/v1.ts`。
  - 相应地：**不要为了「兼容 V1」去改 `plugin/index.ts` 的懒加载形态**——懒加载并没有让 v1 的目录挂载成功，它只是当前形态；也不要在 `plugin/index.ts` 顶部对 `@opencode/plugin` 写运行时 import（类型只能走 `typeof import("./v2.js")` 这类类型查询）。
- **CI 生成文件勿手改**：`models.json`、`manifest.json`、`_version.txt` 由 `catalog-sync.yml` 直推 main。提交时不要把它们和手写改动混在一起。
- **不触碰** 上述 CI 生成文件；`core/source.ts` 从包根（`PACKAGE_ROOT`）读取它们，移动会破坏运行时。
- **`bun run check` 必须通过**后再提交（见下方命令）。

## 运行时目录加载（`core/source.ts`）

- 每次启动优先拉取 raw GitHub `models.json`（默认 `https://raw.githubusercontent.com/herouu/opencode-commandcode/main/models.json`）。
- 顺序：`remote` → `opt-in-local`（显式 `commandCodePackagePath`）→ 本地兜底。
- 本地兜底**不是**固定优先级：`catalog-cache.json` 与包内 `models.json` 都有时间戳时取更新者（`generatedAt` vs `manifest.generatedAt`），旧格式缓存（裸数组、无时间戳）退化为比较模型数量，平手时包内目录优先。
- 只有 `remote` / `opt-in-local` 成功才写缓存（`src/startup.ts` 的 `writeCatalogCache`），包内目录不写缓存，防止旧目录被钉死在缓存里。
- 可用环境变量 `COMMANDCODE_CATALOG_URL`（或配置 `catalogUrl`）覆盖远程 URL；设为 `disabled` 关闭远程拉取，此时确定性使用包内目录（缓存仅在包内目录不可读时兜底）。
- `src/startup.ts` 的 `StartupSummary.catalogSource` 为 `"remote" | "cache" | "opt-in-local" | "bundled"`，并带 `catalogGeneratedAt`。

## 命令

- `bun run check` — CI gate：`oxlint --deny-warnings` + `oxfmt --check` + `bun test tests/unit/` + `tsc --noEmit`。
- 单文件测试：`bun test tests/unit/catalog.test.ts`
- 本地刷新目录（写 `models.json`、`_version.txt`、`manifest.json`）：`bun run sync -- --remote`

## CI

- `catalog-sync.yml`：每 6h + manual dispatch。检测上游 `command-code` 新版本，提取模型目录并**直推 `main`**（不经 PR）。commit message 格式 `models.json edited <UTC> (...)`。提取失败则开/更新 catalog-break issue（标签 `catalog-break`、`automation` 必须存在）。
- `ci.yml`：4 个 check —— test / typecheck / lint / format。

## 目录提取（`src/catalog.ts`）—— fragile by design

- 围绕锚点 `SONNET_4_6:{id:"claude-sonnet-4-6"` 切取平衡 `{…}` 区间，用锚点前 12k 字符收集的字符串绑定（`extractStringBindings`）eval。
- 压缩后的标识符名在 `command-code` 各版本间**不稳定**。1.40.x 引入 `$` 前缀变量（`$R="vercel-ai-gateway"`）；`\b` 在 `$`（非词字符）前永不命中——用 `(?<![A-Za-z0-9_$])` lookbehind。别名解析同理。
- 新 bundle 形态的症状：`Could not evaluate model catalog`——每个候选区间都抛错且被吞。调试：下载 tarball（`https://registry.npmjs.org/command-code/-/command-code-<v>.tgz`，bundle 是 `dist/cli.mjs`），用相同上下文手动 eval 候选区间，找出真实 ReferenceError（通常是缺失绑定，如 `$R is not defined`）。
- 每次修复必须带 `tests/unit/catalog.test.ts` 回归测试，fixture 镜像新压缩形态。`isModelCatalog` 要求 ≥2 个模型条目——单模型 fixture 会失败。

## ⚠️ 警示

- `models.json`、`manifest.json`、`_version.txt` 由 CI 自动生成（`catalog-sync.yml` 直推 main）。**勿手改**。提交前注意别把它们和手写改动混在一起。
- 从 opencode 会话里启动长驻服务必须**完全脱离**，否则子进程进入 opencode 作业对象/控制台导致会话被阻塞。
- 严禁按进程名批量结束进程（如 `Get-Process python | Stop-Process -Force`）：opencode 自身的 MCP 服务也是 `python.exe`/`node.exe`，批量杀掉会导致会话卡死。需要重启后台服务时按端口或命令行精确匹配目标。
