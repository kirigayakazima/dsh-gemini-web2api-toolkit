# dsh-gemini-web2api-toolkit

> 在 DeepSeek Harness (DSH) 中使用 Google Gemini **网页版**（gemini.google.com）的完整工具集：
> 反代服务补丁 + 降级监控插件 + Windows 管理脚本 + 中文文档。
>
> 让香港/地区受限的 **Google AI Pro 账号**通过网页通道在 DSH 中真正用上 Pro/最新模型，
> 并自动监控"TS cookie 过期导致的静默降级"。

---

## 目录结构

```
dsh-gemini-web2api-toolkit/
├── patches/
│   ├── gemini_web2api.py.patch  # 反代服务补丁（模型路由 header / auth.json / xsrf /
│   │                            #   DSH 兼容：SSE 流式正确终止 / 工具真流式 / 工具描述精简）
│   └── apply-patch.ps1          # 一键应用/回滚补丁
├── scripts/
│   ├── manage.ps1               # Windows 服务管理（start/stop/status/test/log）
│   ├── watchdog.py / .ps1       # 轻量守护：定期探测，挂了自动拉起，全程写日志
│   ├── verify_auth.py           # 认证文件预检（导出 cookie 后先跑这个）
│   └── start.bat                # 一键前台启动
├── docs/
│   └── 接入指南.md              # 完整中文接入教程（含 cookie 导出）
└── README.md
```

