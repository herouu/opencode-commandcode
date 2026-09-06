#!/bin/bash
# opencode-commandcode 一键安装脚本
# 自动配置 opencode.json 以加载本插件

set -e

PLUGIN_NAME="@herouucn/opencode-commandcode"
CONFIG_DIR="$HOME/.config/opencode"
CONFIG_FILE="$CONFIG_DIR/opencode.json"

echo "=== opencode-commandcode 安装器 ==="

# 1. 检查 opencode 是否安装
if ! command -v opencode &> /dev/null; then
    echo "❌ opencode 未安装"
    echo "请先安装 opencode:"
    echo "  npm install -g opencode"
    echo "  或: curl -fsSL https://opencode.ai/install.sh | bash"
    exit 1
fi

# 2. 创建配置目录
mkdir -p "$CONFIG_DIR"

# 3. 读取现有配置或创建新配置
if [ -f "$CONFIG_FILE" ]; then
    echo "📄 读取现有配置: $CONFIG_FILE"
    # 检查是否已包含本插件
    if grep -q "$PLUGIN_NAME" "$CONFIG_FILE"; then
        echo "✅ 插件已在配置中，无需重复添加"
        exit 0
    fi
    # 合并配置：追加 plugin 和 provider.commandcode
    TMP_FILE=$(mktemp)
    node -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
        if (!cfg.plugin) cfg.plugin = [];
        if (!cfg.plugin.includes('$PLUGIN_NAME')) cfg.plugin.push('$PLUGIN_NAME');
        if (!cfg.provider) cfg.provider = {};
        if (!cfg.provider.commandcode) {
            cfg.provider.commandcode = {
                npm: '@ai-sdk/openai-compatible',
                name: 'commandcode',
                env: ['COMMANDCODE_API_KEY'],
                options: { baseURL: 'https://api.commandcode.ai/provider/v1/' }
            };
        }
        fs.writeFileSync('$TMP_FILE', JSON.stringify(cfg, null, 2) + '\n');
    " && mv "$TMP_FILE" "$CONFIG_FILE"
else
    echo "📄 创建新配置: $CONFIG_FILE"
    cat > "$CONFIG_FILE" << 'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@herouucn/opencode-commandcode"],
  "provider": {
    "commandcode": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "commandcode",
      "env": ["COMMANDCODE_API_KEY"],
      "options": {
        "baseURL": "https://api.commandcode.ai/provider/v1/"
      }
    }
  }
}
EOF
fi

echo "✅ 配置完成！"
echo ""
echo "下一步："
echo "1. 设置 API key（三选一）："
echo "   export COMMANDCODE_API_KEY=\"your-key\""
echo "   或: opencode auth login --provider commandcode"
echo "   或: 使用官方 CLI 登录 ~/.commandcode/auth.json"
echo ""
echo "2. 重启 opencode，插件将自动从 npm 安装并加载"
echo "   模型列表: /models → 选择 commandcode/xxx"
