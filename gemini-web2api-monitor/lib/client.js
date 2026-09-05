window.__ModuleLoader__.load({
	id: "@dsh-external/gemini-web2api-monitor",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperties(exports, {
			__esModule: { value: true },
			[Symbol.toStringTag]: { value: "Module" }
		});
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		//#region src/client/index.ts
		const inject = ["slots"];
		const STATUS_API = "/api/gemini-web2api-monitor/status";
		const PROBE_API = "/api/gemini-web2api-monitor/probe";
		function useStatus(refreshMs = 15e3) {
			const [s, setS] = react.default.useState({ loading: true });
			const [seq, setSeq] = react.default.useState(0);
			react.default.useEffect(() => {
				let alive = true;
				const load = async () => {
					try {
						const j = await (await fetch(STATUS_API)).json();
						if (alive) setS(j);
					} catch (e) {
						if (alive) setS({
							ok: null,
							error: "状态接口不可达: " + String(e),
							loading: false
						});
					} finally {
						if (alive) setS((prev) => ({
							...prev,
							loading: false
						}));
					}
				};
				load();
				const iv = setInterval(load, refreshMs);
				return () => {
					alive = false;
					clearInterval(iv);
				};
			}, [seq, refreshMs]);
			return {
				s,
				trigger: react.default.useCallback(() => setSeq((x) => x + 1), [])
			};
		}
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
`;
		function statusColor(s) {
			if (s.ok === true) return {
				cls: "gwm-ok",
				text: "正常"
			};
			if (s.ok === false) return {
				cls: "gwm-bad",
				text: "已降级"
			};
			return {
				cls: "gwm-warn",
				text: "未知"
			};
		}
		function fmtTime(iso) {
			if (!iso) return "—";
			try {
				return new Date(iso).toLocaleString("zh-CN", { hour12: false });
			} catch {
				return iso;
			}
		}
		function humanLat(ms) {
			if (ms == null) return "—";
			return ms >= 1e3 ? (ms / 1e3).toFixed(1) + "s" : ms + "ms";
		}
		function StatusPanel(props) {
			const { s, trigger } = useStatus(15e3);
			const st = statusColor(s);
			const [probeBusy, setProbeBusy] = react.default.useState(false);
			const doProbe = async () => {
				setProbeBusy(true);
				try {
					await fetch(PROBE_API, { method: "POST" });
					trigger();
				} catch {}
				setProbeBusy(false);
			};
			const prevOk = react.default.useRef(null);
			react.default.useEffect(() => {
				if (s.ok === false && prevOk.current !== false) try {
					if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification("Gemini 反代已降级", { body: "实际路由 " + (s.modelLabel || "未知") + "，请刷新 cookie" });
				} catch {}
				prevOk.current = s.ok;
			}, [s.ok, s.modelLabel]);
			const history = (s.history || []).slice().reverse();
			return react.default.createElement("div", {}, react.default.createElement("div", {}, react.default.createElement("span", { className: st.cls }, "● " + st.text), react.default.createElement("span", { style: {
				marginLeft: 10,
				opacity: .7
			} }, "目标: " + (s.expectedId || "?"))), react.default.createElement("div", {
				className: "gwm-kv",
				style: { marginTop: 10 }
			}, react.default.createElement("span", { className: "gwm-k" }, "当前模型"), react.default.createElement("span", { className: "gwm-v" }, (s.modelLabel || "—") + " (" + (s.slot39 || "—") + ")"), react.default.createElement("span", { className: "gwm-k" }, "最近检测"), react.default.createElement("span", { className: "gwm-v" }, fmtTime(s.checkedAt)), react.default.createElement("span", { className: "gwm-k" }, "响应延迟"), react.default.createElement("span", { className: "gwm-v" }, humanLat(s.latencyMs)), react.default.createElement("span", { className: "gwm-k" }, "TS cookie"), react.default.createElement("span", { className: "gwm-v" }, s.cookieHasTs === true ? "✅ 在" : s.cookieHasTs === false ? "⚠️ 缺" : "—"), react.default.createElement("span", { className: "gwm-k" }, "降级计数"), react.default.createElement("span", { className: "gwm-v" }, String(s.degradedCount ?? 0)), react.default.createElement("span", { className: "gwm-k" }, "降级始于"), react.default.createElement("span", { className: "gwm-v" }, fmtTime(s.degradedSince))), s.error ? react.default.createElement("div", { className: "gwm-hint" }, "⚠️ " + s.error) : null, s.ok === false ? react.default.createElement("div", { className: "gwm-hint" }, "处理步骤: ① 打开 gemini.google.com（保持登录） ② 点 Gemini Cookie Sync 扩展 → Export ③ 覆盖 gemini-auth.json ④ 重启反代服务") : null, react.default.createElement("div", {}, react.default.createElement("button", {
				className: "gwm-btn",
				onClick: doProbe,
				disabled: probeBusy
			}, probeBusy ? "检测中…" : "立即检测"), props.onClose ? react.default.createElement("button", {
				className: "gwm-btn",
				onClick: props.onClose,
				style: { marginLeft: 8 }
			}, "关闭") : null), react.default.createElement("div", { className: "gwm-hist" }, react.default.createElement("div", { style: {
				fontWeight: 700,
				marginBottom: 4
			} }, "检测历史（最近 " + history.length + " 条）"), history.length === 0 ? react.default.createElement("div", { style: { opacity: .6 } }, "暂无记录") : history.map((h, i) => react.default.createElement("div", {
				className: "gwm-hist-row",
				key: i
			}, react.default.createElement("span", {
				className: "gwm-hist-dot",
				style: { background: h.ok === true ? "#16a34a" : h.ok === false ? "#dc2626" : "#b45309" }
			}), react.default.createElement("span", { style: {
				width: 150,
				flexShrink: 0
			} }, fmtTime(h.ts)), react.default.createElement("span", { style: {
				width: 110,
				flexShrink: 0
			} }, h.label || "—"), react.default.createElement("span", { style: {
				width: 70,
				flexShrink: 0,
				opacity: .7
			} }, humanLat(h.lat)), react.default.createElement("span", { style: {
				flex: 1,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			} }, (h.reason || "") + (h.error ? " " + h.error : ""))))));
		}
		function SidebarEntry() {
			const [open, setOpen] = react.default.useState(false);
			const { s } = useStatus(15e3);
			statusColor(s);
			const badge = s.ok === false ? "!" : s.ok === true ? "✓" : "?";
			const badgeColor = s.ok === false ? "#dc2626" : s.ok === true ? "#16a34a" : "#b45309";
			return react.default.createElement(react.default.Fragment, {}, react.default.createElement("div", {
				className: "gwm-entry",
				title: "Gemini 反代降级监控",
				onClick: () => setOpen(!open)
			}, react.default.createElement("span", { className: "gwm-entry-ic" }, "📡"), react.default.createElement("span", { className: "gwm-entry-tx" }, "Gemini 监控"), react.default.createElement("span", {
				className: "gwm-badge",
				style: {
					background: badgeColor,
					color: "#fff"
				}
			}, badge)), open ? react.default.createElement("div", {
				className: "gwm-overlay-mask",
				onClick: () => setOpen(false)
			}, react.default.createElement("div", {
				className: "gwm-overlay-panel",
				onClick: (e) => e.stopPropagation()
			}, react.default.createElement("div", { className: "gwm-overlay-head" }, react.default.createElement("h2", { className: "gwm-overlay-title" }, "📡 Gemini 反代降级监控"), react.default.createElement("button", {
				className: "gwm-overlay-close",
				onClick: () => setOpen(false)
			}, "关闭")), react.default.createElement("div", { className: "gwm-overlay-body" }, react.default.createElement(StatusPanel, { onClose: () => setOpen(false) })))) : null);
		}
		function apply(ctx) {
			const style = document.createElement("style");
			style.textContent = CSS;
			document.head.appendChild(style);
			ctx.effect(() => ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "gemini-web2api-monitor-entry",
				order: 11,
				label: () => "Gemini 监控"
			}, () => react.default.createElement(SidebarEntry))), "@dsh-external/gemini-web2api-monitor: sidebar");
			ctx.effect(() => ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "gemini-web2api-monitor-panel",
				label: () => "Gemini 反代监控",
				component: () => ({ render() {
					const root = document.createElement("div");
					const host = document.createElement("div");
					root.style.cssText = "padding:12px;font-family:ui-monospace,Consolas,monospace;font-size:12px";
					root.appendChild(host);
					const refresh = async () => {
						try {
							const s = await (await fetch(STATUS_API)).json();
							const st = statusColor(s);
							host.textContent = "📡 " + st.text + " — " + (s.modelLabel || "—") + " (" + (s.slot39 || "—") + ") ｜ " + (s.latencyMs != null ? humanLat(s.latencyMs) : "—");
							host.style.color = s.ok === true ? "#16a34a" : s.ok === false ? "#dc2626" : "#b45309";
						} catch (e) {
							host.textContent = "监控接口不可达";
						}
					};
					refresh();
					setInterval(refresh, 2e4);
					return root;
				} })
			})), "@dsh-external/gemini-web2api-monitor: conv");
		}
		var client_default = {
			inject,
			apply
		};
		//#endregion
		exports.apply = apply;
		exports.default = client_default;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map