/**
 * @dsh-external/gemini-web2api-monitor — client 面板。
 *
 * 三个 UI 入口（对齐 usage-vendor-stats 的模式）：
 *   1. sidebar.footer.action  侧边栏底部入口（在"用量统计"旁边，order 11）
 *   2. shell.overlay          点入口弹出的全屏详细面板
 *   3. conversation.view      会话内快捷状态卡（保留）
 *
 * 数据来自 host 的 webServer API:
 *   GET  /api/gemini-web2api-monitor/status   当前状态 + 历史
 *   POST /api/gemini-web2api-monitor/probe    手动触发检测
 */
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'
import React from 'react'

type ClientContext = {
  slots: SlotsService
}

export const inject = ['slots']

const STATUS_API = '/api/gemini-web2api-monitor/status'
const PROBE_API = '/api/gemini-web2api-monitor/probe'

// ================= 状态读取 hook =================
function useStatus(refreshMs = 15000) {
  const [s, setS] = React.useState<any>({ loading: true })
  const [seq, setSeq] = React.useState(0)
  React.useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await fetch(STATUS_API)
        const j = await r.json()
        if (alive) setS(j)
      } catch (e) {
        if (alive) setS({ ok: null, error: '状态接口不可达: ' + String(e), loading: false })
      } finally {
        if (alive) setS((prev: any) => ({ ...prev, loading: false }))
      }
    }
    void load()
    const iv = setInterval(load, refreshMs)
    return () => { alive = false; clearInterval(iv) }
  }, [seq, refreshMs])
  const trigger = React.useCallback(() => setSeq((x) => x + 1), [])
  return { s, trigger }
}

// ================= 样式（内联 CSS 字符串） =================
const CSS = `
.gwm-entry { display:flex; align-items:center; gap:8px; padding:8px 12px; cursor:pointer; border-radius:6px; }
.gwm-entry:hover { background:rgba(128,128,128,0.12); }
.gwm-entry-ic { font-size:15px; }
.gwm-entry-tx { font-weight:600; font-size:13px; }
.gwm-badge { display:inline-block; min-width:18px; padding:1px 5px; border-radius:8px; font-size:11px; text-align:center; margin-left:4px; }
.gwm-overlay-mask { position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:9999; display:flex; align-items:center; justify-content:center; }
.gwm-overlay-panel { background:var(--dsw-bg-panel,#fff); border-radius:10px; width:min(760px,92vw); max-height:86vh; display:flex; flex-direction:column; box-shadow:0 8px 40px rgba(0,0,0,0.3); }
.gwm-overlay-head { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid rgba(128,128,128,0.2); }
.gwm-overlay-title { margin:0; font-size:16px; font-weight:700; }
.gwm-overlay-close { padding:5px 14px; cursor:pointer; border-radius:6px; border:1px solid rgba(128,128,128,0.3); background:transparent; }
.gwm-overlay-body { padding:16px 18px; overflow:auto; font-family:ui-monospace,Consolas,monospace; font-size:12.5px; line-height:1.8; }
.gwm-ok { color:#16a34a; font-weight:700; }
.gwm-bad { color:#dc2626; font-weight:700; }
.gwm-warn { color:#b45309; font-weight:700; }
.gwm-kv { display:grid; grid-template-columns:150px 1fr; gap:2px 12px; }
.gwm-k { opacity:0.65; }
.gwm-v { font-weight:600; }
.gwm-btn { margin-top:12px; padding:6px 16px; cursor:pointer; border-radius:6px; border:1px solid rgba(128,128,128,0.3); background:transparent; }
.gwm-hist { margin-top:14px; border-top:1px solid rgba(128,128,128,0.2); padding-top:10px; max-height:220px; overflow:auto; }
.gwm-hist-row { display:flex; gap:8px; align-items:center; font-size:11.5px; }
.gwm-hist-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
.gwm-hint { margin-top:12px; padding:8px 10px; border-radius:6px; background:rgba(220,38,38,0.08); border:1px solid rgba(220,38,38,0.25); font-size:12px; }
`

