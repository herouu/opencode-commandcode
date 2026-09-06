#!/usr/bin/env python3
"""
录制演示 GIF - 自动截取终端窗口并合成 GIF
"""

import time
import os
import sys
from PIL import Image
import pygetwindow as gw

DEMO_DIR = os.path.join(os.path.dirname(__file__), "docs", "screenshots")
CAST_FILE = os.path.join(os.path.dirname(__file__), "demo.cast")
OUTPUT_GIF = os.path.join(os.path.dirname(__file__), "demo.gif")

# 创建截图目录
os.makedirs(DEMO_DIR, exist_ok=True)

def find_terminal_window():
    """查找终端窗口"""
    windows = gw.getWindowsWithTitle("opencode")
    if not windows:
        windows = gw.getWindowsWithTitle("PowerShell")
    if not windows:
        windows = gw.getWindowsWithTitle("Command Prompt")
    if not windows:
        windows = gw.getWindowsWithTitle("Windows PowerShell")
    return windows[0] if windows else None

def capture_window(window, filepath):
    """截取窗口"""
    try:
        # 确保窗口在前台
        try:
            window.activate()
            time.sleep(0.3)
        except:
            pass
        left, top, width, height = window.left, window.top, window.width, window.height
        import pyautogui
        screenshot = pyautogui.screenshot(region=(left, top, width, height))
        screenshot.save(filepath)
        return True
    except Exception as e:
        print(f"截图失败: {e}")
        return False

def images_to_gif(image_paths, output_path, duration=500):
    """将图片列表合成为 GIF"""
    images = []
    for path in image_paths:
        img = Image.open(path)
        images.append(img)
    
    if not images:
        print("没有截图可合成")
        return
    
    images[0].save(
        output_path,
        save_all=True,
        append_images=images[1:],
        duration=duration,
        loop=0
    )
    print(f"GIF 已保存: {output_path}")

def main():
    print("=== opencode-commandcode 演示录制器 ===")
    print()
    print("请在 5 秒内切换到终端窗口，准备好运行以下命令：")
    print("  1. opencode plugin @herouucn/opencode-commandcode")
    print("  2. opencode models | grep commandcode/ | head -15")
    print()
    input("按 Enter 开始录制（你有 5 秒时间切换到终端）...")
    
    print("录制中...")
    time.sleep(5)
    
    screenshots = []
    max_frames = 30  # 最多截 30 帧
    
    for i in range(max_frames):
        window = find_terminal_window()
        if window:
            filepath = os.path.join(DEMO_DIR, f"frame_{i:03d}.png")
            if capture_window(window, filepath):
                screenshots.append(filepath)
                print(f"  截帧 {i+1}/{max_frames}")
        time.sleep(0.5)  # 每 0.5 秒截一帧
    
    if screenshots:
        images_to_gif(screenshots, OUTPUT_GIF, duration=400)
        print(f"\n完成！共 {len(screenshots)} 帧")
        print(f"GIF 文件: {OUTPUT_GIF}")
        print(f"截图目录: {DEMO_DIR}")
    else:
        print("未捕获到任何截图")

if __name__ == "__main__":
    main()
