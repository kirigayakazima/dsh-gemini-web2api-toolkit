# -*- coding: utf-8 -*-
"""gemini-web2api 认证文件预检（导出 cookie 后先跑这个，再重启反代）

为什么需要它：
    浏览器扩展导出的 gemini-auth.json 有时会**缺字段**（例如漏掉 SID / APISID / HSID），
    反代不会报"cookie 不完整"，只会静默降级成 Flash-Lite，或者上游直接返回
    HTTP 400 Bad Request —— 表现为「反代明明在跑，但模型不对/一直失败」。
    本脚本在重启之前就把问题指出来。

用法（默认读 D:\\CodePackage\\DSP\\gemini-web2api\\config.json 里的 cookie_file）：
    python verify_auth.py
    python verify_auth.py --gemini-dir D:/CodePackage/DSP/gemini-web2api
    python verify_auth.py --probe            # 额外发一次真实上游探针请求
    python verify_auth.py --probe --model-id cf41b0e0dd7d53e5

安全：本脚本只打印字段名与长度，**绝不打印任何 cookie 值**。
"""

import argparse
import json
import sys
from pathlib import Path

# Google 网页会话认证必需字段（缺任何一个都可能 400 或静默降级）
REQUIRED = [
    ("SID", "身份主 cookie，缺失 = 未登录"),
    ("HSID", "身份主 cookie，缺失 = 未登录"),
    ("SSID", "身份主 cookie，缺失 = 未登录"),
    ("APISID", "身份主 cookie，缺失 = 未登录"),
    ("SAPISID", "SAPISIDHASH 鉴权来源，必需"),
    ("__Secure-1PSID", "会话 cookie，必需"),
    ("__Secure-3PSID", "会话 cookie，必需"),
]
# 时间轮换 cookie：它的过期正是「静默降级到 Flash-Lite」的根因
ROTATING = [("__Secure-1PSIDTS", "TS 轮换 cookie，过期会导致静默降级")]

RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RESET = "\033[0m"
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    # Windows 终端默认不解析 ANSI，这里退化为纯文本标记
    RED = GREEN = YELLOW = RESET = ""


def parse_cookie_pairs(cookie: str):
    pairs = {}
    for item in cookie.split(";"):
        item = item.strip()
        if "=" in item:
            k, v = item.split("=", 1)
            pairs[k.strip()] = v.strip()
    return pairs


def _locate_probe():
    """定位 probe.py：本脚本有两份（仓库 scripts/ 与插件安装目录），都要能找到它。"""
    here = Path(__file__).resolve().parent
    for cand in (here.parent / "gemini-web2api-monitor" / "probe.py",   # scripts/ 版
                 here / "probe.py"):                                    # 插件目录版
        if cand.exists():
            return cand
    return None


