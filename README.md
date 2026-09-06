# opencode-commandcode

[![CI](https://img.shields.io/github/actions/workflow/status/herouu/opencode-commandcode/ci.yml?branch=main&label=CI)](https://github.com/herouu/opencode-commandcode/actions)
[![npm version](https://img.shields.io/npm/v/@herouucn/opencode-commandcode)](https://www.npmjs.com/package/@herouucn/opencode-commandcode)
[![npm downloads/month](https://img.shields.io/npm/dm/@herouucn/opencode-commandcode)](https://www.npmjs.com/package/@herouucn/opencode-commandcode)
[![npm downloads/week](https://img.shields.io/npm/dw/@herouucn/opencode-commandcode)](https://www.npmjs.com/package/@herouucn/opencode-commandcode)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@herouucn/opencode-commandcode)](https://bundlephobia.com/package/@herouucn/opencode-commandcode)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Command Code](https://commandcode.ai)（统一多模型 API）的 [opencode](https://opencode.ai) provider。一个 key 即可在 opencode 中使用 Claude、GPT、Gemini、DeepSeek、Qwen、Kimi、GLM、MiniMax、Step 等 **70+ 模型**。

安装即用：插件启动时自动注入 provider 配置、API key 读取与最新模型目录，无需任何手写配置；模型目录随上游发布自动同步，新模型即时可用。

## 特性

| 特性 | 说明 |
|---|---|
| 零配置接入 | 安装后重启 opencode 即可使用，provider 配置与模型列表自动注入 |
| 单 key 多模型 | 一个 Command Code API key 聚合 70+ 模型（Claude、GPT、Gemini、DeepSeek 等） |
| 运行时目录同步 | 每次启动拉取最新 `models.json`，上游新模型即时生效 |
| 离线兜底 | 拉取失败自动回退包内静态目录 → 本地缓存，模型不缺失 |
| 目录自同步 | CI 每 6 小时检测上游 `command-code` 新版本并直推 `main` |
| 安全发布 | 基于 GitHub OIDC Trusted Publishing 发布 npm，无需 long-lived token |

## 演示

<script src="https://asciinema.org/a/1264752.js" id="asciicast-1264752" async data-speed="2" data-idle-time-limit="2"></script>

> GitHub 渲染 README 时不支持 `<script>` 嵌入；如需在支持 HTML 的站点（如文档站）使用，直接复制上方代码即可。

安装插件 → 重启 opencode → `/models` 中选择 Command Code 模型 → 直接对话。

## 安装

安装插件：

```bash
opencode plugin @herouucn/opencode-commandcode
```

或手动在 `opencode.json` 声明：

```jsonc
// opencode.json
{
  "plugin": ["@herouucn/opencode-commandcode"]
}
```

本地开发可直接用路径：`"plugin": ["file:///absolute/path/to/opencode-commandcode"]`。

重启 opencode 后在 `/models` 中选择 Command Code 模型即可对话。

## 配置

API key 任选一种方式提供：

```bash
export COMMANDCODE_API_KEY="你的 key"     # 方式一：环境变量
```

```bash
opencode auth login --provider commandcode   # 方式二：交互式（/connect 搜 Command Code）
```

方式三：`~/.commandcode/auth.json`（若已用官方 CLI 登录则自动复用）。

> 插件自动注入 provider 配置（`npm`、baseURL、模型列表）且不覆盖已存在的手写配置。手动配置 `provider.commandcode.options.baseURL` 时请保留 `npm: "@ai-sdk/openai-compatible"` 或指定其他兼容 SDK，否则 opencode 无法解析 provider。

### 目录源（可选覆盖）

默认拉取本仓库 `main` 分支的 `models.json`，一般无需配置。可用环境变量 `COMMANDCODE_CATALOG_URL` 或配置 `catalogUrl` 覆盖：

| 取值 | 行为 |
|---|---|
| URL | 每次启动拉取该地址（8s 超时），成功后写本地缓存 |
| `disabled` | 关闭远程拉取，仅用包内静态 `models.json` |

## 工作原理

插件采用 opencode 的 **config hook**：opencode 每次启动时执行插件导出的 `config` 函数，并向其传入待解析的全局配置。插件在 config hook 中完成两件事：

1. **注入 provider 配置**：通过 `??=` 确保 `provider.commandcode` 块存在，并补齐 `npm: "@ai-sdk/openai-compatible"`、name、`COMMANDCODE_API_KEY` env 与默认 `baseURL`，实现安装即用、零手写配置。若用户已显式书写该块，插件不会覆盖已存在字段。
2. **注入模型目录**：按 `远程 models.json → opt-in 本地包 → 包内静态 → 本地缓存` 顺序加载模型列表，写入 `provider.commandcode.models`。

配合 opencode 的 `auth` hook 声明 API Key 认证方式，`/connect` 与 `opencode auth login --provider commandcode` 可直接完成登录。

```mermaid
sequenceDiagram
    autonumber
    participant NPM as command-code 官方 npm
    participant CI as catalog-sync CI
    participant REPO as 本仓库 main
    participant PLUGIN as 插件 config hook
    participant CACHE as 本地缓存
    participant OC as opencode 模型列表

    rect rgb(235, 248, 255)
    Note over NPM,REPO: 同步线 · 每 6 小时（后台）
    NPM->>CI: 发布新版本 command-code@X
    CI->>CI: 比对 _version.txt，版本不一致
    CI->>CI: sync-models 提取模型
    alt 提取成功且模型数达标
        CI->>REPO: 直推 models.json（不经 PR）
    else 提取失败 / 跌破保护线
        CI->>REPO: 开 catalog-break issue，不推坏数据
    end
    end

    rect rgb(255, 250, 235)
    Note over PLUGIN,OC: 使用线 · 每次启动（用户可见）
    PLUGIN->>REPO: fetch raw models.json（8s 超时）
    alt 拉取成功
        PLUGIN->>CACHE: 写入缓存
    else 拉取失败
        PLUGIN->>CACHE: 回退 bundled → 缓存
    end
    CACHE->>PLUGIN: 模型列表
    PLUGIN->>OC: 注入 provider.commandcode.models
    end
```

三处关键设计：

1. **目录自更新**：`.github/workflows/catalog-sync.yml` 每 6 小时比对上游 `command-code` npm 版本与 `_version.txt`，有新版本则重新提取模型并**直接推送到 main**。
2. **运行时解耦**：插件每次启动 fetch 本仓库 raw `models.json`，模型更新不依赖 npm 发版。
3. **质量护栏**：模型数跌破保护线时触发 `catalog-break` issue 并回滚，坏数据不落库。

## 发布

本仓库使用 **GitHub OIDC Trusted Publishing**，无需 long-lived npm token。push `v*` tag 触发 `release.yml`：先跑 check（lint + format + typecheck + unit test），通过后 `npm publish --provenance`。

```bash
npm version patch   # 或 minor / major
git push origin main --tags
```

**npm 包**：[@herouucn/opencode-commandcode](https://www.npmjs.com/package/@herouucn/opencode-commandcode)

## 开发与维护

```bash
bun install
bun run check          # CI 门槛：oxlint + oxfmt --check + bun test + tsc
bun run sync -- --remote   # 本地手动刷新 models.json / manifest.json / _version.txt
```

> ⚠️ `models.json`、`manifest.json`、`_version.txt` 由 CI / 同步脚本自动生成，**不要手改**。

CI 一览：

- **`ci.yml`** — 4 个 check（test / typecheck / lint / format），push 与 PR 触发。
- **`catalog-sync.yml`** — 每 6 小时 + 手动 dispatch，直推 main（不经 PR、不发版）。
- **`release.yml`** — push `v*` tag 或手动 dispatch，check + trusted publishing 发布。

## 常见问题

**模型列表不更新？**
先确认能访问 `https://raw.githubusercontent.com/herouu/opencode-commandcode/main/models.json`；再查本机状态 `~/.local/state/opencode/commandcode-provider/startup.json` 里的 `catalogSource` 字段（应为 `remote`）。

**升级插件后模型列表还是旧的 / 行为异常？**
opencode 将插件缓存于 `~/.cache/opencode/packages/@herouucn/`。删除该目录后重跑 `opencode models` 强制重拉最新版：

```bash
Remove-Item -Recurse -Force "$HOME\.cache\opencode\packages\@herouucn"
```

**`opencode models` 报 `undefined is not an object (evaluating '$.models')`？**
确认已升级到 **v0.1.7 及以上**。v0.1.6 及更早版本在全局配置 `provider: {}`（空对象）时，config hook 会跳过 commandcode 注入，导致 opencode 内部崩溃。v0.1.7 起改用 `??=` 确保 commandcode 块始终存在。

**离线环境能用吗？**
能。首次成功后模型已写入本地缓存；离线启动时走 `bundled → cache` 回退链，模型不缺失。

## 致谢

本项目由 [herouu](https://github.com/herouuu) 独立维护。初始灵感来自 [BrainerVirus/opencode-commandcode](https://github.com/BrainerVirus/opencode-commandcode)（[Brent Weatherall](https://github.com/brent-weatherall) 原始实现），现已完全独立开发。

## 许可证

MIT — 见 [LICENSE](LICENSE)。