> 监控插件已独立成库：
> [`dsh-gemini-web2api-monitor`](https://github.com/kirigayakazima/dsh-gemini-web2api-monitor)
> （原先放在本仓库的 `gemini-web2api-monitor/` 子目录，已迁出以避免两份代码分叉）。

### 守护进程 watchdog

反代是后台进程，实测会**静默消失**（`server.log.err` 干净结束、无任何报错），
而 DSH 侧只有真正发请求时才发现连不上。`watchdog.py` 负责兜底：

```powershell
powershell -File watchdog.ps1 start    # 启动守护（后台无窗口）
powershell -File watchdog.ps1 status   # 状态 + 日志尾部
powershell -File watchdog.ps1 stop     # 停止守护（反代本体不受影响）
powershell -File watchdog.ps1 pause    # 暂停自动重启（手动维护时用）
powershell -File watchdog.ps1 resume   # 恢复自动重启
powershell -File watchdog.ps1 once     # 只检查一次
```

默认策略：每 **30s** 探测 `GET /v1/models`；**连续 2 次**失败才判定挂了（避免抖动误判）；
拉起后给 **60s** 宽限期；**1 小时内最多重启 10 次**（防重启风暴，超限告警并停止）。

**反代目录自动探测**（脚本可放在任意位置）：依次尝试 `-ServerRoot` 参数 →
环境变量 `DSH_WEB2API_ROOT` → 脚本所在目录及其上一级 → `D:/CodePackage/DSP/gemini-web2api`。
日志与状态（`watchdog.log` / `watchdog.state.json` / `watchdog.pid`）都写在**反代目录**里，
与 `server.log` 同处，不会污染本 `scripts/` 目录。

它拉起反代时用 `DETACHED_PROCESS`，**反代独立存活**（watchdog 退出也不会带走它），
并把真实 PID 写进 `server.pid`，与 `manage.ps1` 的约定保持一致。

---

## 架构

```
DSH ──(OpenAI API)──> http://127.0.0.1:8081/v1 ──> gemini-web2api（反代）──> gemini.google.com（经日本代理）
                              ▲
                              └── dsh-gemini-web2api-monitor 插件每 N 分钟探测上游，
                                  读权威字段 slot39 判断是否被静默降级
```

## 组成

| 组件 | 来源 | 说明 |
|---|---|---|
| `gemini-web2api`（反代服务） | [上游仓库](https://github.com/Sophomoresty/gemini-web2api) clone + 本仓库 patch | 网页版 → OpenAI 兼容 API |
| `gemini-cookie-sync-extension` | 上游自带（PR #60） | 浏览器扩展，一键导出完整 cookie 含 httpOnly 的 TS 字段 |
| `dsh-gemini-web2api-monitor` | [独立仓库](https://github.com/kirigayakazima/dsh-gemini-web2api-monitor) | DSH 插件：降级监控 + 侧边栏 UI |
| `scripts/verify_auth.py` | **本仓库原创** | 导出 cookie 后的认证预检（字段完整性 + 上游探针） |
| `patches/` | **本仓库原创** | 上游缺失的多处修复（模型路由 / DSH 兼容 / 流式 / XSRF） |

## DSH 兼容性（重要）

本仓库的补丁专门修复了 **DSH（DeepSeek Harness）等严格 OpenAI 客户端** 接入时的关键问题：

| 现象 | 根因 | 修复 |
|---|---|---|
| 回复收到但一直显示 "Deep diving" / 思考中，直到 300s 超时 | HTTP/1.1 SSE 无 `Content-Length` 也无 `chunked`，严格客户端等不到响应结束边界（连接保持不关） | `protocol_version = "HTTP/1.0"`：响应后连接关闭（EOF），标准 SSE 终止信号 |
| 带工具请求非常慢 / 客户端 idle timeout | 携 tools 时退化为阻塞的全量生成后单 chunk 返回 | 工具请求也真流式：文本边到边发，末尾再发解析后的 `tool_calls` + `finish_reason: tool_calls` |
| 43 个工具让 Google 处理数分钟 | 工具描述过长约 32KB | 描述精简到 ~150 字符（参数 schema 完整保留）→ ~12KB，秒级响应 |
| server.log 一直为空 | 日志只写 stderr | 同时落盘 server.log（实时刷新） |

已实测：DSH + OpenAI SDK 完整收到 content → `finish_reason` → `[DONE]`，turn 正常结束，43 工具请求约 9s 完成。

## 快速开始

### 1. 反代服务

```bash
git clone https://github.com/Sophomoresty/gemini-web2api.git
cd gemini-web2api
pip install httpx

# 应用本仓库补丁（3.8-flash / model header / xsrf / auth.json 支持）
powershell -File ../dsh-gemini-web2api-toolkit/patches/apply-patch.ps1 -Target .
```

### 2. 导出 cookie（一次性）

用上游自带的 `gemini-cookie-sync-extension`：
1. Chrome 打开 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选该扩展目录
2. 打开 gemini.google.com 登录 → 点扩展 → Inspect session → Export
3. 把 `gemini-auth.json` 放到反代项目目录

### 2.5 预检认证文件（**强烈建议，10 秒**）

导出后、重启反代前先跑这个。反代对"cookie 不完整"不会明确报错，只会**静默降级成
Flash-Lite**，或者上游直接返回 `HTTP 400 Bad Request` —— 表现为"反代明明在跑，
模型就是不对 / 一直失败"，很难查。

```powershell
python scripts/verify_auth.py
# 或指定目录 / 强制跑一次上游真实探针
python scripts/verify_auth.py --gemini-dir D:/CodePackage/DSP/gemini-web2api --probe
```

逐项检查认证字段是否齐全（`SID / HSID / SSID / APISID / SAPISID / __Secure-1PSID /
__Secure-3PSID / __Secure-1PSIDTS`），以及 `xsrf_token`、`gemini_bl` 有没有取到
（这两项为空时反代会退回内置默认值，build id 过期就可能 400）；字段有问题时会
自动追加一次真实上游探针确证。**只打印字段名与长度，绝不打印任何 cookie 值。**

> 实测踩坑：扩展有时只导出 `SSID / SAPISID / __Secure-1PSID / __Secure-3PSID`，
> 缺 `SID / HSID / APISID`，且 `xsrf_token` 与 `gemini_bl` 均为空 —— 这份导出必然 400。
> 另一个坑：页面上的 build id（`cfb2h`）会随 Google 发版变化，`config.json` 里的
> `gemini_bl` 放旧了也可能触发 400，可从 `https://gemini.google.com/app` 页面源码里
> 搜 `boq_assistant-bard-web-server_` 取当前值。

### 3. 配置并启动

`config.json` 里把 `cookie_file` 指向 `gemini-auth.json`，然后：

```powershell
powershell -File scripts/manage.ps1 start
# Base URL: http://localhost:8081/v1  API Key: sk-gemini
```

### 4. 安装监控插件（DSH）

监控插件是**独立仓库**：
[`dsh-gemini-web2api-monitor`](https://github.com/kirigayakazima/dsh-gemini-web2api-monitor)。
安装方式见该仓库 README（把仓库目录 junction 到 profile 的
`node_modules/@dsh-external/` 下，并把 bundle 名加进 `dsh.profile.bundles`）。

> ⚠️ 该插件曾因导出 `Config = null` 触发 DSH 启动致命错误
> （`Cannot use 'in' operator to search for 'toJSON' in null` → 欢迎窗口
> `Web RPC failed` → 恢复流程禁用全部插件并重置 profile 配置）。
> 该问题已在 `0.1.0` 修复；从旧版本升级时请确认 `lib/index.js` 里
> 是 `export { name, inject, apply }`（**不要**有 `Config`）。

---

## 补丁内容（为什么需要）

上游 [Issue #82](https://github.com/Sophomoresty/gemini-web2api/issues/82) 确认：
Google 改版后 `slot79` 载荷字段不再选择模型，模型选择已迁移到
`x-goog-ext-525001261-jspb` 请求头（内部 model ID 选择器）。
同时 TS 轮换 cookie（`__Secure-1PSIDTS`）过期会导致**静默降级**到 Flash-Lite。

本仓库补丁提供：
1. `gemini-3.8-flash` 模型条目（上游 PR #91 尚未合并时的可用方案）
2. `x-goog-ext-525001261-jspb` model header（Issue #82 核心修复）
3. `load_cookie()` 支持 `gemini-auth.json` 自动注入 xsrf/gemini_bl/auth_user
4. `fetch_xsrf_token()` 自动抓取新版 xsrf（FdrFJe，替代消失的 SNlM0e）

> 注意：补丁基于上游 commit `2bb988b`（feat(models): 新增 gemini-3.7-flash）。上游合并新
> PR 后可能冲突，apply-patch 脚本会先 `--check` 检测。

---

## 安全

- ⚠️ `gemini-auth.json` / `cookie.txt` 是**真实 Google 登录会话**，切勿提交到任何仓库。
- 本仓库 `.gitignore` 已强制排除敏感文件。
- cookie 过期后（几小时~1 天），重导一次：浏览器扩展 Export → 覆盖文件 → 重启服务。

## 许可

- 反代服务本体 / 扩展：上游 MIT 许可
- 本仓库原创部分（monitor 插件 / patches / scripts / docs）：MIT
