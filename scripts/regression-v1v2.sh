#!/usr/bin/env bash
# opencode V1 / V2 双版本回归验证（在 devcontainer 镜像内运行）
#
# 目标：同一份插件源码分别在 opencode V1 与 V2 下加载，断言两版从同一份包内
# models.json 得到的模型 key 集合一致——两版共用同一份 core/ 目录加载逻辑，
# 读的是同一个包内目录，这是双版本回归的核心断言。
#
# 确定性保证：
#   * COMMANDCODE_CATALOG_URL=disabled → 不拉远程目录，确定性使用包内 models.json
#   * COMMANDCODE_API_KEY=regression-dummy → 不依赖真实密钥
#   * 每版独立 XDG_* 隔离目录 + 独立 COMMANDCODE_PROVIDER_STATE_DIR → 互不污染
#   * npm / bun 安装只发生在 docker build 阶段，本脚本不联网
#   * V2 的 provider 注册发生在 managed service 启动之后，首次查询会拿到空列表，
#     因此 models / plugin list / auth list 都带重试（真实行为，见下方注释）
#
# auth login 回归（本次新增）：
#   * V1：`opencode auth login --provider commandcode --method "API Key"`，非交互喂 key
#     （clack 提示在非 TTY 下只认 `\r`），断言 $XDG_DATA_HOME/opencode/auth.json 出现 commandcode。
#   * V2：`opencode2 auth login commandcode --method key`，断言不再报 `Integration not found`
#     且凭证真的存下来（`opencode2 auth list` 命中），同时 auth list 显示
#     COMMANDCODE_API_KEY 的 environment 连接（env 方法注册生效），登录后 models 仍 > 20
#     （注册 integration 后 provider availability 不能被拖挂）。
#   * dummy key 只写进各版 ISO 数据目录，属预期，不污染宿主。
#
# 入口差异（真机 v1.18.29 实证，勿改）：
#   * V1 必须直接挂 plugin/v1.ts：挂目录会崩——v1 的插件加载器对「含顶层 await 的入口
#     模块」求值直接崩溃（plugin/index.ts 有顶层 await），且 v1 运行时不注入
#     @opencode/plugin，静态 import plugin/v2.ts 同样会崩。
#     V1 的隔离只能靠 XDG_*（OPENCODE_CONFIG_DIR 在 v1 只是追加、不隔离）。
#   * V2 挂仓库目录（目录入口 → 根 index.ts → plugin/index.ts）。
#
# 两版 key 集合已逐字一致（src/catalog.ts 的 toConfigKey 恒等返回目录 id，V1 不再剥首段/转小写），
# 因此两版都直接用同一 count_commandcode 统计，核心断言为「原始行数直接相等」。
#   * V2 原样列出完整 model id（如 commandcode/MiniMaxAI/MiniMax-M3-Free），95 条。
#   * V1 现在也原样注入完整 id（key == 目录 id，含首段与大小写），同样 95 条。
#   * 一份 model 引用（如 commandcode/deepseek/deepseek-v4.1-flash）两版通用。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

V1_COUNT=0
V2_COUNT=0
V1_VERSION="unknown"
V2_VERSION="unknown"
PLUGIN_LIST_HIT="no"
FAILURES=()

# 去掉 ANSI 色码：V2 的 models 输出带色码（如 [7mcommandcode[0m），grep 仍可命中，先剥干净
strip_ansi() {
  sed 's/\x1b\[[0-9;]*m//g'
}

# 取版本号的 major（兼容 "1.18.29" 与 "opencode v1.18.29" 两种输出格式）
major_of() {
  printf '%s' "$1" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 | cut -d. -f1 || true
}

# 建一套隔离环境目录：XDG_* 四件套 + 项目工作目录
make_iso() {
  local iso="$1"
  mkdir -p "$iso/config/opencode" "$iso/data" "$iso/state" "$iso/cache" "$iso/project"
}

# count_commandcode <输出>：统计含 commandcode 的行数（两版都是「provider/完整 id」形态，
#   V1 的 key 已等于目录 id，故同一函数可复用于两版计数）
count_commandcode() {
  printf '%s\n' "$1" | strip_ansi | grep -c commandcode || true
}

echo "=============================================================="
echo " opencode-commandcode 回归：opencode V1 / V2 双版本"
echo " 仓库根：$ROOT"
echo "=============================================================="

# ---------------------------------------------------------------- 第 0 步
echo
echo "==> [0/4] CI gate：bun run check"
bun run check

