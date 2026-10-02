#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gemini-web2api 轻量守护进程（watchdog）

作用：定期探测反代是否还活着，挂了就自动拉起来，并把全过程写进日志。

为什么需要它：反代是后台进程，会**静默消失**（日志干净结束、没有任何报错），
而 DSH 侧只有在真正发请求时才会发现连接失败。有了 watchdog，掉线后几十秒内自愈。

用法：
    python watchdog.py                 # 前台运行（Ctrl+C 停止）
    pythonw watchdog.py                # 后台无窗口运行（推荐，配合 start-watchdog.ps1）
    python watchdog.py --once          # 只检查一次，返回码 0=健康 1=已重启 2=启动失败
    python watchdog.py --status        # 打印最近状态与日志尾部

停机开关：创建 `watchdog.pause` 文件即暂停自动重启（用于你想手动维护时）。
重启风暴保护：滑动窗口内重启次数超上限则停止重启并告警（默认 1 小时 10 次）。
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# Windows 控制台默认是 GBK，直接 print('✓') 会 UnicodeEncodeError。
# 把标准输出/错误切到 UTF-8；失败也不影响后台运行（无控制台时本就没有 stdout）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

DEFAULT_CONFIG = {
    # 探针间隔（秒）
    "interval_sec": 30,
    # 连续失败几次才判定"挂了"（避免偶发抖动误判）
    "fail_threshold": 2,
    # 刚启动后的宽限期：这段时间内即使探测失败也不重启（冷启动较慢）
    "startup_grace_sec": 60,
    # 重启风暴保护：窗口秒数 / 窗口内最大重启次数
    "restart_window_sec": 3600,
    "max_restarts_in_window": 10,
    # 健康检查
    "health_url": "http://127.0.0.1:8081/v1/models",
    "api_key": "sk-gemini",
    "http_timeout_sec": 8,
    # 反代启动方式
    "python": "python",
    "script": "gemini_web2api.py",
    "server_config": "config.json",
    "deps_dir": ".deps",
    # 反代项目根目录；留空则自动探测（见 resolve_server_root）
    "server_root": "",
    # 日志
    "log_file": "watchdog.log",
    "log_max_bytes": 5 * 1024 * 1024,
}


def resolve_server_root(cfg: dict) -> Path:
    """定位反代项目根目录（即含 gemini_web2api.py 的目录）。

    本脚本随 toolkit 分发时会放在 scripts/ 下，而反代项目在别处，
    因此不能假设「脚本所在目录就是反代目录」。查找顺序：
      1) 配置项 server_root
      2) 环境变量 DSH_WEB2API_ROOT
      3) 脚本所在目录及其上一级（standalone：直接放在反代目录里）
      4) 已知的本机默认位置
    """
    def looks_like_root(p: Path) -> bool:
        return (p / cfg["script"]).exists() or (p / cfg["server_config"]).exists()

    cands = []
    if cfg.get("server_root"):
        cands.append(Path(cfg["server_root"]))
    if os.environ.get("DSH_WEB2API_ROOT"):
        cands.append(Path(os.environ["DSH_WEB2API_ROOT"]))
    cands += [ROOT, ROOT.parent]
    cands += [
        Path("D:/CodePackage/DSP/gemini-web2api"),
        Path.home() / "gemini-web2api",
    ]
    for c in cands:
        try:
            if looks_like_root(c):
                return c.resolve()
        except Exception:
            continue
    return ROOT  # 都找不到就用脚本目录，让报错信息直观


CONFIG_FILE = ROOT / "watchdog.config.json"   # 配置只从脚本所在目录读取
# 运行期状态文件在 main() 里按实际反代目录重新赋值（不污染 toolkit 的 scripts/）。
# 这里先放在脚本目录，作为「找不到反代目录」时的兜底。
PAUSE_FILE = ROOT / "watchdog.pause"
STATE_FILE = ROOT / "watchdog.state.json"
LOG_FILE = ROOT / DEFAULT_CONFIG["log_file"]
# 反代项目根目录；在 main() 里由 resolve_server_root() 赋值
SRV = ROOT


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_FILE.exists():
        try:
            cfg.update(json.loads(CONFIG_FILE.read_text(encoding="utf-8")))
        except Exception as e:  # 配置坏了不该让守护进程起不来
            log("配置解析失败，改用默认值: %s" % e)
    return cfg


