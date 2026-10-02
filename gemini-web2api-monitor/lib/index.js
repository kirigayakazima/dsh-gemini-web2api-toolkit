// @dsh-external/gemini-web2api-monitor — Gemini 反代降级监控（host 半）
// 定时向 gemini.google.com 上游发 StreamGenerate 诊断请求，解析权威字段：
//   slot39 = 上游实际服务的模型内部 ID（权威，防标签造假）
//   slot42 = 上游模型标签（可能造假，仅供参考）
// 判断：
//   slot39 === 期望模型 ID → 正常；slot39 === cf41b0e0dd7d53e5 → 已降级（cookie 过期/被拒）
// 状态写入 json 文件 + webServer API 暴露（/api/gemini-web2api-monitor/status、/probe）

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const name = '@dsh-external/gemini-web2api-monitor'
const inject = ['timer', 'webServer']

const REJECT_ID = 'cf41b0e0dd7d53e5' // 上游"拒绝模型"标记（Issue #82 确认）
const TS_COOKIE = '__Secure-1PSIDTS' // 决定资格的关键轮换 cookie（仅判断用）

function sendJson(res, code, value) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

function apply(ctx, config) {
  const webServer = ctx.get('webServer')
  const dshHome = process.env.DSH_HOME || (process.platform === 'win32'
    ? join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
    : join(process.env.HOME || '', '.dsh'))
  // resolve config defaults (schemastery 已给默认值，这里兜底)
  const cfg = {
    intervalMs: 600000,
    geminiDir: 'D:/CodePackage/DSP/gemini-web2api',
    modelId: '56fdd199312815e2',
    label: '3.8 Flash',
    proxy: 'http://127.0.0.1:7890',
    ...(config || {}),
  }
  const logPath = cfg.logFile || join(dshHome, 'super-injector', 'gemini-web2api-monitor.log')
  const statePath = cfg.stateFile || join(dshHome, 'super-injector', 'gemini-web2api-monitor-state.json')

  const log = (msg) => {
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      appendFileSync(logPath, '[' + new Date().toISOString() + '] ' + msg + '\n')
    } catch { /* silent */ }
  }

  const lastState = {
    ok: null, checkedAt: null, modelLabel: null, slot39: null,
    latencyMs: null, error: null, cookieHasTs: null, expectedId: cfg.modelId,
    degradedSince: null,       // 首次降级时间（null = 从未降级）
    degradedCount: 0,          // 累计降级检测次数
    history: [],               // 最近 50 次检测记录
  }

  const HISTORY_MAX = 50
  let wasOk = null // 上一轮状态，用于检测"刚降级"事件

  const saveState = () => {
    try {
      mkdirSync(dirname(statePath), { recursive: true })
      writeFileSync(statePath, JSON.stringify(lastState, null, 2))
    } catch { /* silent */ }
  }

  // ---------- 读取 gemini-web2api 认证资料 ----------
  function readAuth() {
    try {
      const cfgPath = join(cfg.geminiDir, 'config.json')
      const rawCfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
      const cookieFile = rawCfg.cookie_file || join(cfg.geminiDir, 'cookie.txt')
      const raw = readFileSync(cookieFile, 'utf8').trim()
      let cookie = raw, sapisid = '', xsrf = rawCfg.xsrf_token || '', bl = rawCfg.gemini_bl || ''
      if (raw.startsWith('{')) {
        const d = JSON.parse(raw)
        cookie = d.cookie || ''
        sapisid = d.sapisid || ''
        xsrf = d.xsrf_token || xsrf
        bl = d.gemini_bl || bl
      } else {
        const pairs = {}
        for (const p of cookie.split('; ')) {
          const i = p.indexOf('=')
          if (i > 0) pairs[p.slice(0, i)] = p.slice(i + 1)
        }
        sapisid = pairs['SAPISID'] || ''
      }
      return { cookie, sapisid, xsrf, bl, authUser: rawCfg.auth_user ?? null, hasTs: cookie.includes(TS_COOKIE + '=') }
    } catch (e) {
      return null
    }
  }

  // ---------- 发一次上游诊断请求（委派给 Python probe.py，Node TLS 过不了 Clash） ----------
  async function probeOnce() {
    const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
    const probePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'probe.py')
    try {
      const { stdout } = await execFileAsync(python, [
        probePath,
        '--gemini-dir', cfg.geminiDir,
        '--model-id', cfg.modelId,
        '--proxy', cfg.proxy,
      ], { timeout: 60000, windowsHide: true, encoding: 'utf8' })
      // stdout 最后一行是 JSON（stderr 有 web2api 的 log 输出，忽略）
      const lines = stdout.trim().split('\n')
      const jsonLine = lines.filter((l) => l.trim().startsWith('{')).pop()
      if (!jsonLine) return { ok: null, error: 'probe.py 无 JSON 输出', checkedAt: new Date().toISOString() }
      return JSON.parse(jsonLine)
    } catch (e) {
      return { ok: false, error: '调用 probe.py 失败: ' + String(e).slice(0, 160), checkedAt: new Date().toISOString() }
    }
  }

  async function runProbe(reason) {
    const r = await probeOnce()
    const prev = wasOk
    wasOk = r.ok === true

    // 更新降级统计
    if (r.ok === false) {
      lastState.degradedCount = (lastState.degradedCount || 0) + 1
      if (lastState.degradedSince === null) lastState.degradedSince = r.checkedAt || new Date().toISOString()
    } else if (r.ok === true) {
      lastState.degradedSince = null // 恢复
    }

    // 追加历史（最近 HISTORY_MAX 条）
    const hist = {
      ts: r.checkedAt || new Date().toISOString(),
      ok: r.ok,
      label: r.modelLabel || null,
      slot39: r.slot39 || null,
      lat: r.latencyMs || null,
      reason,
      error: r.error || null,
    }
    lastState.history = [...(lastState.history || []), hist].slice(-HISTORY_MAX)

    Object.assign(lastState, r, { lastReason: reason })
    saveState()
    log(JSON.stringify({ reason, ok: r.ok, slot39: r.slot39, label: r.modelLabel, lat: r.latencyMs, err: r.error }))

    // 刚降级（之前正常/未知 → 现在降级）：发提醒
    const justDegraded = (r.ok === false) && (prev !== false)
    if (justDegraded) {
      const msg = `[gemini-web2api-monitor] 检测到模型降级！期望 ${cfg.label}，实际路由 ${r.modelLabel || '未知'}（${r.slot39 || '?'}）。请刷新 cookie：打开 gemini.google.com → 扩展 Export → 覆盖 gemini-auth.json → 重启反代服务。`
      log('DEGRADED: ' + msg)
      try {
        if (typeof ctx.emit === 'function') ctx.emit('monitor/degraded', { ...hist, message: msg })
      } catch (e) { log('emit degraded failed: ' + String(e)) }
    }
  }

  // ---------- 定时检测 ----------
  let cycles = 0
  const timer = ctx.setInterval(() => {
    cycles += 1
    void runProbe('timer#' + cycles).catch((e) => log('loop error: ' + String(e)))
  }, cfg.intervalMs)
  ctx.effect(() => () => clearInterval(timer))

  // ---------- webServer API ----------
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/gemini-web2api-monitor/status',
      handler: (req, res) => sendJson(res, 200, lastState),
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/gemini-web2api-monitor/probe',
      handler: async (req, res) => {
        await runProbe('manual')
        sendJson(res, 200, lastState)
      },
    }))
  }

  // 启动时立刻探一次
  void runProbe('boot').catch((e) => log('boot probe error: ' + String(e)))
  log('monitor started: every ' + cfg.intervalMs + 'ms, target ' + cfg.label + ' (' + cfg.modelId + ')')
}

export { name, inject, apply }
export default { name, inject, apply }
