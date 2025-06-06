#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Discord JSON文件重命名工具
将长文件名格式：类脑ΟΔΥΣΣΕΙΑ - 🎃︱档案馆-混沌版 - 标题[ID].json
重命名为简洁格式：[ID].json
"""

import os
import re
import json
import shutil
from pathlib import Path


def extract_thread_id(filename):
    """
    从文件名中提取帖子ID
    匹配模式：[数字].json
    """
    pattern = r'\[(\d+)\]\.json$'
    match = re.search(pattern, filename)
    if match:
        return match.group(1)
    return None


def validate_json_file(file_path):
    """
    验证JSON文件是否有效且包含必要字段
    """
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        # 检查必要字段
        if 'thread_info' not in data:
            return False, "缺少thread_info字段"
        
        if 'thread_id' not in data['thread_info']:
            return False, "thread_info中缺少thread_id字段"
        
        if 'messages' not in data:
            return False, "缺少messages字段"
        
        return True, "文件有效"
        
    except json.JSONDecodeError as e:
        return False, f"JSON解析错误: {e}"
    except Exception as e:
        return False, f"读取文件错误: {e}"


def rename_json_files(directory_path=None, dry_run=True):
    """
    重命名JSON文件
    
    Args:
        directory_path: JSON文件目录路径，默认为data/rebuild/json
        dry_run: 是否为演习模式（不实际重命名）
    """
    if directory_path is None:
        directory_path = Path("data/rebuild/json")
    else:
        directory_path = Path(directory_path)
    
    if not directory_path.exists():
        print(f"❌ 目录不存在: {directory_path}")
        return
    
    print(f"📂 扫描目录: {directory_path.absolute()}")
    print(f"🔄 模式: {'演习模式 (不实际修改)' if dry_run else '实际执行模式'}")
    print("-" * 60)
    
    # 获取所有JSON文件
    json_files = list(directory_path.glob("*.json"))
    
    if not json_files:
        print("❌ 未找到JSON文件")
        return
    
    print(f"📝 找到 {len(json_files)} 个JSON文件")
    print()
    
    success_count = 0
    skip_count = 0
    error_count = 0
    
    for i, file_path in enumerate(json_files, 1):
        print(f"[{i}/{len(json_files)}] 处理文件:")
        print(f"  📄 原文件名: {file_path.name}")
        
        # 检查文件名长度
        if len(str(file_path)) > 250:
            print(f"  ⚠️  路径长度: {len(str(file_path))} 字符（超长）")
        
        # 提取帖子ID
        thread_id = extract_thread_id(file_path.name)
        if not thread_id:
            print(f"  ❌ 无法提取帖子ID，跳过")
            skip_count += 1
            print()
            continue
        
        print(f"  🆔 提取到ID: {thread_id}")
        
        # 生成新文件名
        new_filename = f"[{thread_id}].json"
        new_file_path = file_path.parent / new_filename
        
        print(f"  📝 新文件名: {new_filename}")
        
        # 检查是否已经是目标格式
        if file_path.name == new_filename:
            print(f"  ✅ 已经是目标格式，跳过")
            skip_count += 1
            print()
            continue
        
        # 检查目标文件是否已存在
        if new_file_path.exists():
            print(f"  ⚠️  目标文件已存在，跳过")
            skip_count += 1
            print()
            continue
        
        # 验证JSON文件
        try:
            is_valid, message = validate_json_file(file_path)
            if not is_valid:
                print(f"  ❌ JSON验证失败: {message}")
                error_count += 1
                print()
                continue
        except Exception as e:
            print(f"  ❌ 验证文件时出错: {e}")
            error_count += 1
            print()
            continue
        
        # 执行重命名
        if not dry_run:
            try:
                file_path.rename(new_file_path)
                print(f"  ✅ 重命名成功")
                success_count += 1
            except Exception as e:
                print(f"  ❌ 重命名失败: {e}")
                error_count += 1
        else:
            print(f"  🔄 演习模式：将重命名为 {new_filename}")
            success_count += 1
        
        print()
    
    # 打印总结
    print("=" * 60)
    print("📊 处理结果汇总:")
    print(f"  ✅ 成功处理: {success_count} 个文件")
    print(f"  ⏭️  跳过文件: {skip_count} 个文件")
    print(f"  ❌ 处理失败: {error_count} 个文件")
    print(f"  📂 总文件数: {len(json_files)} 个文件")
    
    if dry_run and success_count > 0:
        print()
        print("💡 演习模式完成！如果结果看起来没问题，请使用以下命令实际执行:")
        print("   python rename_json_files.py --execute")


def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='Discord JSON文件重命名工具')
    parser.add_argument('--directory', '-d', 
                       help='指定JSON文件目录路径 (默认: data/rebuild/json)')
    parser.add_argument('--execute', action='store_true',
                       help='实际执行重命名（默认为演习模式）')
    
    args = parser.parse_args()
    
    print("🔧 Discord JSON文件重命名工具")
    print("=" * 60)
    
    # 执行重命名
    rename_json_files(
        directory_path=args.directory,
        dry_run=not args.execute
    )
    
    if not args.execute:
        print("\n💡 提示: 这是演习模式，如需实际执行请添加 --execute 参数")


if __name__ == "__main__":
    main() 