def log(msg: str, also_print: bool = False) -> None:
    """写一行带时间戳的日志到 watchdog.log（必要时轮转）。"""
    line = "[%s] %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > DEFAULT_CONFIG["log_max_bytes"]:
            old = LOG_FILE.with_suffix(".log.1")
            try:
                if old.exists():
                    old.unlink()
                LOG_FILE.rename(old)
                line = line + "  (日志已轮转)"
            except Exception:
                pass
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    if also_print:
        try:
            print(line, flush=True)
        except Exception:
            pass


def save_state(state: dict) -> None:
    try:
        STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def health_ok(cfg: dict) -> bool:
    """探测健康端点。任何异常都算不健康。"""
    req = urllib.request.Request(
        cfg["health_url"],
        headers={"Authorization": "Bearer " + cfg["api_key"]},
    )
    try:
        with urllib.request.urlopen(req, timeout=cfg["http_timeout_sec"]) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False


def start_server(cfg: dict) -> tuple:
    """拉起反代，返回 (pid, 说明)。

    用 DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP，让反代独立于 watchdog 存活
    （即使 watchdog 退出，反代不被带走）。日志沿用 manage.ps1 的约定：
    server.log（stdout）/ server.log.err（stderr）。
    """
    env = dict(os.environ)
    deps = str(SRV / cfg["deps_dir"])
    env["PYTHONPATH"] = deps + os.pathsep + env.get("PYTHONPATH", "")

    out = open(SRV / "server.log", "ab")
    err = open(SRV / "server.log.err", "ab")
    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "DETACHED_PROCESS", 0x00000008) | \
                getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
    try:
        proc = subprocess.Popen(
            [cfg["python"], str(SRV / cfg["script"]), "--config", str(SRV / cfg["server_config"])],
            cwd=str(SRV), env=env, stdout=out, stderr=err,
            stdin=subprocess.DEVNULL, creationflags=flags, close_fds=True,
        )
        # 与 manage.ps1 的约定保持一致：把真实 pid 写进 server.pid，
        # 否则 watchdog 拉起后 `manage.ps1 status` 会误报"未运行"
        try:
            (SRV / "server.pid").write_text(str(proc.pid), encoding="ascii")
        except Exception:
            pass
        return proc.pid, "已拉起 PID %d" % proc.pid
    except Exception as e:
        return None, "启动失败: %s" % e


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def run_once(cfg: dict, state: dict, verbose: bool) -> int:
    """做一次判定。返回 0=健康 1=已重启 2=启动失败 3=暂停中"""
    if PAUSE_FILE.exists():
        log("检测到 watchdog.pause，暂停自动重启（删除该文件即恢复）", verbose)
        state.update({"lastCheck": now_str(), "lastResult": "paused"})
        save_state(state)
        return 3

    if health_ok(cfg):
        if state.get("lastResult") != "healthy":
            log("反代健康 ✓ (%s)" % cfg["health_url"], verbose)
        state.update({"lastCheck": now_str(), "lastResult": "healthy", "failStreak": 0})
        save_state(state)
        return 0

    fails = int(state.get("failStreak", 0)) + 1
    state.update({"lastCheck": now_str(), "failStreak": fails, "lastResult": "unhealthy"})
    log("探测失败 %d/%d (%s)" % (fails, cfg["fail_threshold"], cfg["health_url"]), verbose)
    if fails < cfg["fail_threshold"]:
        save_state(state)
        return 0

    # 启动风暴保护
    now = time.time()
    history = [t for t in state.get("restarts", []) if now - t < cfg["restart_window_sec"]]
    if len(history) >= cfg["max_restarts_in_window"]:
        log("⚠ 最近 %d 秒内已重启 %d 次，超过上限 %d，停止重启以免风暴。"
            "请检查 server.log.err" % (cfg["restart_window_sec"], len(history),
                                       cfg["max_restarts_in_window"]), True)
        state.update({"restarts": history, "lastResult": "restart-suppressed"})
        save_state(state)
        return 2

    log("判定反代已挂，正在拉起…", True)
    pid, note = start_server(cfg)
    history.append(now)
    state.update({
        "restarts": history,
        "restartCount": int(state.get("restartCount", 0)) + 1,
        "lastRestart": now_str(),
        "lastResult": "restarted",
        "failStreak": 0,
        "pid": pid,
    })
    save_state(state)
    if pid is None:
        log("✗ " + note, True)
        return 2
    log("✓ " + note + "（等待 %ds 宽限期后复查）" % cfg["startup_grace_sec"], True)

    # 宽限期内轮询，尽快确认是否真的起来了
    deadline = time.time() + cfg["startup_grace_sec"]
    while time.time() < deadline:
        time.sleep(5)
        if health_ok(cfg):
            log("反代已恢复 ✓（PID %d）" % pid, True)
            state.update({"lastResult": "recovered", "lastCheck": now_str()})
            save_state(state)
            return 1
    log("⚠ 宽限期结束仍未探通，继续按间隔重试", True)
    return 1


