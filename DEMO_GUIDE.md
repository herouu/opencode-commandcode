# 演示截图指南

请在终端运行以下命令，截图保存到 `docs/screenshots/` 目录。

## 截图 1：安装插件

运行：
```bash
opencode plugin @herouucn/opencode-commandcode
```

预期输出：显示插件已添加到配置。

## 截图 2：查看模型

运行：
```bash
opencode models
```

预期输出：显示 commandcode/ 开头的 70+ 模型列表。

## 截图 3：选择模型

运行 opencode 后输入 `/models`，显示模型选择界面。

## 截图 4：实际对话

选择一个模型（如 commandcode/deepseek-v4-flash），发送一条消息，显示回复。

---

截图命名：
- `docs/screenshots/01-install.png`
- `docs/screenshots/02-models.png`
- `docs/screenshots/03-select.png`
- `docs/screenshots/04-chat.png`

然后更新 README：

```markdown
## 演示

![安装插件](./docs/screenshots/01-install.png)
![模型列表](./docs/screenshots/02-models.png)
```
