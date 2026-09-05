/**
 * @dsh-external/gemini-web2api-monitor — Gemini 反代降级监控（hybrid 形态）。
 *
 * 核心：确定性检测。定时向 gemini.google.com 上游发一个 StreamGenerate 诊断请求，
 * 解析响应里的权威字段：
 *   - slot39 = 上游实际服务的模型内部 ID（权威，防标签造假）
 *   - slot42 = 上游模型标签（可能造假，仅供参考）
 * 判断当前反代是否被静默降级：
 *   - slot39 === 期望模型 ID（如 56fdd199312815e2 = 3.8 Flash）→ ✅ 正常
 *   - slot39 === cf41b0e0dd7d53e5（上游拒绝标记）→ ❌ 已降级（cookie 过期/被拒）
 * 状态写入 json 文件 + webServer API 暴露，供 UI 面板/其他工具读取。
 */
import type { Context } from 'cordis'
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import z from 'schemastery'

type AppContext = Context & {
  setInterval(fn: () => void, ms: number): any
}

export const name = "@dsh-external/gemini-web2api-monitor"
export const inject = ['timer', 'webServer']

export interface Config {
  intervalMs: number
  geminiDir: string
  modelId: string
  label: string
  stateFile: string
  logFile: string
  proxy: string
}

export const Config = z.object({
  intervalMs: z.number().min(60000).default(600000),      // 默认 10 分钟一轮（太频繁会触发上游限流）
  geminiDir: z.string().default('D:/CodePackage/DSP/gemini-web2api'),
  modelId: z.string().default('56fdd199312815e2'),         // 3.8 Flash 内部 ID
  label: z.string().default('3.8 Flash'),
  stateFile: z.string().default(''),
  logFile: z.string().default(''),
  proxy: z.string().default('http://127.0.0.1:7890'),
})

// 上游"拒绝模型"标记（Issue #82 确认）：被拒时 slot39 = 这个 ID，标签显示 Flash-Lite
const REJECT_ID = 'cf41b0e0dd7d53e5'
const AUTH_USER_FIELD = '__Secure-1PSIDTS' // 决定 Pro/资格的关键轮换 cookie（仅用于判断）