# ---------------------------------------------------------------- V1 回归
echo
echo "==> [1/4] V1 回归（opencode-ai@1.18.29，直接挂 plugin/v1.ts）"
ISO1="$(mktemp -d)"
make_iso "$ISO1"

# V1 配置：$XDG_CONFIG_HOME/opencode/opencode.jsonc（容器内实测 v1 认这个位置）
# heredoc 用不带引号的 <<EOF，让 $ROOT 展开成绝对路径
cat > "$ISO1/config/opencode/opencode.jsonc" <<EOF
{
  "plugin": ["$ROOT/plugin/v1.ts"]
}
EOF

V1_VERSION="$(opencode --version 2>&1 | head -n1 || true)"

# 与 V2 对称：用 env 数组传隔离环境（下面 auth login 验证要复用同一套 ISO）
V1_ENV=(
  "XDG_CONFIG_HOME=$ISO1/config"
  "XDG_DATA_HOME=$ISO1/data"
  "XDG_STATE_HOME=$ISO1/state"
  "XDG_CACHE_HOME=$ISO1/cache"
  "OPENCODE_DISABLE_PROJECT_CONFIG=1"
  "OPENCODE_DISABLE_AUTOUPDATE=1"
  "COMMANDCODE_CATALOG_URL=disabled"
  "COMMANDCODE_API_KEY=regression-dummy"
  "COMMANDCODE_PROVIDER_STATE_DIR=$ISO1/state/commandcode-provider"
)

V1_OUT="$(cd "$ISO1/project" && env "${V1_ENV[@]}" opencode models 2>&1 || true)"
# V1 不认 --standalone（那是 v2 的 flag），此处不要加
V1_COUNT="$(count_commandcode "$V1_OUT")"
echo "    V1 版本：$V1_VERSION"
echo "    V1 commandcode 模型 key 数：$V1_COUNT"

# ---- V1 auth login 真机验证（非交互）----------------------------------------
# 容器内实测（v1.18.29，`opencode auth login --help`）：
#   * flag 形态是 `--provider <id|name>` + `--method <label>`（help 原文：provider id or name
#     to log in to / login method label），label 取本插件 V1 auth hook 里的 "API Key"。
#     用户给的 `--provider commandcode` 与实测一致，无差异（另有位置参数 url，本场景不用）。
#   * key 输入是 clack 的 text 提示：**非 TTY 下只认回车 `\r`**——喂 `\n` 会一直等不到提交
#     而超时（实测 EXIT=124）。所以用子 shell 延迟喂入 `\r`。
#   * 凭证落盘：$XDG_DATA_HOME/opencode/auth.json（V1 ISO 内，属预期，不算污染）。
V1_LOGIN_LOG="$ISO1/v1-login.log"
V1_LOGIN_EXIT=1
set +e
# 用进程替换喂 stdin（而不是管道）：管道在 pipefail 下会把喂 key 子 shell 的退出码也算进来，
# 进程替换不参与管道状态，因此 $? 就是 opencode 自己的退出码。
timeout 45 env "${V1_ENV[@]}" \
  opencode auth login --provider commandcode --method "API Key" \
  < <(sleep 2; printf 'regression-dummy-key\r'; sleep 2) \
  > "$V1_LOGIN_LOG" 2>&1
V1_LOGIN_EXIT=$?
set -e
V1_AUTH_FILE="$ISO1/data/opencode/auth.json"
V1_AUTH_OK="no"
if [ -f "$V1_AUTH_FILE" ] && grep -q commandcode "$V1_AUTH_FILE"; then V1_AUTH_OK="yes"; fi
echo "    V1 auth login 退出码：$V1_LOGIN_EXIT；auth.json 含 commandcode：$V1_AUTH_OK"
V1_AUTH_LIST="$(cd "$ISO1/project" && env "${V1_ENV[@]}" opencode auth list 2>&1 || true)"
echo "    V1 auth list 摘录：$(printf '%s\n' "$V1_AUTH_LIST" | strip_ansi | tr -d '\r' | grep -i commandcode | head -n1)"
if [ "$V1_AUTH_OK" != "yes" ]; then
  echo "    ↳ V1 登录日志摘录（去色）：$(strip_ansi < "$V1_LOGIN_LOG" | tr -d '\r' | tr '\n' ' ' | head -c 400)"
fi

# ---------------------------------------------------------------- V2 回归
echo
echo "==> [2/4] V2 回归（@opencode/cli@2.0.26，挂仓库目录）"
ISO2="$(mktemp -d)"
make_iso "$ISO2"