function statusColor(s: any) {
  if (s.ok === true) return { cls: 'gwm-ok', text: '正常' }
  if (s.ok === false) return { cls: 'gwm-bad', text: '已降级' }
  return { cls: 'gwm-warn', text: '未知' }
}

function fmtTime(iso: string | null | undefined) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }) } catch { return iso }
}

function humanLat(ms: number | null | undefined) {
  if (ms == null) return '—'
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'
}

// ================= 核心视图 =================
function StatusPanel(props: { onClose?: () => void }) {
  const { s, trigger } = useStatus(15000)
  const st = statusColor(s)
  const [probeBusy, setProbeBusy] = React.useState(false)

  const doProbe = async () => {
    setProbeBusy(true)
    try { await fetch(PROBE_API, { method: 'POST' }); trigger() } catch {}
    setProbeBusy(false)
  }

  // 降级时浏览器通知（只在状态从正常/未知 → 降级时弹一次）
  const prevOk = React.useRef<boolean | null>(null)
  React.useEffect(() => {
    if (s.ok === false && prevOk.current !== false) {
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification('Gemini 反代已降级', {
            body: '实际路由 ' + (s.modelLabel || '未知') + '，请刷新 cookie',
          })
        }
      } catch { /* ignore */ }
    }
    prevOk.current = s.ok
  }, [s.ok, s.modelLabel])

  const history = (s.history || []).slice().reverse()

  return React.createElement('div', {},
    // 顶部状态条
    React.createElement('div', {},
      React.createElement('span', { className: st.cls }, '● ' + st.text),
      React.createElement('span', { style: { marginLeft: 10, opacity: 0.7 } },
        '目标: ' + (s.expectedId || '?')),
    ),
    // 详细 KV
    React.createElement('div', { className: 'gwm-kv', style: { marginTop: 10 } },
      React.createElement('span', { className: 'gwm-k' }, '当前模型'),
      React.createElement('span', { className: 'gwm-v' }, (s.modelLabel || '—') + ' (' + (s.slot39 || '—') + ')'),
      React.createElement('span', { className: 'gwm-k' }, '最近检测'),
      React.createElement('span', { className: 'gwm-v' }, fmtTime(s.checkedAt)),
      React.createElement('span', { className: 'gwm-k' }, '响应延迟'),
      React.createElement('span', { className: 'gwm-v' }, humanLat(s.latencyMs)),
      React.createElement('span', { className: 'gwm-k' }, 'TS cookie'),
      React.createElement('span', { className: 'gwm-v' }, s.cookieHasTs === true ? '✅ 在' : (s.cookieHasTs === false ? '⚠️ 缺' : '—')),
      React.createElement('span', { className: 'gwm-k' }, '降级计数'),
      React.createElement('span', { className: 'gwm-v' }, String(s.degradedCount ?? 0)),
      React.createElement('span', { className: 'gwm-k' }, '降级始于'),
      React.createElement('span', { className: 'gwm-v' }, fmtTime(s.degradedSince)),
    ),
    // 错误提示
    s.error ? React.createElement('div', { className: 'gwm-hint' }, '⚠️ ' + s.error) : null,
    // 降级处理指引
    s.ok === false ? React.createElement('div', { className: 'gwm-hint' },
      '处理步骤: ① 打开 gemini.google.com（保持登录） ② 点 Gemini Cookie Sync 扩展 → Export ③ 覆盖 gemini-auth.json ④ 重启反代服务') : null,
    // 操作按钮
    React.createElement('div', {},
      React.createElement('button', { className: 'gwm-btn', onClick: doProbe, disabled: probeBusy },
        probeBusy ? '检测中…' : '立即检测'),
      props.onClose ? React.createElement('button', { className: 'gwm-btn', onClick: props.onClose, style: { marginLeft: 8 } }, '关闭') : null,
    ),
    // 检测历史
    React.createElement('div', { className: 'gwm-hist' },
      React.createElement('div', { style: { fontWeight: 700, marginBottom: 4 } }, '检测历史（最近 ' + history.length + ' 条）'),
      history.length === 0
        ? React.createElement('div', { style: { opacity: 0.6 } }, '暂无记录')
        : history.map((h: any, i: number) => React.createElement('div', { className: 'gwm-hist-row', key: i },
            React.createElement('span', {
              className: 'gwm-hist-dot',
              style: { background: h.ok === true ? '#16a34a' : (h.ok === false ? '#dc2626' : '#b45309') },
            }),
            React.createElement('span', { style: { width: 150, flexShrink: 0 } }, fmtTime(h.ts)),
            React.createElement('span', { style: { width: 110, flexShrink: 0 } }, h.label || '—'),
            React.createElement('span', { style: { width: 70, flexShrink: 0, opacity: 0.7 } }, humanLat(h.lat)),
            React.createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              (h.reason || '') + (h.error ? ' ' + h.error : '')),
          )),
    ),
  )
}

