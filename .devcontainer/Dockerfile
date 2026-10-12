# devcontainer 镜像：Node 22 + bun + 双版本 opencode（V1 / V2）
#
# 注意：本文件必须使用 LF 行尾（见仓库根 .gitattributes）。CRLF 会让 Docker 解析失败。
FROM node:22-bookworm

# bun：项目的包管理器与 CI gate 运行器（bun install / bun run check）
RUN npm install -g bun

ENV OPENCODE_DISABLE_AUTOUPDATE=1

# 双版本 opencode，固定版本以与宿主真机验证保持一致：
#   V1 = opencode-ai@1.18.29   平台二进制包：opencode-linux-x64
#   V2 = @opencode/cli@2.0.26  平台二进制包：@opencode/cli-linux-x64
# 真实包名是 @opencode/cli（不是 @opencode-ai/cli）。
#
# ⚠️ 必须分 prefix 安装 + 手动建符号链接：两个包都提供 `opencode` 这个 bin 名，
# 而 npm 全局安装不会覆盖「别的包已安装的同名 bin」，直接用同一个全局 prefix 顺序安装
# 会在第二次安装时报 EEXIST（实测：`npm error Remove the existing file and try again`）。
# 所以各自装进独立 prefix，再显式把两个 bin 名链接到 /usr/local/bin：
#   opencode  → V1
#   opencode2 → V2（@opencode/cli 自带这个别名 bin）
# 两个包各含约 150MB 平台二进制，npm install 是构建耗时大头。
RUN npm install -g --prefix /opt/opencode-v1 opencode-ai@1.18.29 \
 && npm install -g --prefix /opt/opencode-v2 @opencode/cli@2.0.26 \
 && ln -sf /opt/opencode-v1/bin/opencode /usr/local/bin/opencode \
 && ln -sf /opt/opencode-v2/bin/opencode2 /usr/local/bin/opencode2 \
 && opencode --version \
 && opencode2 --version

WORKDIR /workspace
COPY . /workspace

# 把 devDependencies 装进镜像，使 `docker run --rm` 不挂载工作区也能跑 bun run check
RUN bun install

# 默认跑完整回归：CI gate + V1/V2 双版本模型计数断言
CMD ["bash", "scripts/regression-v1v2.sh"]