def load_auth(gemini_dir: Path):
    """返回 (cookie 文本, 附加字段 dict, cookie 文件路径)。"""
    cfg_path = gemini_dir / "config.json"
    cfg = {}
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"{YELLOW}[警告]{RESET} config.json 解析失败: {e}")

    cookie_file = Path(cfg.get("cookie_file") or (gemini_dir / "cookie.txt"))
    if not cookie_file.is_absolute():
        cookie_file = gemini_dir / cookie_file

    if not cookie_file.exists():
        print(f"{RED}[失败]{RESET} 找不到认证文件: {cookie_file}")
        return None, None, cookie_file

    raw = cookie_file.read_text(encoding="utf-8", errors="replace").strip()
    extra = {"xsrf_token": cfg.get("xsrf_token"), "auth_user": cfg.get("auth_user"),
             "gemini_bl": cfg.get("gemini_bl")}

    if raw.startswith("{"):
        try:
            data = json.loads(raw)
        except Exception as e:
            print(f"{RED}[失败]{RESET} {cookie_file.name} 不是合法 JSON: {e}")
            return None, None, cookie_file
        cookie = data.get("cookie", "") or ""
        extra.update({k: data.get(k, extra.get(k))
                      for k in ("xsrf_token", "auth_user", "gemini_bl")})
        extra["sapisid_field"] = data.get("sapisid")
    else:
        cookie = raw
        extra["sapisid_field"] = None
    return cookie, extra, cookie_file


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gemini-dir", default=r"D:/CodePackage/DSP/gemini-web2api")
    ap.add_argument("--model-id", default="56fdd199312815e2",
                    help="期望的上游模型内部 ID（3.8 Flash = 56fdd199312815e2）")
    ap.add_argument("--proxy", default=None, help="HTTP 代理，如 http://127.0.0.1:7890")
    ap.add_argument("--probe", action="store_true", help="额外发一次真实上游探针请求")
    args = ap.parse_args()

    gemini_dir = Path(args.gemini_dir)
    print("=" * 72)
    print("  gemini-web2api 认证文件预检")
    print(f"  目录: {gemini_dir}")
    print("=" * 72)

    cookie, extra, cookie_file = load_auth(gemini_dir)
    if cookie is None:
        return 2

    print(f"认证文件: {cookie_file}")
    import datetime
    mtime = datetime.datetime.fromtimestamp(cookie_file.stat().st_mtime)
    print(f"文件修改时间: {mtime:%Y-%m-%d %H:%M:%S}")
    print(f"cookie 字符数: {len(cookie)}  字段数: {len(parse_cookie_pairs(cookie))}\n")

    pairs = parse_cookie_pairs(cookie)
    missing_required = []
    print("【必需字段】")
    for name, why in REQUIRED:
        v = pairs.get(name)
        if v:
            print(f"  {GREEN}OK  {RESET}{name:20} 长度 {len(v):>4}   {why}")
        else:
            missing_required.append(name)
            print(f"  {RED}缺失{RESET}{name:20} {'':>9}   {why}")

    print("\n【时间轮换字段（失效会导致静默降级）】")
    missing_rotating = []
    for name, why in ROTATING:
        v = pairs.get(name)
        if v:
            print(f"  {GREEN}OK  {RESET}{name:20} 长度 {len(v):>4}   {why}")
        else:
            missing_rotating.append(name)
            print(f"  {RED}缺失{RESET}{name:20} {'':>9}   {why}")

    print("\n【附加字段】")
    sapisid = extra.get("sapisid_field") or pairs.get("SAPISID") or ""
    print(f"  sapisid     : {'非空，长度 ' + str(len(sapisid)) if sapisid else RED + '空' + RESET}")
    xsrf = extra.get("xsrf_token")
    print(f"  xsrf_token  : {'非空，长度 ' + str(len(xsrf)) if xsrf else '空（反代可自动抓取，通常无碍）'}")
    print(f"  auth_user   : {extra.get('auth_user')!r}")
    print(f"  gemini_bl   : {extra.get('gemini_bl')!r}")

    status = 0
    print("\n" + "=" * 72)
    if missing_required:
        status = 1
        print(f"{RED}[结论] cookie 不完整，缺: {', '.join(missing_required)}{RESET}")
        print("       这样导出出去，反代要么上游 400，要么静默降级到 Flash-Lite。")
        print("       请重新导出：Chrome 打开 gemini.google.com（确认已登录）")
        print("       → 点扩展 Inspect session → Export → 覆盖 gemini-auth.json")
    elif missing_rotating:
        status = 1
        print(f"{YELLOW}[结论] 必需字段齐全，但缺 {', '.join(missing_rotating)}{RESET}")
        print("       缺 TS 字段时通常仍能对话，但会被静默降级到 Flash-Lite。")
    else:
        print(f"{GREEN}[结论] 字段齐全，可以重启反代。{RESET}")

    need_probe = args.probe or (status != 0)
    if need_probe:
        print("\n【上游真实探针】")
        if not args.probe:
            print("  （字段有问题，自动追加一次真实探针以确证）")
        probe_path = _locate_probe()
        if probe_path is None:
            print(f"  {YELLOW}跳过：找不到 probe.py（在 ../gemini-web2api-monitor/ 与本目录都未找到）{RESET}")
        else:
            # probe.py 是模块级直接执行的脚本（不是函数库），因此用子进程调用
            cmd = [sys.executable, str(probe_path),
                   "--gemini-dir", str(gemini_dir), "--model-id", args.model_id]
            if args.proxy:
                cmd += ["--proxy", args.proxy]
            try:
                import subprocess
                proc = subprocess.run(cmd, capture_output=True, text=True,
                                      encoding="utf-8", errors="replace", timeout=180)
                line = ""
                for ln in (proc.stdout or "").splitlines():
                    ln = ln.strip()
                    if ln.startswith("{"):
                        line = ln
                if line:
                    try:
                        result = json.loads(line)
                    except Exception:
                        result = {"raw": line}
                    print(f"  探针结果: {json.dumps(result, ensure_ascii=False)}")
                    if isinstance(result, dict) and result.get("ok") is False:
                        status = 1
                else:
                    print(f"  {YELLOW}探针无输出{RESET} stderr: {(proc.stderr or '')[:200]}")
            except Exception as e:
                print(f"  {YELLOW}探针执行异常（不影响字段结论）: {e}{RESET}")

    print("=" * 72)
    return status


if __name__ == "__main__":
    sys.exit(main())