def print_status(cfg: dict) -> int:
    print("=== gemini-web2api watchdog 状态 ===")
    print("  健康检查 : %s" % cfg["health_url"])
    print("  当前状态 : %s" % ("健康 ✓" if health_ok(cfg) else "不可达 ✗"))
    if STATE_FILE.exists():
        try:
            s = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            print("  累计重启 : %s 次" % s.get("restartCount", 0))
            print("  最近检测 : %s (%s)" % (s.get("lastCheck", "-"), s.get("lastResult", "-")))
            print("  最近重启 : %s" % s.get("lastRestart", "无"))
        except Exception as e:
            print("  状态文件读取失败: %s" % e)
    print("  暂停开关 : %s" % ("已暂停（存在 watchdog.pause）" if PAUSE_FILE.exists() else "未暂停"))
    if LOG_FILE.exists():
        print("\n=== 日志尾部（%s，共 %.1f KB）===" % (LOG_FILE.name, LOG_FILE.stat().st_size / 1024))
        lines = LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
        for ln in lines[-15:]:
            print("  " + ln)
    else:
        print("\n  （日志尚未生成）")
    return 0


def main() -> int:
    global SRV, PAUSE_FILE, STATE_FILE, LOG_FILE
    ap = argparse.ArgumentParser(description="gemini-web2api 轻量守护进程")
    ap.add_argument("--once", action="store_true", help="只检查一次后退出")
    ap.add_argument("--status", action="store_true", help="打印状态与日志尾部")
    ap.add_argument("--verbose", action="store_true", help="同时输出到控制台")
    ap.add_argument("--server-root", default="", help="反代项目根目录（默认自动探测）")
    args = ap.parse_args()

    cfg = load_config()
    if args.server_root:
        cfg["server_root"] = args.server_root
    SRV = resolve_server_root(cfg)
    # 运行期状态文件放到反代目录（与 server.log / server.pid 同处），
    # 这样 toolkit 的 scripts/ 目录保持干净
    PAUSE_FILE = SRV / "watchdog.pause"
    STATE_FILE = SRV / "watchdog.state.json"
    LOG_FILE = SRV / cfg["log_file"]

    if args.status:
        print("  反代目录 : %s" % SRV)
        return print_status(cfg)

    # 反代目录找不到时明确报错，而不是稀里糊涂地反复探测失败
    if not (SRV / cfg["script"]).exists():
        log("✗ 找不到反代脚本 %s（已探测的反代目录: %s）。"
            "请用 --server-root 指定，或设 server_root 配置项 / DSH_WEB2API_ROOT 环境变量"
            % (cfg["script"], SRV), True)
        return 2

    state = {}
    if STATE_FILE.exists():
        try:
            state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            state = {}

    if args.once:
        return run_once(cfg, state, True)

    log("watchdog 启动：反代目录 %s；每 %ds 探测一次，连续 %d 次失败即重启，宽限 %ds"
        % (SRV, cfg["interval_sec"], cfg["fail_threshold"], cfg["startup_grace_sec"]), True)
    state["startedAt"] = now_str()
    state["serverRoot"] = str(SRV)
    save_state(state)
    try:
        while True:
            run_once(cfg, state, args.verbose)
            time.sleep(cfg["interval_sec"])
    except KeyboardInterrupt:
        log("watchdog 收到中断，退出（反代不受影响）", True)
        return 0


if __name__ == "__main__":
    sys.exit(main())
