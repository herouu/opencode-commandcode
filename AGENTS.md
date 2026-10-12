# AGENTS.md

herouu 独立维护的 `@herouucn/opencode-commandcode`（独立 fork，不再跟踪上游）。运行时模型目录通过远程拉取保持最新，全部自动化为 GitHub Actions，改动在 `main` 直接进行并 push。

## 项目结构

```
index.ts          # package main：createCommandCode + re-export plugin/ 组合对象的 default
core/             # 与插件版本无关的业务逻辑（配置、目录加载、缓存落盘）
plugin/           # V1 / V2 双版本 adapter（只做版本接线，不含业务逻辑）
  index.ts        #   V2 组合入口（懒加载 v2 adapter 拿 { id, setup } 再与 server 组合）；opencode 目录入口经根 index.ts re-export
  v1.ts           #   V1 专用入口：server() 返回 config / auth hooks（纯同步，不 import @opencode/plugin）
  v2.ts           #   V2 adapter：Plugin.define({ id, setup }) + ctx.provider.transform + ctx.integration.transform（auth 方法接线）
src/              # AI SDK provider（createCommandCode）+ 目录提取 + 缓存/摘要写入
scripts/          # CI 与本地目录刷新脚本（catalog-sync-ci.ts、sync-models.ts）
  regression-v1v2.sh # 容器内 V1/V2 双版本回归脚本（见下节「devcontainer 回归」）
tests/unit/       # bun test 单元测试
.github/workflows # catalog-sync.yml / ci.yml / release.yml
.devcontainer/    # devcontainer 模式：Dockerfile（Node 22 + bun + 双版本 opencode）+ devcontainer.json
.dockerignore     # 构建上下文排除 node_modules/.git/.opencode 等，防止 Windows 产物污染 Linux 镜像
.gitattributes    # 强制 .sh / Dockerfile / .devcontainer/* 用 LF 行尾（CRLF 会让容器内 bash 直接报错）
```

根路径只保留 `index.ts` 一个 `.ts` 文件；其余 `.ts` 一律归入 `core/` 或 `plugin/`。

## 工程约束

- **adapter 不写业务逻辑**：`plugin/v1.ts`、`plugin/v2.ts` 只做版本接线（V1 的 `config`/`auth` hooks、V2 的 `Plugin.define` + `ctx.provider.transform` + `ctx.integration.transform`）。所有目录加载、配置读取、缓存与摘要落盘一律在 `core/`。改业务逻辑只改 `core/`，两个 adapter 共用同一份实现。
- **V2 adapter 必须同时注册 integration 与启用 provider**（缺一即坏，见下方两条源码依据）：
  - `ctx.integration.transform` 注册 `commandcode` 的 **key 方法**（`{type:"key",label}`）与 **env 方法**（`{type:"env",names:["COMMANDCODE_API_KEY"]}`）。key 方法保证 `opencode auth login` 能选到（v2 源码 `cli.auth.integrations` 的候选来自 `client.integration.list()`，且 login 会过滤掉只有 env 方法的 integration）。
  - 注册 integration 的同时必须把 provider `activation` 钉成 `"enabled"`：v2 源码（`packages/core/src/provider.ts` 的 provider 快照过滤）可用性判定为 `activation==="enabled" ∨ 该 integration 有 connection ∨ (provider.integrationID 未定义 ∧ 无同名 integration)`；一旦存在 id 为 `commandcode` 的 integration，第三个条件恒假，无凭证时整个 provider 会不可用（模型列表为空）。
  - 顺序影响：integration 的 `method.update` 会顺带创建 integration 记录（name 默认取 id），所以展示名另用 `editor.update(id, ref => ref.name = ...)` 补上。
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

## devcontainer 回归（V1 / V2）

容器内跑完整的双版本回归，宿主无需安装两版 opencode：

```sh
# 在仓库根执行；首次 build 要装两个约 150MB 的 opencode 平台二进制（5-10 分钟）
docker build -f .devcontainer/Dockerfile -t commandcode-reg .
docker run --rm commandcode-reg        # 默认 CMD → scripts/regression-v1v2.sh
```