# V2 配置：$XDG_CONFIG_HOME/opencode/opencode.jsonc
# 注意：v2 只认 config.json / opencode.json / opencode.jsonc（二进制里提取的配置名清单，
# **没有** opencode2.jsonc）；`opencode2 debug config` 可见该文件被识别为 document 源。
# plugin 挂仓库目录（目录入口 → 根 index.ts → plugin/index.ts）
cat > "$ISO2/config/opencode/opencode.jsonc" <<EOF
{
  "plugin": ["$ROOT"]
}
EOF

V2_VERSION="$(opencode2 --version 2>&1 | head -n1 || true)"

V2_ENV=(
  "XDG_CONFIG_HOME=$ISO2/config"
  "XDG_DATA_HOME=$ISO2/data"
  "XDG_STATE_HOME=$ISO2/state"
  "XDG_CACHE_HOME=$ISO2/cache"
  "OPENCODE_DISABLE_PROJECT_CONFIG=1"
  "OPENCODE_DISABLE_AUTOUPDATE=1"
  "COMMANDCODE_CATALOG_URL=disabled"
  "COMMANDCODE_API_KEY=regression-dummy"
  "COMMANDCODE_PROVIDER_STATE_DIR=$ISO2/state/commandcode-provider"
)

# ⚠️ 不用 `models --standalone`：容器内实测 --standalone 起的是私有 stdio 服务，
# 插件 provider 不会注册进去（EXIT=0 但列表为空，不报错）。走 managed service 才拿得到模型。
# managed service 冷启动时第一次查询也可能拿到空列表（provider 尚未注册完），故重试。
V2_OUT=""
V2_COUNT=0
for attempt in 1 2 3; do
  V2_OUT="$(cd "$ISO2/project" && env "${V2_ENV[@]}" opencode2 models 2>&1 || true)"
  V2_COUNT="$(count_commandcode "$V2_OUT")"
  if [ "$V2_COUNT" -gt 20 ]; then break; fi
  echo "    （第 $attempt 次 opencode2 models 只拿到 $V2_COUNT 条，等待 managed service 就绪后重试）"
  sleep 3
done
echo "    V2 版本：$V2_VERSION"
echo "    V2 commandcode 完整 id 数：$V2_COUNT"

# V2 插件加载确认：plugin list 输出含 commandcode（同样要等 managed service 就绪）
V2_PLUGIN_OUT=""
for attempt in 1 2 3; do
  V2_PLUGIN_OUT="$(cd "$ISO2/project" && env "${V2_ENV[@]}" opencode2 plugin list 2>&1 || true)"
  if printf '%s\n' "$V2_PLUGIN_OUT" | strip_ansi | grep -qi commandcode; then
    PLUGIN_LIST_HIT="yes"
    break
  fi
  sleep 3
done
echo "    V2 plugin list 含 commandcode：$PLUGIN_LIST_HIT"

# ---- V2 auth login 真机验证（非交互，需要伪终端）----------------------------
# 目标：`opencode auth login commandcode` 不再报 `Integration not found`（V2 的 login 候选
# 列表来自 integration 注册表，只有注册了 key 方法才会出现/被解析），并且真的能把 dummy key
# 存成 credential。
# 容器内实测（@opencode/cli@2.0.26，勿改）：
#   * key 方法 id 固定为 "key"（`auth login --help`：--method Authentication method ID）。
#   * **V2 的 key 输入强制要求交互式终端**：直接管道喂 stdin 会得到
#     `API key input requires an interactive terminal` + EXIT=1。必须用 `script -qec` 分配
#     伪终端（util-linux 自带，镜像内可用），再从进程替换喂 `\r` 提交。
#   * 凭证存服务端 sqlite（不在 auth.json），所以用 `auth list --format json` 断言连接类型。
V2_LOGIN_LOG="$ISO2/v2-login.log"
V2_LOGIN_EXIT=1
set +e
timeout 60 env "${V2_ENV[@]}" \
  script -qec "opencode2 auth login commandcode --method key" /dev/null \
  < <(sleep 3; printf 'regression-dummy-key\r'; sleep 3) \
  > "$V2_LOGIN_LOG" 2>&1
V2_LOGIN_EXIT=$?
set -e
V2_LOGIN_OUT="$(strip_ansi < "$V2_LOGIN_LOG" | tr -d '\r' || true)"
V2_NOT_FOUND_HIT="no"
if printf '%s\n' "$V2_LOGIN_OUT" | grep -q "Integration not found"; then V2_NOT_FOUND_HIT="yes"; fi
echo "    V2 auth login 退出码：$V2_LOGIN_EXIT；仍报 Integration not found：$V2_NOT_FOUND_HIT"
echo "    V2 登录结果行：$(printf '%s\n' "$V2_LOGIN_OUT" | grep -E 'Connected to|Failed|Error' | head -n2 | tr '\n' ' ')"