export function apply(ctx: AppContext, config: Config): void {
  const SHORT = "gemini-web2api-monitor"
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logFile = config.logFile || join(dshHome, 'super-injector', SHORT + '.log')
  const stateFile = config.stateFile || join(dshHome, 'super-injector', SHORT + '-state.json')

  const log = (msg: string): void => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + msg + '\n')
    } catch { /* 日志失败静默 */ }
  }

  // ═══ 状态持久化 ═══
  let lastState: Record<string, any> = {
    ok: null, checkedAt: null, modelLabel: null, slot39: null,
    cookieAgeSec: null, latencyMs: null, error: null, cookieHasTs: null,
  }

  function saveState(): void {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, JSON.stringify(lastState, null, 2))
    } catch { /* 状态写入失败静默 */ }
  }

  // ═══ 读取 gemini-web2api 认证资料 ═══
  function readAuth(): { cookie: string; sapisid: string; xsrf: string; bl: string; authUser: string | null } | null {
    try {
      const cfg = JSON.parse(readFileSync(join(config.geminiDir, 'config.json'), 'utf8'))
      const cookieFile = cfg.cookie_file || join(config.geminiDir, 'cookie.txt')
      const raw = readFileSync(cookieFile, 'utf8').trim()
      let cookie = raw, sapisid = '', xsrf = cfg.xsrf_token || '', bl = cfg.gemini_bl || ''
      if (raw.startsWith('{')) {
        const d = JSON.parse(raw)
        cookie = d.cookie || ''
        sapisid = d.sapisid || ''
        xsrf = d.xsrf_token || xsrf
        bl = d.gemini_bl || bl
      } else {
        const pairs: Record<string, string> = {}
        for (const p of cookie.split('; ')) {
          const i = p.indexOf('=')
          if (i > 0) pairs[p.slice(0, i)] = p.slice(i + 1)
        }
        sapisid = pairs['SAPISID'] || ''
      }
      const hasTs = cookie.includes(AUTH_USER_FIELD + '=')
      return { cookie, sapisid, xsrf, bl, authUser: cfg.auth_user ?? null, hasTs }
    } catch (e) {
      return null
    }
  }

  // ═══ SAPISID hash（与 web2api 一致）═══
  function makeSapisidHash(sapisid: string): string {
    const ts = Math.floor(Date.now() / 1000)
    const crypto = require('node:crypto')
    const h = crypto.createHash('sha1').update(`${ts} ${sapisid} https://gemini.google.com`).digest('hex')
    return `SAPISIDHASH ${ts}_${h}`
  }

  // ═══ 发一次上游诊断请求，解析 slot39/slot42 ═══
  async function probeOnce(): Promise<Record<string, any>> {
    const auth = readAuth()
    if (!auth || !auth.cookie) {
      return { ok: null, error: '读取 gemini 认证文件失败（config.json / gemini-auth.json 缺失）' }
    }
    const crypto = require('node:crypto')
    const inner = new Array(80).fill(null)
    inner[0] = ['ping', 0, null, null, null, null, 0]
    inner[1] = ['en']
    inner[2] = ['', '', '', null, null, null, null, null, null, '']
    inner[6] = [0]; inner[7] = 1; inner[10] = 1; inner[11] = 0
    inner[17] = [[4]]
    inner[18] = 0; inner[27] = 1; inner[30] = [4]
    // 临时对话标志（temporary_chats 对齐 web2api 配置）
    inner[41] = [1]; inner[45] = 1
    inner[53] = 0; inner[59] = crypto.randomUUID(); inner[61] = []; inner[68] = 1
    inner[79] = 1 // FAST

    const params = new URLSearchParams({ 'f.req': JSON.stringify([null, JSON.stringify(inner)]) })
    if (auth.xsrf) params.set('at', auth.xsrf)
    const reqid = Math.floor(Date.now() / 1000) % 1000000
    const prefix = auth.authUser ? `/u/${auth.authUser}` : ''
    const url = `https://gemini.google.com${prefix}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${auth.bl}&hl=en&_reqid=${reqid}&rt=c`

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://gemini.google.com',
      'Referer': `https://gemini.google.com${prefix}/app`,
      'X-Same-Domain': '1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Cookie': auth.cookie,
    }
    if (auth.sapisid) headers['Authorization'] = makeSapisidHash(auth.sapisid)
    // 模型选择 header（权威路由）
    headers['x-goog-ext-525001261-jspb'] = JSON.stringify(
      [1, null, null, null, config.modelId, null, null, 0,
       [4, 5, 6, 8, 4, 5, 6, 8], null, null, 2,
       null, null, 1, 0, crypto.randomUUID()])

    const t0 = Date.now()
    try {
      // 通过 HTTP(S) 代理访问（默认走本机 Clash）
      const https = require('node:https')
      const http = require('node:http')
      const { URL } = require('node:url')
      const u = new URL(url)
      const proxyUrl = new URL(config.proxy)
      const isHttps = proxyUrl.protocol === 'https:'
      const mod = isHttps ? https : http
      const body = params.toString()
      const resp = await new Promise<{ status: number; data: string }>((resolve, reject) => {
        const req = mod.request({
          host: proxyUrl.hostname,
          port: proxyUrl.port,
          method: 'POST',
          path: url,
          headers: { ...headers, 'Host': u.host, 'Content-Length': Buffer.byteLength(body) },
        }, (res: any) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode || 0, data: Buffer.concat(chunks).toString('utf8') }))
        })
        req.on('error', reject)
        req.write(body)
        req.end()
      })
      const latencyMs = Date.now() - t0
      if (resp.status !== 200) {
        return { ok: false, error: `上游 HTTP ${resp.status}`, latencyMs, checkedAt: new Date().toISOString() }
      }
      // 解析 slot39 / slot42
      let slot39: string | null = null
      let slot42: string | null = null
      for (const line of resp.data.split('\n')) {
        if (!line.includes('"wrb.fr"')) continue
        try {
          const arr = JSON.parse(line)
          const inner2 = JSON.parse(arr[0][2])
          if (Array.isArray(inner2)) {
            if (inner2.length > 42 && inner2[42]) slot42 = String(inner2[42])
            if (inner2.length > 39 && inner2[39]) slot39 = String(inner2[39])
          }
        } catch { /* 跳过不可解析帧 */ }
      }
      const ok = slot39 === config.modelId
      return {
        ok,
        checkedAt: new Date().toISOString(),
        slot39,
        modelLabel: slot42,
        expectedId: config.modelId,
        latencyMs,
        error: !slot39 ? '未读到 slot39（可能被拒绝或响应异常）' : (ok ? null : `实际路由 ${slot42 || '未知'}（${slot39}），已降级`),
        cookieHasTs: (auth as any).hasTs,
      }
    } catch (e) {
      return { ok: false, error: '请求上游失败: ' + String(e).slice(0, 120), latencyMs: Date.now() - t0, checkedAt: new Date().toISOString() }
    }
  }

  async function runProbe(reason: string): Promise<void> {
    const r = await probeOnce()
    lastState = { ...lastState, ...r, lastReason: reason }
    saveState()
    log(JSON.stringify({ reason, ok: r.ok, slot39: r.slot39, label: r.modelLabel, lat: r.latencyMs, err: r.error }))
  }

  // ═══ 定时检测 ═══
  let cycles = 0
  ctx.setInterval(() => {
    void (async () => {
      cycles += 1
      await runProbe('timer#' + cycles)
    })().catch((e) => log('loop error: ' + String(e)))
  }, config.intervalMs)

  // ═══ webServer API：状态查询 + 手动触发 ═══
  const webServer = ctx.get('webServer')
  ctx.effect(() => webServer.register({
    path: '/api/gemini-web2api-monitor/status',
    async handler(req: any, res: any) {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(lastState))
    },
  }))
  ctx.effect(() => webServer.register({
    path: '/api/gemini-web2api-monitor/probe',
    async handler(req: any, res: any) {
      await runProbe('manual')
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(lastState))
    },
  }))

  // 启动时立刻探一次（不等第一个 timer）
  void runProbe('boot')

  ctx.logger?.info?.('[' + "@dsh-external/gemini-web2api-monitor" + '] 监控已启动：每 ' + config.intervalMs + 'ms 检测一次，目标模型 ' + config.label + ' (' + config.modelId + ')')
}
