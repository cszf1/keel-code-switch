#!/usr/bin/env python
"""keelcode 多账号快速登录脚本
用法: python add-account.py [账号名]
"""
import os, sys, json, shutil, subprocess, datetime, urllib.request

CREDS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "credentials")
DEFAULT_CRED = os.path.join(os.path.expanduser("~"), ".keelcode", "credentials.json")
PROXY_URL = "http://localhost:8082"

def main():
    name = sys.argv[1] if len(sys.argv) > 1 else ""
    if not name:
        print("== keelcode 添加账号 ==")
        print("现有账号:")
        if os.path.isdir(CREDS_DIR):
            for f in os.listdir(CREDS_DIR):
                if f.endswith(".json") and not f.startswith("."):
                    print(f"  - {f[:-5]}")
        name = input("\n新账号名 (如 account2/work/main2): ").strip()
    
    if not name:
        print("错误: 账号名不能为空")
        sys.exit(1)
    
    target = os.path.join(CREDS_DIR, f"{name}.json")
    
    if os.path.exists(target):
        confirm = input(f"警告: {name}.json 已存在，覆盖? (y/N): ").strip()
        if confirm != "y":
            sys.exit(0)
    
    os.makedirs(CREDS_DIR, exist_ok=True)
    
    # 登录
    print(f"\n>>> 启动 keelcode login")
    print("浏览器会打开授权页面，完成授权后回到这里\n")
    rc = subprocess.call(["keelcode", "login"])
    
    if rc != 0:
        print(f"keelcode login 失败 (exit {rc})")
        sys.exit(1)
    
    if not os.path.exists(DEFAULT_CRED):
        print(f"错误: {DEFAULT_CRED} 不存在")
        sys.exit(1)
    
    # 读取新凭证信息
    with open(DEFAULT_CRED, "r", encoding="utf-8") as f:
        cred = json.load(f)
    token_preview = (cred.get("accessToken", "") or "")[:16] + "..."
    expires = cred.get("expiresAt", "unknown")
    
    print(f"\n>>> 登录成功")
    print(f"  token: {token_preview}")
    print(f"  expires: {expires}")
    
    # 复制到凭证目录
    shutil.copy2(DEFAULT_CRED, target)
    print(f">>> 已保存到 {target}")
    
    # 热刷新代理
    try:
        urllib.request.urlopen(f"{PROXY_URL}/pool/reload", timeout=2)
        with urllib.request.urlopen(f"{PROXY_URL}/pool/status", timeout=2) as r:
            status = json.loads(r.read())
        print(f">>> 代理已热刷新")
        print(f"  账号总数: {status['total']}, 可用: {status['available']}")
    except Exception:
        print("代理未运行，跳过热刷新")
        print(f"  启动后执行: curl {PROXY_URL}/pool/reload")
    
    # 清理所有备份文件（如果有残留）
    for f in os.listdir(CREDS_DIR):
        if f.startswith(".backup-"):
            os.remove(os.path.join(CREDS_DIR, f))
    
    print(f"\n完成! 账号 {name} 已加入轮换池")


if __name__ == "__main__":
    main()