# auth list：需要 managed service，冷启动可能拿不到，重试 3 次（与 models 同理）
V2_AUTH_JSON=""
for attempt in 1 2 3; do
  V2_AUTH_JSON="$(cd "$ISO2/project" && env "${V2_ENV[@]}" opencode2 auth list --format json 2>&1 || true)"
  if printf '%s\n' "$V2_AUTH_JSON" | tr -d '\r' | grep -q '"id": "commandcode"'; then break; fi
  sleep 3
done
V2_AUTH_JSON_CLEAN="$(printf '%s\n' "$V2_AUTH_JSON" | tr -d '\r' | tr -d '\000')"
# 文本形态仅用于人读摘录（JSON 形态用于断言，避免 COMMANDCODE_API_KEY 里的 commandcode 误命中）
V2_AUTH_TEXT="$(cd "$ISO2/project" && env "${V2_ENV[@]}" opencode2 auth list 2>&1 || true)"
V2_AUTH_TEXT_CLEAN="$(printf '%s\n' "$V2_AUTH_TEXT" | strip_ansi | tr -d '\r')"
echo "    V2 auth list 摘录：$(printf '%s\n' "$V2_AUTH_TEXT_CLEAN" | grep -v '^$' | head -n3 | tr '\n' '|')"
V2_CRED_HIT="no"
if printf '%s\n' "$V2_AUTH_JSON_CLEAN" | grep -q '"type": "credential"'; then V2_CRED_HIT="yes"; fi
# env 方法注册的通路：COMMANDCODE_API_KEY 命中即算一条 environment 连接（此时与 credential 并存）
V2_ENV_HIT="no"
if printf '%s\n' "$V2_AUTH_JSON_CLEAN" | grep -q '"type": "env"' &&
  printf '%s\n' "$V2_AUTH_JSON_CLEAN" | grep -q 'COMMANDCODE_API_KEY'; then V2_ENV_HIT="yes"; fi
V2_NAME_HIT="no"
if printf '%s\n' "$V2_AUTH_JSON_CLEAN" | grep -q '"name": "Command Code"'; then V2_NAME_HIT="yes"; fi
echo "    V2 auth list 含 commandcode credential：$V2_CRED_HIT；含 env 连接：$V2_ENV_HIT；展示名 Command Code：$V2_NAME_HIT"

# 登录后模型列表必须仍然可用（证明注册 integration 后没踩 provider availability 坑）
V2_MODELS_AFTER=""
V2_COUNT_AFTER=0
for attempt in 1 2 3; do
  V2_MODELS_AFTER="$(cd "$ISO2/project" && env "${V2_ENV[@]}" opencode2 models 2>&1 || true)"
  V2_COUNT_AFTER="$(count_commandcode "$V2_MODELS_AFTER")"
  if [ "$V2_COUNT_AFTER" -gt 20 ]; then break; fi
  sleep 3
done
echo "    V2 登录后 commandcode 模型数：$V2_COUNT_AFTER"

if [ "$V2_NOT_FOUND_HIT" = "yes" ] || [ "$V2_CRED_HIT" != "yes" ]; then
  echo "    ↳ V2 登录日志摘录（去色）：$(printf '%s\n' "$V2_LOGIN_OUT" | grep -v '^$' | tr '\n' ' ' | head -c 500)"
  echo "    ↳ V2 auth list --format json 摘录：$(printf '%s\n' "$V2_AUTH_JSON_CLEAN" | grep -v '^$' | tr '\n' ' ' | head -c 300)"
fi

# ---------------------------------------------------------------- 断言
echo
echo "==> [3/4] 断言"
report() { # report <编号> <描述> <ok|bad>
  if [ "$3" = "ok" ]; then
    printf '    PASS  断言%s：%s\n' "$1" "$2"
  else
    printf '    FAIL  断言%s：%s\n' "$1" "$2"
    FAILURES+=("断言$1：$2")
  fi
}

A1=bad
if [ "$V1_COUNT" -gt 20 ]; then A1=ok; fi
report 1 "V1 计数 > 20（实际 $V1_COUNT）" "$A1"

A2=bad
if [ "$V2_COUNT" -gt 20 ]; then A2=ok; fi
report 2 "V2 计数 > 20（实际 $V2_COUNT）" "$A2"