- VS Code / opencode：「Dev Containers: Reopen in Container」走 `.devcontainer/devcontainer.json`（`postCreateCommand` 为 `bun install`，工作区绑定挂载 `${localWorkspaceFolder}` → `/workspace`）。
- 镜像内固定版本：V1 = `opencode-ai@1.18.29`（bin `opencode`）；V2 = `@opencode/cli@2.0.26`（bin `opencode2`）。真实包名是 `@opencode/cli`（**不是** `@opencode-ai/cli`）。⚠️ 两版必须**分 prefix 安装**再手动建符号链接（见 Dockerfile）：两个包都提供 `opencode` 这个 bin 名，而 npm 全局安装不会覆盖别的包已装好的同名 bin，用同一个全局 prefix 顺序安装会在第二次安装时报 EEXIST。
- 回归内容：容器内 `bun run check` + 10 条断言 —— V1 计数 > 20、V2 计数 > 20、**两版模型 key 集合一致**（核心断言）、`opencode2 plugin list` 含 `commandcode`、两版 `--version` major 分别为 1 / 2，以及 auth 四条：V1 `opencode auth login --provider commandcode --method "API Key"` 非交互写入 `$XDG_DATA_HOME/opencode/auth.json`、V2 `opencode2 auth login commandcode --method key` 不再报 `Integration not found` 且存下 credential、V2 `auth list` 显示 `COMMANDCODE_API_KEY` 的 environment 连接、V2 登录后模型数仍 > 20。凭证类断言一律解析 `opencode2 auth list --format json` 的连接类型（`credential` / `env`），不要对文本输出 grep `commandcode`——`COMMANDCODE_API_KEY` 会误命中。
- auth 非交互要点（容器内实测，勿改）：两版的 key 输入都是 clack 提示——V1 非 TTY 下喂 `\r` 即可提交（喂 `\n` 会超时）；**V2 强制要求交互式终端**（管道喂 stdin 直接 `API key input requires an interactive terminal` + EXIT=1），必须用 `script -qec "opencode2 auth login commandcode --method key" /dev/null` 分配伪终端再喂 `\r`。dummy key 只落在各版 ISO 数据目录内，属预期。
- V1 直接挂 `plugin/v1.ts`（挂目录必崩），V2 挂仓库目录（目录入口 → 根 `index.ts` → `plugin/index.ts`）；两版都用 `$XDG_CONFIG_HOME/opencode/opencode.jsonc`（**v2 不认 `opencode2.jsonc`**，只认 `config.json`/`opencode.json`/`opencode.jsonc`），并各自独立 `XDG_*` + `COMMANDCODE_PROVIDER_STATE_DIR` 隔离；`COMMANDCODE_CATALOG_URL=disabled` 保证确定性使用包内目录，不依赖网络与真实 API key。
- 计数口径（容器内实测）：V1 与 V2 的模型 key **逐字一致**（`src/catalog.ts` 的 `toConfigKey` 恒等返回目录 id，V1 不再剥首段/转小写），两版各 95 条，核心断言直接比较 **V1 行数 == V2 行数**（95 vs 95）。一份 model 引用（如 `commandcode/deepseek/deepseek-v4.1-flash`）在两版通用，同一份配置（如 oh-my-opencode-slim）无需按版本分叉。
- V2 不要用 `models --standalone`：`--standalone` 起的是私有 stdio 服务，插件 provider 不会注册进去（EXIT=0 但列表为空，不报错）；必须走 managed service。该服务冷启动时第一次查询也可能拿到空列表，脚本对 `models` / `plugin list` 各重试 3 次。
- **行尾警示**：`.sh` 与 Dockerfile 必须是 LF（`.gitattributes` 已强制，Windows 工作区其余文件仍是 CRLF）。CRLF 会让容器内 bash 报 `$'\r': command not found`、Docker 解析 Dockerfile 报错。改动这两个文件后确认 `CR=0`。
- 网络提示（本机环境相关）：Docker Desktop 的 Docker Hub 代理可能极慢/挂起导致 `docker build` 卡在拉取基础镜像。可先用可用镜像源预拉并打回原名，构建即走本地层：`docker pull dockerproxy.net/library/node:22-bookworm && docker tag dockerproxy.net/library/node:22-bookworm node:22-bookworm`。

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
