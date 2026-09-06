#!/usr/bin/env python3
"""
根据命令列表生成 asciinema v2 格式录制文件
解决 PowerSession-rs 在 Windows 上录制 TUI 程序时管道断裂的问题

用法：
  1. 编辑 commands.txt，每行一条命令
  2. 运行 python gen_cast.py
  3. 输出 demo.cast（asciinema v2 格式）
"""

import json
import time
import os
import sys
import subprocess
import tempfile

COMMANDS_FILE = os.path.join(os.path.dirname(__file__), "commands.txt")
OUTPUT_CAST = os.path.join(os.path.dirname(__file__), "demo.cast")
WIDTH = 120
HEIGHT = 30

def run_command(cmd, timeout=30):
    """运行命令，返回 (stdout, stderr, duration)"""
    start = time.time()
    try:
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace"
        )
        duration = time.time() - start
        return result.stdout, result.stderr, duration
    except subprocess.TimeoutExpired:
        duration = time.time() - start
        return f"[timeout after {timeout}s]", "", duration
    except Exception as e:
        duration = time.time() - start
        return "", str(e), duration

def main():
    # 读取命令列表
    if not os.path.exists(COMMANDS_FILE):
        print(f"未找到 {COMMANDS_FILE}")
        print("请创建该文件，每行一条命令，例如：")
        print("  opencode plugin @herouucn/opencode-commandcode")
        print("  opencode models | findstr commandcode/")
        sys.exit(1)

    with open(COMMANDS_FILE, "r", encoding="utf-8") as f:
        commands = [line.strip() for line in f if line.strip() and not line.startswith("#")]

    if not commands:
        print(f"{COMMANDS_FILE} 为空")
        sys.exit(1)

    print(f"读取到 {len(commands)} 条命令，开始录制...")

    # 准备 cast 文件
    header = {
        "version": 2,
        "width": WIDTH,
        "height": HEIGHT,
        "timestamp": int(time.time()),
        "env": {
            "TERM": "xterm-256color",
            "SHELL": "powershell.exe" if sys.platform == "win32" else os.environ.get("SHELL", "/bin/bash")
        }
    }

    events = []
    current_time = 0.0

    # 初始清屏
    events.append([current_time, "o", "\u001b[2J\u001b[H\u001b[?25h"])
    current_time += 0.1

    for i, cmd in enumerate(commands):
        # 显示命令提示符
        prompt = f"PS C:\\> " if sys.platform == "win32" else "$ "
        events.append([current_time, "o", prompt])
        current_time += 0.1

        # 逐字符输入命令
        for char in cmd:
            events.append([current_time, "i", char])
            current_time += 0.02

        # 回车
        events.append([current_time, "o", "\r\n"])
        current_time += 0.1

        # 执行命令
        print(f"  [{i+1}/{len(commands)}] {cmd}")
        stdout, stderr, duration = run_command(cmd)

        # 输出结果
        output = stdout + stderr
        if output:
            # 转义特殊字符
            output = output.replace("\\", "\\\\").replace("\r\n", "\n").replace("\r", "\n")
            events.append([current_time, "o", output])
            current_time += duration
        else:
            current_time += 0.5

        # 命令间暂停
        current_time += 0.5

    # 结束提示
    events.append([current_time, "o", "\r\n=== 演示完成 ===\r\n"])
    current_time += 0.1

    # 写入 cast 文件
    with open(OUTPUT_CAST, "w", encoding="utf-8", newline="") as f:
        f.write(json.dumps(header) + "\n")
        for event in events:
            f.write(json.dumps(event) + "\n")

    file_size = os.path.getsize(OUTPUT_CAST)
    print(f"\n完成！")
    print(f"文件: {OUTPUT_CAST}")
    print(f"大小: {file_size} bytes")
    print(f"时长: {current_time:.1f} 秒")
    print(f"事件数: {len(events)}")
    print()
    print("播放测试：")
    print(f"  asciinema play {OUTPUT_CAST}")
    print("或上传到 asciinema.org：")
    print(f"  powersession upload {OUTPUT_CAST}")

if __name__ == "__main__":
    main()