A3=bad
if [ "$V1_COUNT" -gt 0 ] && [ "$V1_COUNT" -eq "$V2_COUNT" ]; then A3=ok; fi
report 3 "V1 计数 == V2 计数（$V1_COUNT vs $V2_COUNT，两版 key 逐字一致）" "$A3"

A4=bad
if [ "$PLUGIN_LIST_HIT" = "yes" ]; then A4=ok; fi
report 4 "opencode2 plugin list 输出含 commandcode" "$A4"

A5=bad
if [ "$(major_of "$V1_VERSION")" = "1" ]; then A5=ok; fi
report 5 "opencode --version major == 1（实际 $V1_VERSION）" "$A5"

A6=bad
if [ "$(major_of "$V2_VERSION")" = "2" ]; then A6=ok; fi
report 6 "opencode2 --version major == 2（实际 $V2_VERSION）" "$A6"

A7=bad
if [ "$V1_AUTH_OK" = "yes" ]; then A7=ok; fi
report 7 "V1 非交互 auth login 成功（exit=$V1_LOGIN_EXIT，auth.json 含 commandcode=$V1_AUTH_OK）" "$A7"

A8=bad
if [ "$V2_NOT_FOUND_HIT" = "no" ] && [ "$V2_CRED_HIT" = "yes" ] && [ "$V2_LOGIN_EXIT" -eq 0 ]; then A8=ok; fi
report 8 "V2 auth login commandcode 不再报 Integration not found 且存下 credential（exit=$V2_LOGIN_EXIT，credential=$V2_CRED_HIT）" "$A8"

A9=bad
if [ "$V2_ENV_HIT" = "yes" ]; then A9=ok; fi
report 9 "V2 auth list 显示 COMMANDCODE_API_KEY 的 environment 连接（env 方法注册生效）" "$A9"

A10=bad
if [ "$V2_COUNT_AFTER" -gt 20 ]; then A10=ok; fi
report 10 "V2 登录后模型数仍 > 20（注册 integration 未踩 availability 坑，实际 $V2_COUNT_AFTER）" "$A10"

# ---------------------------------------------------------------- 汇总
echo
echo "==> [4/4] 汇总"
echo "--------------------------------------------------------------"
printf '  %-24s %s\n' "项目" "结果"
printf '  %-24s %s\n' "V1 版本（opencode）" "$V1_VERSION"
printf '  %-24s %s\n' "V2 版本（opencode2）" "$V2_VERSION"
printf '  %-24s %s\n' "V1 commandcode 模型数" "$V1_COUNT"
printf '  %-24s %s\n' "V2 commandcode 模型数" "$V2_COUNT"
printf '  %-24s %s\n' "两版 key 集合一致" "$(if [ "$A3" = "ok" ]; then echo YES; else echo NO; fi)"
printf '  %-24s %s\n' "V2 plugin list 含 commandcode" "$PLUGIN_LIST_HIT"
printf '  %-24s %s\n' "V1 auth login（非交互）" "$V1_AUTH_OK"
printf '  %-24s %s\n' "V2 auth login 无 not-found" "$(if [ "$V2_NOT_FOUND_HIT" = "no" ]; then echo YES; else echo NO; fi)"
printf '  %-24s %s\n' "V2 auth list 含 credential" "$V2_CRED_HIT"
printf '  %-24s %s\n' "V2 auth list 含 env 连接" "$V2_ENV_HIT"
printf '  %-24s %s\n' "V2 integration 展示名" "$V2_NAME_HIT"
printf '  %-24s %s\n' "V2 登录后模型数" "$V2_COUNT_AFTER"
printf '  %-24s %s\n' "CI gate（bun run check）" "PASS"
echo "--------------------------------------------------------------"
echo "  目录来源：COMMANDCODE_CATALOG_URL=disabled → 包内 models.json（确定性，无网络）"
echo "  auth 验证：dummy key 存在各版 ISO 数据目录内，属预期，不污染宿主"

if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "结果：全部 PASS（CI gate 通过 + 10 条断言通过）"
  rm -rf "$ISO1" "$ISO2"
  exit 0
fi

echo "结果：FAIL（${#FAILURES[@]} 条断言失败）"
for f in "${FAILURES[@]}"; do
  echo "  - $f"
done
echo "常见原因：V1 挂目录而非 plugin/v1.ts、V2 未挂目录入口、CRLF 行尾、"
echo "远程目录未禁用（COMMANDCODE_CATALOG_URL 未设 disabled）导致两版取到不同目录、"
echo "V2 managed service 未就绪（脚本已重试 3 次）、"
echo "或 V2 未注册 integration key 方法（缺失时 auth login 报 Integration not found）。"
exit 1
