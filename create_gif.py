#!/usr/bin/env python3
"""
从手动截图合成 GIF
将 docs/screenshots/ 目录下的 PNG 按文件名排序合成为 demo.gif
"""

import os
import sys
from PIL import Image

SCREENSHOTS_DIR = os.path.join(os.path.dirname(__file__), "docs", "screenshots")
OUTPUT_GIF = os.path.join(os.path.dirname(__file__), "demo.gif")

def main():
    # 获取所有 PNG 文件并排序
    png_files = sorted([
        f for f in os.listdir(SCREENSHOTS_DIR)
        if f.endswith(".png")
    ])
    
    if not png_files:
        print(f"未在 {SCREENSHOTS_DIR} 找到 PNG 文件")
        print()
        print("请先截图保存到该目录：")
        print("  1. 打开终端，运行 opencode plugin @herouucn/opencode-commandcode")
        print("  2. 按 Win+Shift+S 截图，保存为 01-install.png")
        print("  3. 运行 opencode models，截图保存为 02-models.png")
        print("  4. 运行 opencode，输入 /models，截图保存为 03-select.png")
        return
    
    print(f"找到 {len(png_files)} 张截图，合成 GIF...")
    
    images = []
    for filename in png_files:
        filepath = os.path.join(SCREENSHOTS_DIR, filename)
        img = Image.open(filepath)
        images.append(img)
        print(f"  加载: {filename} ({img.width}x{img.height})")
    
    # 统一尺寸（用第一张图的尺寸）
    target_size = images[0].size
    resized = []
    for img in images:
        if img.size != target_size:
            img = img.resize(target_size, Image.Resampling.LANCZOS)
        resized.append(img)
    
    # 保存 GIF
    resized[0].save(
        OUTPUT_GIF,
        save_all=True,
        append_images=resized[1:],
        duration=2000,  # 每张 2 秒
        loop=0
    )
    
    print(f"\n完成！GIF 已保存: {OUTPUT_GIF}")
    print(f"文件大小: {os.path.getsize(OUTPUT_GIF) / 1024:.1f} KB")
    print()
    print("README 嵌入代码：")
    print("![Demo](./demo.gif)")

if __name__ == "__main__":
    main()
