# AGENTS.md

herouu 独立维护的 `@herouucn/opencode-commandcode`（独立 fork，不再跟踪上游）。运行时模型目录通过远程拉取保持最新，全部自动化为 GitHub Actions，改动在 `main` 直接进行并 push。

## 运行时目录加载（`plugin.ts`）

- 每次启动优先拉取 raw GitHub `models.json`（默认 `https://raw.githubusercontent.com/herouu/opencode-commandcode/main/models.json`）。
- 拉取失败回退 bundled `models.json` → 本地缓存 `catalog-cache.json`。
- 可用环境变量 `COMMANDCODE_CATALOG_URL`（或配置 `catalogUrl`）覆盖远程 URL；设为 `disabled` 关闭远程拉取。
- `src/startup.ts` 的 `StartupSummary.catalogSource` 含 `"remote"`。

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

`models.json`、`manifest.json`、`_version.txt` 由 CI 自动生成（`catalog-sync.yml` 直推 main）。**勿手改**。提交前注意别把它们和手写改动混在一起。