// ================= 侧边栏入口 =================
function SidebarEntry() {
  const [open, setOpen] = React.useState(false)
  const { s } = useStatus(15000)
  const st = statusColor(s)
  const badge = s.ok === false ? '!' : (s.ok === true ? '✓' : '?')
  const badgeColor = s.ok === false ? '#dc2626' : (s.ok === true ? '#16a34a' : '#b45309')

  return React.createElement(React.Fragment, {},
    React.createElement('div', {
      className: 'gwm-entry',
      title: 'Gemini 反代降级监控',
      onClick: () => setOpen(!open),
    },
      React.createElement('span', { className: 'gwm-entry-ic' }, '📡'),
      React.createElement('span', { className: 'gwm-entry-tx' }, 'Gemini 监控'),
      React.createElement('span', { className: 'gwm-badge', style: { background: badgeColor, color: '#fff' } }, badge),
    ),
    open ? React.createElement('div', { className: 'gwm-overlay-mask', onClick: () => setOpen(false) },
      React.createElement('div', { className: 'gwm-overlay-panel', onClick: (e) => e.stopPropagation() },
        React.createElement('div', { className: 'gwm-overlay-head' },
          React.createElement('h2', { className: 'gwm-overlay-title' }, '📡 Gemini 反代降级监控'),
          React.createElement('button', { className: 'gwm-overlay-close', onClick: () => setOpen(false) }, '关闭'),
        ),
        React.createElement('div', { className: 'gwm-overlay-body' },
          React.createElement(StatusPanel, { onClose: () => setOpen(false) }),
        ),
      ),
    ) : null,
  )
}

// ================= 注册 =================
export function apply(ctx: ClientContext): void {
  // 注入 CSS
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  // 1. 侧边栏底部入口（用量统计旁边）
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'gemini-web2api-monitor-entry', order: 11, label: () => 'Gemini 监控' },
      () => React.createElement(SidebarEntry),
    ),
  ), '@dsh-external/gemini-web2api-monitor: sidebar')

  // 2. 会话内快捷状态卡
  ctx.effect(() => ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: 'gemini-web2api-monitor-panel',
      label: () => 'Gemini 反代监控',
      component: () => ({
        render() {
          const root = document.createElement('div')
          const host = document.createElement('div')
          root.style.cssText = 'padding:12px;font-family:ui-monospace,Consolas,monospace;font-size:12px'
          root.appendChild(host)
          const refresh = async () => {
            try {
              const r = await fetch(STATUS_API)
              const s = await r.json()
              const st = statusColor(s)
              host.textContent = '📡 ' + st.text + ' — ' + (s.modelLabel || '—') + ' (' + (s.slot39 || '—') + ')' +
                ' ｜ ' + (s.latencyMs != null ? humanLat(s.latencyMs) : '—')
              host.style.color = s.ok === true ? '#16a34a' : (s.ok === false ? '#dc2626' : '#b45309')
            } catch (e) { host.textContent = '监控接口不可达' }
          }
          void refresh()
          setInterval(refresh, 20000)
          return root
        },
      }),
    }),
  ), '@dsh-external/gemini-web2api-monitor: conv')
}

export default { inject, apply }
