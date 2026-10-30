// dsh-balance-panel — browser half（这里是生效的那一份：宿主按 package.json 的
// exports["./client"] 直接读这个文件；源文件另存在 E:\tools\dsh-plugins\dsh-balance-panel\lib\client.js，
// 改完源文件要同步过来，或直接改这一份）。
//
// 侧边栏底部一张常驻卡片（`sidebar.footer.action` 槽位）：
//   · 余额常显（¥ 大字号 + 今日花费 / 正在跑的会话数）
//   · 峰谷档位 + 距离下次切换（转峰价 / 转谷价）的秒级倒计时
//   · 鼠标悬浮 → 浮层：当前 1M token 价 + 正在跑的会话（标题 + 已跑多久）
//   · 点击 → 浮层：每个会话花了多少钱 / 多少 token / 跑了多久，按花费降序
// 数据来自宿主路由 GET /api/balance-panel（见 lib/index.js），15 秒心跳；
// 倒计时用本地时钟每秒走，不必等心跳。样式只用 `--dsw-*` 主题变量（带兜底色）。
window.__ModuleLoader__.load({
	id: "dsh-balance-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const { useState, useEffect, useRef, useCallback } = react;
		const h = react.createElement;

		const ROUTE = "/api/balance-panel";
		// 让她念一句话的那条路由（宿主侧再转给本机 TTS shim）
		const SAY_ROUTE = "/api/balance-panel/say";
		// 合成好的那句存在磁盘上，按这个地址直接取（宿主没有就现合成一次）
		const SAY_FILE_ROUTE = "/api/balance-panel/sayfile";
		// 解压按钮的台词：三句轮着来
		const SAY_LINES = ["烦不烦", "你很无聊吗", "变态"];
		// 设置页里价目表的字段名（单位：元 / 百万 token）
		const PRICE_LABEL = { input: "未命中", cacheRead: "缓存命中", output: "输出", offDiscount: "谷价折扣" };
		const POLL_MS = 15 * 1000;
		// 彩蛋：45 秒里按够这么多下就重开（嫌多嫌少就改这两个数）
		const EGG_PRESS_COUNT = 50;
		const EGG_WINDOW_MS = 45 * 1000;
		// 一次「看得见」几行：其余靠滚动看，不是丢掉。
		const MAX_ROWS = 4;      // 明细浮层上面那块：一屏 4 行
		const MAX_BOARD = 3;     // 今日排行榜：一屏 3 行
		const DETAIL_ROW_PX = 46; // 明细行高（定死，滚动区高度才好算）
		const BOARD_ROW_PX = 26;  // 排行榜行高

		const COLOR_TEXT = "var(--dsw-color-text-primary, #e8e8e8)";
		const COLOR_DIM = "var(--dsw-color-text-secondary, #9b9b9b)";
		const COLOR_FAINT = "var(--dsw-color-text-tertiary, #6f6f6f)";
		const COLOR_LINE = "var(--dsw-color-border-subtle, rgba(128,128,128,0.28))";
		const COLOR_PANEL = "var(--dsw-color-bg-elevated, #1c1c1f)";
		const COLOR_ACCENT = "var(--dsw-color-accent, #5b9dff)";
		const COLOR_OK = "var(--dsw-color-success, #3fbf7f)";
		const COLOR_WARN = "var(--dsw-color-warning, #e0a33a)";
		// 卡片数字用的橙色（不跟主题走，保证一眼认得出）
		const COLOR_ORANGE = "#ff9d3f";
		// 明细行悬停底色（半透明，深色浅色主题都能用）
		const COLOR_HOVER = "rgba(127,127,127,0.16)";

		function money(value) {
			if (value == null || !Number.isFinite(value)) return "—";
			if (value > 0 && value < 0.01) return "<0.01";
			if (value >= 1000) return value.toFixed(0);
			return value.toFixed(2);
		}

		function tokens(value) {
			if (!Number.isFinite(value) || value <= 0) return "0";
			if (value >= 1e6) return (value / 1e6).toFixed(value >= 1e7 ? 0 : 1) + "M";
			if (value >= 1e3) return (value / 1e3).toFixed(value >= 1e4 ? 0 : 1) + "k";
			return String(Math.round(value));
		}

		function duration(ms) {
			if (!Number.isFinite(ms) || ms <= 0) return "0s";
			const total = Math.round(ms / 1000);
			const hours = Math.floor(total / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			const seconds = total % 60;
			if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
			if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
			return `${seconds}s`;
		}

		function clock(ts) {
			if (!Number.isFinite(ts) || ts <= 0) return "—";
			const d = new Date(ts);
			const pad = (n) => String(n).padStart(2, "0");
			return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		}

		function countdown(ms) {
			if (!Number.isFinite(ms) || ms < 0) return "—";
			const total = Math.floor(ms / 1000);
			const days = Math.floor(total / 86400);
			const hours = Math.floor((total % 86400) / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			const seconds = total % 60;
			const pad = (n) => String(n).padStart(2, "0");
			if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}`;
			if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
			return `${pad(minutes)}:${pad(seconds)}`;
		}

		function currencyMark(code) {
			return code === "USD" ? "$" : "¥";
		}

		function rate(value) {
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			if (n === 0) return "0";
			if (n >= 10) return n.toFixed(n % 1 === 0 ? 0 : 1);
			return n.toFixed(2);
		}

		/** 每秒走一格：本地时钟驱动倒计时，不必等 15 秒心跳。 */
		function useNow(active) {
			const [now, setNow] = useState(() => Date.now());
			useEffect(() => {
				if (!active) return undefined;
				setNow(Date.now());
				const timer = setInterval(() => setNow(Date.now()), 1000);
				return () => clearInterval(timer);
			}, [active]);
			return now;
		}

		/** 把宿主给的 pricing 收拾成能直接画的字符串。 */
		function pricingOf(snapshot) {
			const p = snapshot && snapshot.pricing;
			if (!p || !p.perMillion) return null;
			const mark = currencyMark(p.currency);
			const tierLabel = p.tier === "peak" ? "峰价" : "谷价";
			return {
				tierLabel,
				tierColor: p.tier === "peak" ? COLOR_WARN : COLOR_OK,
				nextLabel: p.nextSwitchTo === "peak" ? "转峰价" : "转谷价",
				nextSwitchAt: Number(p.nextSwitchAt) || 0,
				model: p.model || "",
				blended: `${mark}${rate(p.perMillion.blended)}`,
				input: `${mark}${rate(p.perMillion.input)}`,
				output: `${mark}${rate(p.perMillion.output)}`,
				cacheRead: p.perMillion.cacheRead > 0 ? `${mark}${rate(p.perMillion.cacheRead)}` : "",
				blendRatio: p.blendRatio || "3:1",
				windows: p.windows || "峰价 = 工作日 09:00–12:00、14:00–18:00；其余时间谷价（北京时间）",
			};
		}

		/** 卡片第三行的窄条：`峰价 · 转谷价 2:14:33`。 */
		function PricingTick({ pricing, now }) {
			if (!pricing) return null;
			const left = pricing.nextSwitchAt ? pricing.nextSwitchAt - now : null;
			return h("div", {
				style: {
					display: "flex",
					gap: "5px",
					justifyContent: "center",
					fontSize: "10px",
					lineHeight: 1.3,
					fontVariantNumeric: "tabular-nums",
					whiteSpace: "nowrap",
					overflow: "hidden",
				},
				title: `${pricing.tierLabel}（${pricing.windows}）· 1M token 入 ${pricing.input} / 出 ${pricing.output} / 混合 ${pricing.blendRatio} 约 ${pricing.blended} · ${pricing.nextLabel} ${countdown(left)}`,
			},
				h("span", { style: { color: pricing.tierColor, fontWeight: 600 } }, pricing.tierLabel),
				h("span", { style: { color: COLOR_FAINT } }, "·"),
				h("span", { style: { color: COLOR_DIM } }, `${pricing.nextLabel} ${countdown(left)}`),
			);
		}

		/** 浮层里的价目块：当前档位、1M token 三种口径、切换倒计时。 */
		function PricingBlock({ pricing, now }) {
			if (!pricing) return null;
			const left = pricing.nextSwitchAt ? pricing.nextSwitchAt - now : null;
			const rowStyle = { display: "flex", justifyContent: "space-between", gap: "10px", padding: "1px 0" };
			return h("div", null,
				h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" } },
					h("span", { style: { fontWeight: 600 } },
						h("span", { style: { color: pricing.tierColor } }, pricing.tierLabel),
						h("span", { style: { color: COLOR_DIM, fontWeight: 400 } }, ` · ${pricing.model || "—"}`)),
					h("span", { style: { color: COLOR_ACCENT, fontVariantNumeric: "tabular-nums" } },
						`${pricing.nextLabel} ${countdown(left)}`)),
				h("div", { style: { color: COLOR_DIM, marginTop: "2px" } }, "每 100 万 token"),
				h("div", { style: { ...rowStyle, fontVariantNumeric: "tabular-nums" } },
					h("span", { style: { color: COLOR_FAINT } }, "输入"), h("span", null, pricing.input)),
				h("div", { style: { ...rowStyle, fontVariantNumeric: "tabular-nums" } },
					h("span", { style: { color: COLOR_FAINT } }, "输出"), h("span", null, pricing.output)),
				pricing.cacheRead
					? h("div", { style: { ...rowStyle, fontVariantNumeric: "tabular-nums" } },
						h("span", { style: { color: COLOR_FAINT } }, "缓存命中"), h("span", null, pricing.cacheRead))
					: null,
				h("div", { style: { ...rowStyle, fontVariantNumeric: "tabular-nums" } },
					h("span", { style: { color: COLOR_FAINT } }, `混合 ${pricing.blendRatio}`),
					h("span", { style: { fontWeight: 600 } }, pricing.blended)),
				h("div", { style: { color: COLOR_FAINT, fontSize: "11px", marginTop: "2px" } }, pricing.windows),
			);
		}

		function workspaceName(cwd) {
			if (!cwd) return "";
			const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
			return parts.length > 0 ? parts[parts.length - 1] : "";
		}

		function usePanelData() {
			const [snapshot, setSnapshot] = useState(null);
			const [failed, setFailed] = useState(false);
			const alive = useRef(true);

			const load = useCallback(async () => {
				try {
					const res = await fetch(ROUTE, { headers: { accept: "application/json" } });
					if (!res.ok) throw new Error(String(res.status));
					const body = await res.json();
					if (!alive.current) return null;
					if (body && body.ok) {
						setSnapshot(body);
						setFailed(false);
						return body;
					}
					setFailed(true);
					return null;
				} catch {
					if (alive.current) setFailed(true);
					return null;
				}
			}, []);

			useEffect(() => {
				alive.current = true;
				let timer = null;
				let stopped = false;
				let quick = 0;
				const tick = async () => {
					const body = await load();
					if (stopped) return;
					const totals = (body && body.totals) || {};
					// 没数据 / 会话还没读完 / 余额还没拿到，都算「没齐」
					const incomplete = body === null
						|| totals.partial === true
						|| !body.balance
						|| body.balance.ok === false;
					// 刚开机那几秒每秒补一次（最多 20 次），齐了就回到 15 秒心跳，
					// 这样不用靠用户狂点卡片来「催」出正确金额。
					const wait = incomplete && quick < 20 ? 1200 : POLL_MS;
					quick = incomplete ? quick + 1 : 0;
					timer = setTimeout(tick, wait);
				};
				tick();
				return () => {
					stopped = true;
					alive.current = false;
					if (timer) clearTimeout(timer);
				};
			}, [load]);

			return { snapshot, failed, reload: load };
		}

		function useAnchor() {
			const ref = useRef(null);
			const [rect, setRect] = useState(null);
			const measure = useCallback(() => {
				if (ref.current && typeof ref.current.getBoundingClientRect === "function") {
					setRect(ref.current.getBoundingClientRect());
				}
			}, []);
			return { ref, rect, measure };
		}

		const overlayStyle = (rect, wide) => ({
			position: "fixed",
			left: "8px",
			right: "8px",
			bottom: rect ? `${Math.max(8, window.innerHeight - rect.top + 8)}px` : "60px",
			zIndex: 60,
			maxWidth: wide ? "420px" : "360px",
			background: COLOR_PANEL,
			color: COLOR_TEXT,
			border: `1px solid ${COLOR_LINE}`,
			borderRadius: "10px",
			boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
			padding: "10px 12px",
			fontSize: "12px",
			lineHeight: 1.5,
		});

		function RunningTip({ anchorRect, snapshot, wide }) {
			const running = (snapshot && snapshot.running) || [];
			const now = useNow(true);
			const pricing = pricingOf(snapshot);
			return h("div", { style: overlayStyle(anchorRect, wide), role: "tooltip" },
				pricing
					? h("div", {
						style: { paddingBottom: "6px", marginBottom: "6px", borderBottom: `1px solid ${COLOR_LINE}` },
					}, h(PricingBlock, { pricing, now }))
					: null,
				h("div", { style: { color: COLOR_DIM, marginBottom: "6px" } },
					running.length === 0 ? "现在没有会话在跑" : `${running.length} 个会话在跑`),
				running.slice(0, 8).map((s) =>
					h("div", {
						key: s.id,
						style: { display: "flex", gap: "8px", justifyContent: "space-between", padding: "2px 0" },
					},
						h("span", { style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 } },
							h("span", {
								style: {
									width: "6px", height: "6px", borderRadius: "50%",
									background: COLOR_OK, flex: "0 0 auto",
									animation: "dsh-balance-pulse 1.4s ease-in-out infinite",
								},
							}),
							h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, s.title)),
						h("span", { style: { color: COLOR_DIM, flex: "0 0 auto" } },
							duration(Math.max(0, ((snapshot && snapshot.updatedAt) || Date.now()) - (s.lastAt || 0))))),
				),
			);
		}

		// 点一行就跳回那条会话：ctx.uiWorkspace.openSession(id) 是 DSH 官方的「切到某个会话」入口
		// （宿主文档里写作 openSession(target: SessionTarget)：同步替换 mainView，主区域回到 Conversation）。
		// 注意不要写进 inject 数组：万一某个环境没有这个服务，整张卡片会连加载都失败；
		// 改成 apply 里用 ctx.inject(["uiWorkspace"], …) 等它就绪，拿不到就只让点击失效。
		let workspaceNav = null;
		// 顺手留着 sessions / workspaces 两个快照服务：用来判断某条会话「能不能被选中」
		let clientServices = {};

		// 三条路依次试：inject 预热拿到的、ctx.get 现取的、直接挂在 ctx 上的属性。
		// （宿主自己的代码就是 `const workspaceNavigation = ctx.get("uiWorkspace")`，所以 ctx.get 最可靠）
		function resolveWorkspace(ctx) {
			const tries = [
				() => workspaceNav,
				() => (ctx && typeof ctx.get === "function" ? ctx.get("uiWorkspace") : null),
				() => (ctx ? ctx.uiWorkspace : null),
			];
			for (const read of tries) {
				try {
					const found = read();
					if (found && typeof found.openSession === "function") return found;
				} catch (error) {
					// 换下一条路
				}
			}
			return null;
		}

		// 退路：在侧栏 DOM 里按标题找到那一行，点它（跟用户手点完全一样）
		// 注意要跳过自己的浮层——卡片就挂在侧栏里，不排除的话会点到自己的行上
		function domJump(title) {
			if (!title) return false;
			try {
				const roots = document.querySelectorAll('[data-slot*="sidebar"], div[class*="sidebarCol"]');
				const items = [];
				for (const root of roots) {
					for (const item of root.querySelectorAll('button, [role="button"], a, [role="treeitem"], li')) {
						if (item.closest("[data-dbp-overlay]")) continue;
						items.push(item);
					}
				}
				let fuzzy = null;
				for (const item of items) {
					const text = (item.textContent || "").trim();
					if (!text) continue;
					if (text === title) {
						item.click();
						return true;
					}
					// 原生行常常是「标题 + 时间」，所以退化成长度最短的包含匹配
					if (!fuzzy && text.includes(title)) fuzzy = item;
				}
				if (fuzzy) {
					fuzzy.click();
					return true;
				}
			} catch (error) {
				// 找不到就算了
			}
			return false;
		}

		// 宿主点会话行之前会先查这件事（asar:512313 `sessionLinkState`）：
		// 工作区注册表 error / 会话已归档 / 会话不在列表里 —— 这三种情况 openSession 不会有反应。
		// 照着抄一遍，好在点不动的时候说清原因，而不是静默失败。
		function pickService(ctx, name) {
			try {
				if (clientServices && clientServices[name]) return clientServices[name];
				if (ctx && typeof ctx.get === "function") return ctx.get(name);
				return ctx ? ctx[name] : undefined;
			} catch (error) {
				return undefined;
			}
		}

		function linkState(ctx, id) {
			const sessions = pickService(ctx, "sessions");
			const workspaces = pickService(ctx, "workspaces");
			if (!sessions || !workspaces) return "unknown";
			try {
				const sessionList = sessions.list.getSnapshot();
				const workspaceList = workspaces.list.getSnapshot();
				if (workspaceList.state === "error") return "unavailable";
				if (Array.isArray(workspaceList.archivedSessionIds) && workspaceList.archivedSessionIds.includes(id)) return "archived";
				if (!Array.isArray(sessionList.ids) || !sessionList.ids.includes(id)) return "not-listed";
				return "available";
			} catch (error) {
				return "unknown";
			}
		}

		const LINK_STATE_TEXT = {
			unavailable: "工作区注册表不可用",
			archived: "这条会话已归档",
			"not-listed": "会话列表里还没有它",
			unknown: "读不到会话列表",
		};

		function openSessionTo(ctx, id, title) {
			const target = String(id);
			const nav = resolveWorkspace(ctx);
			const state = linkState(ctx, target);
			// 官方判断说「不能直接切」时，先按原生那一行点一下（等于用户手点，跨工作区也管用）
			if (state !== "available" && domJump(title)) return { ok: true, via: "dom" };
			if (nav) {
				try {
					nav.openSession(target);
					return { ok: true, via: "uiWorkspace" };
				} catch (error) {
					const message = String((error && error.message) || error);
					console.warn("[dsh-balance-panel] openSession 抛错：", message);
					if (domJump(title)) return { ok: true, via: "dom", note: message };
					return { ok: false, via: "uiWorkspace", error: message };
				}
			}
			if (domJump(title)) return { ok: true, via: "dom" };
			if (!nav) return { ok: false, via: "none", error: "拿不到 uiWorkspace，侧栏也没找到同名行" };
			return { ok: false, via: "uiWorkspace", error: `${LINK_STATE_TEXT[state] || state}（${target}）` };
		}

		function CostPanel({ anchorRect, snapshot, wide, failed, onRefresh, ctx }) {
			const sessions = (snapshot && snapshot.sessions) || [];
			const totals = (snapshot && snapshot.totals) || {};
			const balance = snapshot && snapshot.balance;
			// 上面这块是「最近用过的会话」：按最后运行时间从新到旧排（宿主按花费排过序，这里重排）。
			const rows = sessions.slice().sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
			const now = useNow(true);
			const pricing = pricingOf(snapshot);
			// 点了会话行之后的回执，直接显示在浮层底部——不用开控制台也能知道成没成
			const [jumpMsg, setJumpMsg] = useState("");

			const jumpTo = (s) => {
				const result = openSessionTo(ctx, s.id, s.title);
				console.log("[dsh-balance-panel] 点击会话行", s.id, s.title, result);
				setJumpMsg(result.ok ? `已跳转（${result.via}）` : `跳转失败：${result.error}`);
			};

			// 浮层开着的时候每 4 秒自己刷一次：排行榜上的金额是「实时」变的，不用手点刷新
			useEffect(() => {
				const timer = setInterval(() => { onRefresh(); }, 4000);
				return () => clearInterval(timer);
			}, [onRefresh]);

			const head = h("div", {
				style: {
					display: "flex", justifyContent: "space-between", alignItems: "baseline",
					gap: "8px", paddingBottom: "6px", marginBottom: "6px",
					borderBottom: `1px solid ${COLOR_LINE}`,
				},
			},
				h("div", { style: { fontWeight: 600, fontSize: "13px" } },
					balance && balance.ok
						? `余额 ${currencyMark(balance.currency)}${money(balance.total)}`
						: "余额读取失败"),
				h("div", { style: { color: COLOR_DIM } },
					`${sessions.length} 条会话 · ${totals.running || 0} 在跑`),
			);

			const body = rows.length === 0
				? h("div", { style: { color: COLOR_DIM, padding: "8px 0" } },
					failed ? "读不到会话数据（宿主路由没有响应）" : "还没有会话消耗")
				: h("div", {
					style: { maxHeight: `calc(${DETAIL_ROW_PX}px * ${MAX_ROWS})`, overflowY: "auto" },
					title: `最近用过的会话 · 一屏 ${MAX_ROWS} 行，往下滚看全部`,
				},
					rows.map((s) =>
						h("div", {
							key: s.id,
							style: {
								display: "grid",
								gridTemplateColumns: "1fr auto",
								gap: "2px 10px",
								padding: "5px 4px",
								margin: "0 -4px",
								minHeight: `${DETAIL_ROW_PX}px`,
								boxSizing: "border-box",
								borderRadius: "4px",
								cursor: "pointer",
							},
							title: `${s.title}\n点击跳到这条会话`,
							onMouseEnter: (event) => { event.currentTarget.style.background = COLOR_HOVER; },
							onMouseLeave: (event) => { event.currentTarget.style.background = "transparent"; },
							onClick: (event) => {
								event.stopPropagation();
								jumpTo(s);
							},
						},
							h("div", { style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 } },
								s.running
									? h("span", {
										style: { width: "6px", height: "6px", borderRadius: "50%", background: COLOR_OK, flex: "0 0 auto" },
									})
									: h("span", { style: { width: "6px", flex: "0 0 auto" } }),
								// 会话名前面挂上它所在的工作区，同名会话一眼能分清
								h("span", {
									style: {
										flex: "0 0 auto", maxWidth: "45%", overflow: "hidden",
										textOverflow: "ellipsis", whiteSpace: "nowrap",
										fontSize: "10px", fontWeight: 700, color: COLOR_DIM,
										background: "rgba(127,127,127,0.16)", borderRadius: "3px",
										padding: "0 4px",
									},
									title: s.cwd || workspaceName(s.cwd),
								}, workspaceName(s.cwd)),
								h("span", {
									style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
									title: s.title,
								}, s.title)),
							h("div", {
								style: {
									textAlign: "right",
									fontVariantNumeric: "tabular-nums",
									whiteSpace: "nowrap",
								},
							},
								h("div", {
									style: { color: s.cost ? COLOR_TEXT : COLOR_FAINT, fontWeight: 600 },
								}, s.cost == null ? "—" : `${currencyMark(s.currency)}${money(s.cost)}`),
								h("div", {
									style: { color: COLOR_DIM, fontSize: "11px", fontWeight: 700 },
								}, s.todayCost == null && !s.todayTokens
									? "今日 —"
									: `今日 ${currencyMark(s.currency)}${money(s.todayCost || 0)}`)),
							h("div", { style: { color: COLOR_FAINT, fontSize: "11px" } },
								[
									s.model || "—",
									`${tokens(s.tokens.total)} tok`,
									`入${tokens(s.tokens.uncachedInput)}·缓${tokens(s.tokens.cacheRead)}·出${tokens(s.tokens.output)}`,
									s.todayTokens ? `今日 ${tokens(s.todayTokens)} tok` : "",
								].filter(Boolean).join(" · ")),
							h("div", {
								style: {
									color: COLOR_FAINT, fontSize: "11px",
									fontVariantNumeric: "tabular-nums", textAlign: "right", whiteSpace: "nowrap",
								},
								title: `最后运行 ${clock(s.lastAt)}（累计 ${duration(s.workMs)}）`,
							}, `最后 ${clock(s.lastAt)} · ${duration(s.workMs)}`),
						),
					),
				);

			// 今日排行榜：按「今天花的钱」排，谁今天烧得多谁在上面。
			// 一屏看得见 MAX_BOARD 行，其余往下滚（不截断）。条形长度相对第一名画，数字每 4 秒刷新。
			const board = sessions
				.filter((s) => (s.todayCost || 0) > 0 || (s.todayTokens || 0) > 0)
				.slice()
				.sort((a, b) => (b.todayCost || 0) - (a.todayCost || 0) || (b.todayTokens || 0) - (a.todayTokens || 0));
			const boardTop = board.length ? (board[0].todayCost || 0) : 0;
			const boardTotal = board.length;

			const leaderboard = h("div", {
				style: { paddingTop: "6px", marginTop: "6px", borderTop: `1px solid ${COLOR_LINE}` },
			},
				h("div", {
					style: {
						display: "flex", justifyContent: "space-between", gap: "8px",
						color: COLOR_DIM, fontSize: "11px", fontWeight: 700, marginBottom: "2px",
					},
				},
					h("span", null, "今日排行榜"),
					h("span", null, board.length
						? `${boardTotal} 条 · 一屏 ${MAX_BOARD} 行 · 实时`
						: "今天还没花"),
				),
				board.length === 0
					? h("div", { style: { color: COLOR_FAINT, fontSize: "11px", padding: "4px 0" } },
						"今天还没有消耗，随便动一条会话它就上来了")
					: h("div", {
						style: { maxHeight: `calc(${BOARD_ROW_PX}px * ${MAX_BOARD})`, overflowY: "auto" },
						title: `今日排行榜 · 一屏 ${MAX_BOARD} 行，往下滚看全部`,
					}, board.map((s, index) => {
						const value = s.todayCost || 0;
						const width = boardTop > 0 ? Math.max(4, Math.round((value / boardTop) * 100)) : 4;
						const mark = currencyMark(s.currency);
						return h("div", {
							key: s.id,
							style: {
								position: "relative",
								display: "grid",
								gridTemplateColumns: "16px minmax(0, 1fr) auto",
								alignItems: "center",
								gap: "6px",
								padding: "4px",
								margin: "0 -4px",
								minHeight: `${BOARD_ROW_PX}px`,
								boxSizing: "border-box",
								borderRadius: "4px",
								cursor: "pointer",
							},
							title: `${s.title}\n今日 ${mark}${money(value)} · ${tokens(s.todayTokens || 0)} tok\n点击跳到这条会话`,
							onMouseEnter: (event) => { event.currentTarget.style.background = COLOR_HOVER; },
							onMouseLeave: (event) => { event.currentTarget.style.background = "transparent"; },
							onClick: (event) => {
								event.stopPropagation();
								jumpTo(s);
							},
						},
							h("span", {
								style: {
									position: "absolute", left: 0, top: 0, bottom: 0, width: `${width}%`,
									background: index === 0 ? "rgba(255,157,63,0.20)" : "rgba(127,127,127,0.13)",
									borderRadius: "4px", pointerEvents: "none",
								},
							}),
							h("span", {
								style: {
									position: "relative", textAlign: "center", fontSize: "11px", fontWeight: 700,
									color: index === 0 ? COLOR_ORANGE : COLOR_DIM,
								},
							}, String(index + 1)),
							h("span", {
								style: {
									position: "relative", fontSize: "12px", minWidth: 0,
									overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
								},
								title: s.title,
							}, s.title),
							h("span", {
								style: {
									position: "relative", textAlign: "right", whiteSpace: "nowrap",
									fontVariantNumeric: "tabular-nums",
								},
							},
								h("span", {
									style: { fontWeight: 700, color: value > 0 ? COLOR_TEXT : COLOR_FAINT },
								}, `${mark}${money(value)}`),
								h("span", { style: { color: COLOR_FAINT, fontSize: "11px" } },
									` · ${tokens(s.todayTokens || 0)}`)),
						);
					})),
			);

			// 价目压缩成一行（原来的大块让给排行榜），详情仍然在第六格的悬浮提示里
			const leftMs = pricing && pricing.nextSwitchAt ? pricing.nextSwitchAt - now : null;
			const priceRow = pricing
				? h("div", {
					style: { color: COLOR_FAINT, fontSize: "11px", paddingTop: "4px" },
					title: `${pricing.windows}（北京时间）`,
				}, `${pricing.tierLabel} · 每 100 万 token 入 ¥${pricing.input} / 出 ¥${pricing.output} / 缓存命中 ¥${pricing.cacheRead} / 混合 ${pricing.blendRatio} ¥${pricing.blended} · ${pricing.nextLabel} ${countdown(leftMs)}`)
				: null;

			const foot = h("div", {
				style: {
					display: "flex", justifyContent: "space-between", gap: "8px",
					paddingTop: "6px", marginTop: "6px", borderTop: `1px solid ${COLOR_LINE}`, color: COLOR_DIM,
				},
			},
				h("span", null,
					`合计 ¥${money(totals.cost || 0)} · ${tokens(totals.tokens || 0)} tok`),
				jumpMsg
					? h("span", {
						style: {
							color: jumpMsg.startsWith("跳转失败") ? COLOR_WARN : COLOR_OK,
							maxWidth: "42%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
						},
						title: jumpMsg,
					}, jumpMsg)
					: null,
				h("span", {
					style: { cursor: "pointer", color: COLOR_ACCENT },
					onClick: (event) => { event.stopPropagation(); onRefresh(); },
				}, "刷新"),
			);

			return h("div", {
				style: overlayStyle(anchorRect, wide),
				role: "dialog",
				"data-dbp-overlay": "cost",
				onClick: (event) => event.stopPropagation(),
			},
				head,
				h("div", {
					style: {
						display: "flex", justifyContent: "space-between", gap: "8px",
						color: COLOR_DIM, fontSize: "11px", fontWeight: 700, marginBottom: "2px",
					},
				},
					h("span", null, "最近用过的会话"),
					h("span", null, `${rows.length} 条 · 一屏 ${MAX_ROWS} 行 · 可滑动`)),
				body, leaderboard, priceRow, foot);
		}

		function BalanceCell({ wide, ctx }) {
			const { snapshot, failed, reload } = usePanelData();
			const [open, setOpen] = useState(false);
			const [hover, setHover] = useState(false);
			const { ref, rect, measure } = useAnchor();
			// 「在跑会话」那个小名单：悬停出现、悬停满 3 秒常驻（runPinned），点一下也常驻
			const [runOpen, setRunOpen] = useState(false);
			const [runRect, setRunRect] = useState(null);
			const [runPinned, setRunPinned] = useState(false);
			const pinTimer = useRef(null);
			const closeTimer = useRef(null);
			// 名单挂在哪儿：鼠标从卡片任何地方飘进来，都贴着「在跑」那格弹
			const runCellRef = useRef(null);
			// 其余五格各自的小说明：悬浮弹一份，内容按格子区分
			const [tipKey, setTipKey] = useState("");
			const [tipRect, setTipRect] = useState(null);
			const tipTimer = useRef(null);
			function openTip(key, event) {
				if (tipTimer.current != null) {
					window.clearTimeout(tipTimer.current);
					tipTimer.current = null;
				}
				const box = event && event.currentTarget ? event.currentTarget.getBoundingClientRect() : null;
				if (box) setTipRect(box);
				setTipKey(key);
			}
			function closeTip() {
				if (tipTimer.current != null) window.clearTimeout(tipTimer.current);
				tipTimer.current = window.setTimeout(() => {
					tipTimer.current = null;
					setTipKey("");
				}, 200);
			}
			// 解压按钮：按了几次（决定音阶）+ 是否按着 + 复用的 AudioContext
			const [pressCount, setPressCount] = useState(0);
			const [pressed, setPressed] = useState(false);
			// 彩蛋：45 秒内按够 100 下就重开一次界面
			const pressWindowRef = useRef([]);
			const [egg, setEgg] = useState(false);
			const audioRef = useRef(null);
			// 上次念话的时间：用来给「烦不烦」节流
			const lastSpeakRef = useRef(0);
			// 她念话那段的 blob 地址：换了新的就把旧的撤掉，别攒着
			const audioUrlRef = useRef(null);
			const now = useNow(true);
			const pricing = pricingOf(snapshot);

			const balance = snapshot && snapshot.balance;
			const hasBalance = Boolean(balance && balance.ok);
			const mark = currencyMark(balance && balance.currency);
			const totals = (snapshot && snapshot.totals) || {};
			const totalCost = Number(totals.cost) || 0;
			const totalTokens = Number(totals.tokens) || 0;
			const todayCost = Number(totals.todayCost) || 0;
			const todayTokens = Number(totals.todayTokens) || 0;
			const apiCost = Number(totals.apiCost) || 0;
			const runningCount = Number(totals.running) || 0;
			const partial = totals.partial === true;

			useEffect(() => {
				if (open || hover) measure();
			}, [open, hover, snapshot, measure]);

			useEffect(() => {
				if (!open) return undefined;
				const close = () => setOpen(false);
				window.addEventListener("click", close);
				return () => window.removeEventListener("click", close);
			}, [open]);

			// 「在跑」名单：点空白处收掉
			useEffect(() => {
				if (!runOpen) return undefined;
				const close = () => { setRunOpen(false); setRunPinned(false); };
				window.addEventListener("click", close);
				return () => window.removeEventListener("click", close);
			}, [runOpen]);

			// 卸载时把两个计时器清掉
			useEffect(() => () => {
				if (pinTimer.current != null) window.clearTimeout(pinTimer.current);
				if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
			}, []);

			/** 一格：上面数值，下面小字标签。extra 里的东西（onMouseEnter 之类）直接摊到格子上。 */
			const cell = (value, label, hint, color, extra) => h("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					minWidth: 0,
					padding: "5px 0",
				},
				title: hint,
				...(extra || {}),
			},
				h("div", {
					style: {
						fontSize: "14px",
						fontWeight: 900,
						lineHeight: 1.3,
						fontVariantNumeric: "tabular-nums",
						color: color || COLOR_ORANGE,
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
						maxWidth: "100%",
					},
				}, value),
				h("div", {
					style: {
						fontSize: "10px",
						fontWeight: 700,
						lineHeight: 1.3,
						color: COLOR_DIM,
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
						maxWidth: "100%",
					},
				}, label),
			);

			// 第六格：当前档位 + 距离切换的秒级倒计时
			const leftMs = pricing && pricing.nextSwitchAt ? pricing.nextSwitchAt - now : null;
			const tierCell = pricing
				? h("div", {
					style: {
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						justifyContent: "center",
						minWidth: 0,
						padding: "5px 0",
					},
					title: `${pricing.tierLabel}（${pricing.windows}）· ${pricing.nextLabel} ${countdown(leftMs)} · 每 100 万 token 入 ${pricing.input} / 出 ${pricing.output} / 混合 ${pricing.blendRatio} 约 ${pricing.blended}`,
					onMouseEnter: (event) => openTip("tier", event),
					onMouseLeave: closeTip,
				},
					h("div", {
						style: {
							fontSize: "14px",
							fontWeight: 900,
							lineHeight: 1.3,
							color: pricing.tierColor,
							whiteSpace: "nowrap",
						},
					}, pricing.tierLabel),
					h("div", {
						style: {
							fontSize: "10px",
							fontWeight: 700,
							lineHeight: 1.3,
							color: COLOR_DIM,
							fontVariantNumeric: "tabular-nums",
							whiteSpace: "nowrap",
						},
					}, `${pricing.nextLabel} ${countdown(leftMs)}`),
				)
				: cell("—", "峰谷", "价目还没取到");

			// 第五格：正在工作的会话数量。悬停冒出名单（名字 + 已经跑了多久，长的在上），
			// 悬停满 3 秒就常驻（鼠标移开也不收），点名单里的行直接跳过去。
			const runningRows = ((snapshot && snapshot.running) || [])
				.map((r) => {
					const full = ((snapshot && snapshot.sessions) || []).find((s) => s.id === r.id) || {};
					return {
						id: r.id,
						title: full.title || r.title || "(无标题)",
						cwd: full.cwd || "",
						since: Number(r.lastAt) || Number(full.lastAt) || 0,
						elapsed: Math.max(0, now - (Number(r.lastAt) || Number(full.lastAt) || now)),
					};
				})
				.sort((a, b) => b.elapsed - a.elapsed);

			const openRunning = (event) => {
				if (closeTimer.current != null) {
					window.clearTimeout(closeTimer.current);
					closeTimer.current = null;
				}
				const anchor = event && event.currentTarget ? event.currentTarget : runCellRef.current;
				const box = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
				if (box) setRunRect(box);
				setRunOpen(true);
				if (!runPinned && pinTimer.current == null) {
					pinTimer.current = window.setTimeout(() => {
						pinTimer.current = null;
						setRunPinned(true);
					}, 3000);
				}
			};
			// 离开格子不立刻收：留 250ms 让人能把鼠标挪到名单上（名单自己也会调 openRunning）
			const closeRunning = () => {
				if (pinTimer.current != null) {
					window.clearTimeout(pinTimer.current);
					pinTimer.current = null;
				}
				if (runPinned) return;
				if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
				closeTimer.current = window.setTimeout(() => {
					closeTimer.current = null;
					setRunOpen(false);
				}, 250);
			};

			// 解压按钮：按一下响一声（Web Audio 现合成，不用带音频文件）。
			// 每按一下升半个音阶，连按五下绕回低音，摸着有点解压。
			const popSound = () => {
				try {
					const Ctor = window.AudioContext || window.webkitAudioContext;
					if (!Ctor) return;
					if (!audioRef.current) audioRef.current = new Ctor();
					const ac = audioRef.current;
					if (ac.state === "suspended") ac.resume();
					const t0 = ac.currentTime;
					const base = 380 + (pressCount % 5) * 70;
					const osc = ac.createOscillator();
					const gain = ac.createGain();
					osc.type = "triangle";
					osc.frequency.setValueAtTime(base, t0);
					osc.frequency.exponentialRampToValueAtTime(base * 2.1, t0 + 0.05);
					gain.gain.setValueAtTime(0.0001, t0);
					gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.008);
					gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
					osc.connect(gain);
					gain.connect(ac.destination);
					osc.start(t0);
					osc.stop(t0 + 0.16);
				} catch (error) {
					console.warn("[dsh-balance-panel] 响不出来", error);
				}
			};

			// 按下去除了「咚」，还会念一句「烦不烦」。优先要宿主那边的肥鱼音色
			// （/api/balance-panel/say → 本机 TTS shim），拿不到才退回系统语音。
			const speakFallback = (text) => {
				try {
					const synth = window.speechSynthesis;
					if (!synth) return;
					const utter = new SpeechSynthesisUtterance(text);
					utter.lang = "zh-CN";
					utter.rate = 1.15;
					utter.pitch = 1.3;
					utter.volume = 0.9;
					const voices = synth.getVoices ? synth.getVoices() : [];
					const zh = (voices || []).find((v) => /zh|chinese|xiaoxiao|huihui|yaoyao|tingting/i.test(`${v.lang} ${v.name}`));
					if (zh) utter.voice = zh;
					synth.cancel();
					synth.speak(utter);
				} catch (error) {
					console.warn("[dsh-balance-panel] 系统语音也念不出来", error);
				}
			};

			const speakLine = async (text) => {
				// 连按太快就不念了，免得叠成一片噪音
				const nowMs = Date.now();
				if (lastSpeakRef.current && nowMs - lastSpeakRef.current < 700) return;
				lastSpeakRef.current = nowMs;
				try {
					const response = await fetch(SAY_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ text }),
					});
					if (!response.ok) throw new Error(`say ${response.status}`);
					const blob = await response.blob();
					if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
					audioUrlRef.current = URL.createObjectURL(blob);
					const audio = new Audio(audioUrlRef.current);
					audio.volume = 0.95;
					await audio.play();
				} catch (error) {
					console.warn("[dsh-balance-panel] 肥鱼没开口，退回系统语音", error);
					speakFallback(text);
				}
			};

			// 声音要「先备好、点击时再放」：await 过 fetch 之后再 play()，浏览器已经不把这次
			// 播放算在用户手势里了，会被 autoplay 策略拦掉——听起来就是按了没声。
			// 另外她那台 TTS 一次只能跑一份活，三句同时打过去必有一两句失败 → 偶尔冒机械音。
			// 所以：一句一句排队合成，失败就退避重试；实在拿不到就只响「咚」，不再用机械音顶。
			const sayReadyRef = useRef(new Map());
			const sayQueueRef = useRef(Promise.resolve());

			// 走磁盘上那只 wav：宿主没有就现合成一次再存下来，之后都是读文件
			const sayUrl = (text) => `${SAY_FILE_ROUTE}?text=${encodeURIComponent(text)}`;

			const requestSay = (text) =>
				fetch(sayUrl(text)).then((response) => (response.ok ? response.blob() : Promise.reject(new Error(`say ${response.status}`))));

			const buildUrl = (blob) => {
				// 三句都一直留着（撤了地址正在放的那段会被掐断），页面上就这么三个 blob，不碍事
				const url = URL.createObjectURL(blob);
				audioUrlRef.current = url;
				return url;
			};

			const warmSay = (text, attempt = 0) => {
				const cache = sayReadyRef.current;
				if (cache.get(text)) return; // 已经合成好了
				if (cache.has(text)) return; // 正在队里
				cache.set(text, null);
				sayQueueRef.current = sayQueueRef.current.then(() =>
					requestSay(text)
						.then((blob) => cache.set(text, buildUrl(blob)))
						.catch((error) => {
							cache.delete(text);
							console.warn(`[dsh-balance-panel] 「${text}」合成失败（第 ${attempt + 1} 次）`, error);
							if (attempt < 3) {
								setTimeout(() => warmSay(text, attempt + 1), 1200 * (attempt + 1));
							}
						}),
				);
			};

			const playUrl = (url) => {
				try {
					const audio = new Audio(url);
					audio.volume = 0.95;
					const played = audio.play();
					if (played && typeof played.catch === "function") {
						played.catch((error) => console.warn("[dsh-balance-panel] 播不出来", error));
					}
				} catch (error) {
					console.warn("[dsh-balance-panel] 播不出来", error);
				}
			};

			const playSay = (text) => {
				const url = sayReadyRef.current.get(text);
				if (url) {
					playUrl(url);
					return;
				}
				// 还没备好：先把合成排上，等它回来补放（用户手势一般还剩几秒，能放出来）
				warmSay(text);
				let tries = 0;
				const timer = setInterval(() => {
					tries += 1;
					const ready = sayReadyRef.current.get(text);
					if (ready) {
						clearInterval(timer);
						playUrl(ready);
					} else if (tries > 40) {
						clearInterval(timer);
					}
				}, 200);
			};

			// 三句随机换着说，但不连着说同一句
			const lastLineRef = useRef("");
			const pickLine = () => {
				const pool = SAY_LINES.filter((line) => line !== lastLineRef.current);
				const line = pool[Math.floor(Math.random() * pool.length)] || SAY_LINES[0];
				lastLineRef.current = line;
				return line;
			};

			useEffect(() => {
				SAY_LINES.forEach((line) => warmSay(line));
			}, []);

			const runningCell = h("div", {
				ref: runCellRef,
				style: { display: "flex", alignItems: "stretch", gap: "3px", minWidth: 0, padding: "3px 0" },
			},
				// 左半：正在工作的会话数（悬停出名单，3 秒常驻）
				h("div", {
					style: {
						flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column",
						alignItems: "center", justifyContent: "center", cursor: "pointer", borderRadius: "6px",
					},
					title: runningCount > 0
						? `正在工作：\n${runningRows.map((r) => `${r.title} · 已跑 ${duration(r.elapsed)}`).join("\n")}\n悬停 3 秒常驻，点行跳转`
						: "现在没有会话在跑",
					onMouseEnter: openRunning,
					onMouseLeave: closeRunning,
					onClick: (event) => {
						event.stopPropagation();
						setRunRect(event.currentTarget.getBoundingClientRect());
						setRunOpen(true);
						setRunPinned(true);
					},
				},
					h("div", {
						style: {
							fontSize: "14px", fontWeight: 900, lineHeight: 1.2,
							fontVariantNumeric: "tabular-nums",
							color: runningCount > 0 ? COLOR_OK : COLOR_DIM,
						},
					}, String(runningCount)),
					h("div", {
						style: {
							fontSize: "10px", fontWeight: 700, lineHeight: 1.2,
							color: COLOR_DIM, whiteSpace: "nowrap",
						},
					}, "在跑")),
				// 右半：解压按钮，按一下咚一声 + 缩一下
				h("button", {
					type: "button",
					style: {
						flex: "1 1 0", minWidth: 0, minHeight: "34px", margin: 0, padding: "0",
						display: "flex", alignItems: "center", justifyContent: "center",
						border: `1px solid ${COLOR_LINE}`,
						borderRadius: "8px",
						background: pressed ? "rgba(255,157,63,0.34)" : "rgba(255,157,63,0.16)",
						color: COLOR_ORANGE,
						fontSize: "11px", fontWeight: 900, lineHeight: 1,
						cursor: "pointer",
						transform: pressed ? "scale(0.88)" : "scale(1)",
						transition: "transform 70ms ease-out, background 120ms ease-out",
					},
					title: `解压按钮：按一下响一声（已按 ${pressCount} 下）`,
					onMouseDown: () => setPressed(true),
					onMouseUp: () => setPressed(false),
					onMouseLeave: () => setPressed(false),
					onClick: (event) => {
						event.stopPropagation();
						popSound();
						playSay(pickLine());
						setPressCount((value) => value + 1);
						// 彩蛋：45 秒的窗口里攒够 100 下，就让界面自己重开
						const nowMs = Date.now();
						const window45 = pressWindowRef.current.filter((t) => nowMs - t <= EGG_WINDOW_MS);
						window45.push(nowMs);
						pressWindowRef.current = window45;
						if (window45.length >= EGG_PRESS_COUNT && !egg) {
							setEgg(true);
							window.setTimeout(() => {
								try {
									window.location.reload();
								} catch (error) {
									console.warn("[dsh-balance-panel] 重开失败", error);
									setEgg(false);
								}
							}, 1400);
						}
					},
				}, "咚"),
			);

			// 鼠标在卡片上一停就弹：哪怕这会儿没有会话在跑，也弹出来说一声，
			// 免得「悬停没反应」被当成坏了。
			const runningPanel = runOpen
				? h("div", {
					style: {
						position: "fixed",
						zIndex: 60,
						...{
							top: runRect ? `${Math.min(window.innerHeight - 180, runRect.bottom + 6)}px` : "120px",
							left: runRect ? `${Math.max(8, Math.min(window.innerWidth - 300, runRect.left - 12))}px` : "80px",
						},
						minWidth: "240px",
						maxWidth: "min(60vw, 460px)",
						maxHeight: "30vh",
						overflowY: "auto",
						padding: "8px 10px",
						borderRadius: "8px",
						border: `1px solid ${COLOR_LINE}`,
						background: COLOR_PANEL,
						boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
						cursor: "default",
					},
					onMouseEnter: openRunning,
					onMouseLeave: closeRunning,
					onClick: (event) => event.stopPropagation(),
				},
					h("div", {
						style: {
							display: "flex", justifyContent: "space-between", gap: "8px",
							color: COLOR_DIM, fontSize: "11px", fontWeight: 700, marginBottom: "4px",
						},
					},
						h("span", null, `正在工作 ${runningRows.length} 条`),
						h("span", { style: { color: runPinned ? COLOR_OK : COLOR_FAINT } },
							runPinned ? "常驻" : "悬停 3 秒常驻")),
					runningRows.length === 0
						? h("div", {
							style: { color: "rgba(255,255,255,0.66)", fontSize: "12px", padding: "2px 2px 1px" },
						}, "这会儿没有会话在跑")
						: runningRows.map((r) => h("div", {
						key: r.id,
						style: {
							display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto",
							gap: "8px", alignItems: "center",
							padding: "3px 2px", borderRadius: "4px", cursor: "pointer",
							fontSize: "12px",
						},
						title: `${r.title}\n点击跳到这条会话`,
						onMouseEnter: (event) => { event.currentTarget.style.background = COLOR_HOVER; },
						onMouseLeave: (event) => { event.currentTarget.style.background = "transparent"; },
						onClick: (event) => {
							event.stopPropagation();
							openSessionTo(ctx, r.id, r.title);
						},
					},
						h("span", {
							style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 },
						},
							h("span", {
								style: { width: "6px", height: "6px", borderRadius: "50%", background: COLOR_OK, flex: "0 0 auto" },
							}),
							h("span", {
								style: { color: "#ffffff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
							}, r.title)),
						h("span", {
							style: { color: "rgba(255,255,255,0.66)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
						}, `已跑 ${duration(r.elapsed)}`),
					)),
				)
				: null;

			const grid = h("div", {
				style: {
					display: "grid",
					gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
					gap: "6px 4px",
					width: "100%",
				},
			},
				cell(
					`${mark}${money(balance && balance.ok ? balance.total : null)}`,
					"实时余额",
					"平台账户里的钱（30 秒缓存）",
					undefined,
					{ onMouseEnter: (event) => openTip("balance", event), onMouseLeave: closeTip },
				),
				cell(`${mark}${money(todayCost)}`, "今日花费", "今天动过的会话，按 token 估的", undefined,
					{ onMouseEnter: (event) => openTip("todayCost", event), onMouseLeave: closeTip }),
				cell(tokens(todayTokens), "今日 token", "今天动过的会话：输入 + 缓存 + 输出", undefined,
					{ onMouseEnter: (event) => openTip("todayTokens", event), onMouseLeave: closeTip }),
				cell(
					`${mark}${money(totalCost)}`,
					partial ? `载入 ${Number(totals.loaded) || 0}/${Number(totals.total) || 0}` : "总消耗",
					`全部 ${Number(totals.sessions) || 0} 条会话累计（估算）· ${tokens(totalTokens)} tok`,
					undefined,
					{ onMouseEnter: (event) => openTip("total", event), onMouseLeave: closeTip },
				),
				runningCell,
				tierCell,
			);

			const headline = hasBalance
				? `${mark}${money(balance.total)}`
				: (failed || snapshot === null ? "—" : "无余额");

			// 每一格的小说明：各有各的内容，都只有几行
			const tipBody = (key) => {
				const list = (snapshot && snapshot.sessions) || [];
				const pick = (s, k) => Number((s.tokens && s.tokens[k]) || 0);
				const sumAll = (k) => list.reduce((acc, s) => acc + pick(s, k), 0);
				const todayList = list.filter((s) => Number(s.todayTokens) > 0 || Number(s.todayCost) > 0);
				const sumToday = (k) => todayList.reduce((acc, s) => acc + pick(s, k), 0);
				if (key === "balance") {
					return [
						["账户余额", balance && balance.ok ? `${mark}${money(balance.total)}` : "拿不到"],
						["当前档位", pricing ? pricing.tierLabel : "—"],
						["查询于", balance && balance.at ? clock(balance.at) : "—"],
					];
				}
				if (key === "todayCost") {
					return [
						["今日花费", `${mark}${money(todayCost)}`],
						["今日动过的会话", `${todayList.length} 条`],
						["占累计", totalCost > 0 ? `${Math.round((todayCost / totalCost) * 100)}%` : "—"],
					];
				}
				if (key === "todayTokens") {
					return [
						["今日 token", tokens(todayTokens)],
						["输入", tokens(sumToday("uncachedInput"))],
						["缓存命中", tokens(sumToday("cacheRead"))],
						["输出", tokens(sumToday("output"))],
					];
				}
				if (key === "total") {
					return [
						["总花费", `${mark}${money(totalCost)}`],
						["总 token", tokens(totalTokens)],
						["输入 / 缓存 / 输出", `${tokens(sumAll("uncachedInput"))} / ${tokens(sumAll("cacheRead"))} / ${tokens(sumAll("output"))}`],
						["会话数", `${Number(totals.sessions) || 0} 条`],
					];
				}
				if (key === "tier") {
					return [
						["档位", pricing ? pricing.tierLabel : "—"],
						["切换", pricing && leftMs != null ? `${pricing.nextLabel} ${countdown(leftMs)}` : "—"],
						["每 100 万 · 输入", pricing ? pricing.input : "—"],
						["每 100 万 · 输出", pricing ? pricing.output : "—"],
						["每 100 万 · 缓存命中", pricing ? pricing.cacheRead : "—"],
						["时段", pricing ? pricing.windows : "—"],
					];
				}
				return [];
			};

			const tipPanel = tipKey
				? h("div", {
					style: {
						position: "fixed",
						zIndex: 61,
						top: tipRect ? `${Math.min(window.innerHeight - 170, tipRect.bottom + 6)}px` : "120px",
						left: tipRect ? `${Math.max(8, Math.min(window.innerWidth - 260, tipRect.left - 16))}px` : "80px",
						minWidth: "190px",
						maxWidth: "min(70vw, 420px)",
						padding: "8px 10px",
						borderRadius: "8px",
						border: `1px solid ${COLOR_LINE}`,
						background: COLOR_PANEL,
						boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
						cursor: "default",
						fontSize: "12px",
					},
					onMouseEnter: () => openTip(tipKey),
					onMouseLeave: closeTip,
					onClick: (event) => event.stopPropagation(),
				},
					tipBody(tipKey).map(([label, value], index) => h("div", {
						key: index,
						style: { display: "flex", justifyContent: "space-between", gap: "12px", padding: "2px 0" },
					},
						h("span", { style: { color: "rgba(255,255,255,0.66)" } }, label),
						h("span", { style: { color: "#ffffff", fontVariantNumeric: "tabular-nums", textAlign: "right" } }, value))),
				)
				: null;

			// 设置页一按开关就立刻隐/现，不等下一次轮询
			const [visibility, setVisibility] = useState(null);
			useEffect(() => {
				const onVisibility = (event) => {
					const detail = (event && event.detail) || {};
					const nextHidden = detail.hidden === true;
					setVisibility(nextHidden);
					if (!nextHidden) reload();
				};
				window.addEventListener(VISIBILITY_EVENT, onVisibility);
				return () => window.removeEventListener(VISIBILITY_EVENT, onVisibility);
			}, [reload]);

			// 设置页里关掉了：整张卡片不画（上面的 hooks 已经全部跑完，直接返回是安全的）
			const hiddenNow = visibility === null
				? Boolean(snapshot && snapshot.hidden === true)
				: visibility === true;
			if (hiddenNow) return null;

			return h(react.Fragment, null,
				h("div", {
					ref,
					style: {
						width: "100%",
						cursor: "pointer",
						userSelect: "none",
						padding: wide ? "12px 10px" : "2px",
						borderRadius: "8px",
					},
					title: "点击展开每条会话的花费明细",
					onMouseEnter: () => setHover(true),
					onMouseLeave: () => setHover(false),
					onClick: (event) => {
						event.stopPropagation();
						setOpen((v) => !v);
						reload();
					},
				},
					wide
						? grid
						: h("div", {
							style: {
								textAlign: "center",
								fontSize: "13px",
								fontWeight: 900,
								color: hasBalance ? COLOR_ORANGE : COLOR_DIM,
								fontVariantNumeric: "tabular-nums",
							},
						}, headline),
				),
				open && snapshot
					? h(CostPanel, { anchorRect: rect, snapshot, wide, failed, onRefresh: reload, ctx })
					: null,
				// 「在跑会话」名单挂在第五格上（悬停 3 秒常驻、点行跳转）
				runningPanel,
				// 其余格子各自的小说明
				tipPanel,
				// 彩蛋触发：盖一层，说一句，然后重开
				egg
					? h("div", {
						style: {
							position: "fixed",
							inset: 0,
							zIndex: 999,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							background: "rgba(0,0,0,0.72)",
							color: "#ffffff",
							fontSize: "15px",
							fontWeight: 900,
							letterSpacing: "1px",
							cursor: "default",
						},
						onClick: (event) => event.stopPropagation(),
					}, "……行吧，我重开一下")
					: null,
			);
		}

		// ---- 设置页：开关 + 一键卸载 -------------------------------------
		const PREFS_ROUTE = "/api/balance-panel/prefs";
		const VISIBILITY_EVENT = "dsh-balance-panel:visibility";
		const UNINSTALL_ROUTE = "/api/balance-panel/uninstall";
		const UPDATE_ROUTE = "/api/balance-panel/update";

		function Toggle({ on, busy, onToggle }) {
			return h("button", {
				type: "button",
				onClick: onToggle,
				disabled: busy,
				title: on ? "点一下关掉（侧栏那张卡不再显示）" : "点一下打开",
				style: {
					width: "44px",
					height: "24px",
					flex: "0 0 auto",
					border: "none",
					borderRadius: "12px",
					padding: "2px",
					cursor: busy ? "default" : "pointer",
					background: on ? COLOR_OK : "rgba(127,127,127,0.35)",
					display: "flex",
					alignItems: "center",
					justifyContent: on ? "flex-end" : "flex-start",
					transition: "background 0.15s",
				},
			},
				h("span", {
					style: {
						width: "20px",
						height: "20px",
						borderRadius: "10px",
						background: "#ffffff",
						boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
					},
				}));
		}

		function SettingsPanel() {
			const [prefs, setPrefs] = useState(null);
			const [busy, setBusy] = useState("");
			const [msg, setMsg] = useState("");
			const [careful, setCareful] = useState(false);
			const [source, setSource] = useState("");
			const [auto, setAuto] = useState(false);
			const [autoInstall, setAutoInstall] = useState(false);
			const [proxy, setProxy] = useState("");
			const [price, setPrice] = useState({ input: "", cacheRead: "", output: "", offDiscount: "" });
			const [probe, setProbe] = useState(null);
			const autoRanRef = useRef(false);

			const priceFromBody = (body) => {
				const eff = (body && body.effectivePrices) || null;
				const raw = (body && body.prices) || {};
				const num = (v) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "");
				return {
					input: raw.input != null ? num(raw.input) : eff ? num(eff.standard.input) : "",
					cacheRead: raw.cacheRead != null ? num(raw.cacheRead) : eff ? num(eff.standard.cacheRead) : "",
					output: raw.output != null ? num(raw.output) : eff ? num(eff.standard.output) : "",
					offDiscount: raw.offDiscount != null ? num(raw.offDiscount) : "0.5",
				};
			};

			const savePrice = () => {
				const payload = {};
				for (const key of ["input", "cacheRead", "output", "offDiscount"]) {
					const v = Number(price[key]);
					if (price[key] !== "" && Number.isFinite(v) && v >= 0) payload[key] = v;
				}
				setMsg("价目表已保存，刷新一下卡片就是新价");
				fetch(PREFS_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ prices: payload }),
				})
					.then((response) => response.json())
					.then((body) => {
						if (!body || !body.ok) setMsg(`价目表没存上：${(body && body.error) || "未知"}`);
						else setPrice(priceFromBody(body));
					})
					.catch((error) => setMsg(`价目表没存上：${error.message}`));
			};

			useEffect(() => {
				fetch(PREFS_ROUTE, { cache: "no-store" })
					.then((response) => response.json())
					.then((body) => {
						if (body && body.ok) {
							setPrefs(body);
							const saved = typeof body.updateSource === "string" ? body.updateSource : "";
							setSource(saved);
							const isAuto = body.autoUpdate === true;
							setAuto(isAuto);
							setAutoInstall(body.autoInstall === true);
							setProxy(typeof body.githubProxy === "string" ? body.githubProxy : "");
							setPrice(priceFromBody(body));
							if (isAuto && saved && !autoRanRef.current) {
								autoRanRef.current = true;
								// 开了自动检查就悄悄问一次，有新版再把话说出来
								setTimeout(() => checkUpdate(saved, true), 2500);
							}
						} else setMsg(`读不到设置：${(body && body.error) || "未知"}`);
					})
					.catch((error) => setMsg(`读不到设置：${error.message}`));
			}, []);

			const toggle = () => {
				if (!prefs || busy) return;
				const next = prefs.hidden !== true;
				setBusy("toggle");
				fetch(PREFS_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ hidden: next }),
				})
					.then((response) => response.json())
					.then((body) => {
						if (body && body.ok) {
							setPrefs({ ...prefs, hidden: body.hidden === true });
							window.dispatchEvent(new CustomEvent(VISIBILITY_EVENT, { detail: { hidden: body.hidden === true } }));
							setMsg(body.hidden ? "已关闭：侧栏那张卡片这就没了" : "已打开：卡片已回到侧栏底部");
						} else {
							setMsg(`没存下来：${(body && body.error) || "未知"}`);
						}
					})
					.catch((error) => setMsg(`没存下来：${error.message}`))
					.finally(() => setBusy(""));
			};

			const uninstall = () => {
				if (busy) return;
				if (!careful) {
					setCareful(true);
					setMsg("再点一下「确认卸载」就真动手了：会从 profile 里摘掉并删掉插件目录，重启 DSH 后彻底消失。");
					return;
				}
				setBusy("uninstall");
				fetch(UNINSTALL_ROUTE, { method: "POST" })
					.then((response) => response.json())
					.then((body) => {
						if (body && body.ok) {
							const count = (body.touched || []).length;
							setMsg(`已从 ${count} 个 profile 摘掉，插件目录也在删了。重启 DSH 之后就干净了。`);
						} else {
							setMsg(`卸载没成：${(body && (body.message || body.error)) || "未知"}`);
						}
					})
					.catch((error) => setMsg(`卸载没成：${error.message}`))
					.finally(() => setBusy(""));
			};

			// 更新：查一下 / 装一下。装完要给后台脚本两三秒，再重启 DSH 才生效。
			const checkUpdate = (nextSource, quiet) => {
				const src = typeof nextSource === "string" ? nextSource : source;
				if (!src.trim()) {
					setMsg("先填一个有新版本的文件夹或网址");
					return Promise.resolve(null);
				}
				setBusy("check");
				return fetch(`${UPDATE_ROUTE}?source=${encodeURIComponent(src.trim())}`, { cache: "no-store" })
					.then((response) => response.json())
					.then((body) => {
						setProbe(body);
						if (!quiet) {
							if (body && body.ok) {
								setMsg(body.needsUpdate
									? `有新版：${body.current} → ${body.latest}`
									: `已是最新：${body.current}`);
							} else {
								setMsg(`检查没成：${(body && body.error) || "未知"}`);
							}
						}
						return body;
					})
					.catch((error) => {
						setProbe({ ok: false, error: error.message });
						if (!quiet) setMsg(`检查没成：${error.message}`);
						return null;
					})
					.finally(() => setBusy(""));
			};

			const installUpdate = () => {
				if (busy) return;
				setBusy("install");
				fetch(UPDATE_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action: "install", source: source.trim() }),
				})
					.then((response) => response.json())
					.then((body) => {
						if (body && body.ok) {
							const size = Math.round((body.bytes || 0) / 1024);
							setMsg(`已放到盘上（${size} KB），后台脚本正在解压覆盖。等两三秒，然后重启 DSH。日志：${body.log}`);
						} else {
							setMsg(`更新没成：${(body && (body.message || body.error)) || "未知"}`);
						}
					})
					.catch((error) => setMsg(`更新没成：${error.message}`))
					.finally(() => setBusy(""));
			};

			const saveSource = (patch) => {
				fetch(PREFS_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(patch),
				}).catch(() => {});
			};

			const toggleAuto = () => {
				const next = !auto;
				setAuto(next);
				saveSource({ updateSource: source.trim(), autoUpdate: next, githubProxy: proxy.trim() });
				if (next) checkUpdate(source, true);
			};

			const toggleAutoInstall = () => {
				const next = !autoInstall;
				setAutoInstall(next);
				saveSource({ autoInstall: next });
			};

			const probeText = (p) => {
				if (!p) return "";
				if (!p.ok) return `检查没成：${p.error || "未知"}`;
				return p.needsUpdate ? `有新版：${p.current} → ${p.latest}` : `已是最新：${p.current}`;
			};

			const row = (label, value) => h("div", {
				style: { display: "flex", gap: "8px", fontSize: "12px", color: COLOR_DIM, padding: "2px 0" },
			},
				h("span", { style: { flex: "0 0 84px", color: COLOR_FAINT } }, label),
				h("span", { style: { color: COLOR_TEXT, wordBreak: "break-all" } }, value));

			const hidden = prefs ? prefs.hidden === true : false;

			return h("div", { style: { display: "flex", flexDirection: "column", gap: "10px", fontSize: "13px", color: COLOR_TEXT } },
				h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" } },
					h("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } },
						h("span", { style: { fontWeight: 700 } }, "侧栏面板"),
						h("span", { style: { fontSize: "12px", color: COLOR_DIM } }, hidden ? "已关闭 · 侧栏底部不显示这张卡" : "已打开 · 侧栏底部显示六格卡片")),
					h(Toggle, { on: !hidden, busy: busy === "toggle" || !prefs, onToggle: toggle })),
				prefs
					? h("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } },
						row("版本", prefs.version || "—"),
						row("插件目录", prefs.dir || "—"),
						row("开关文件", prefs.prefsFile || "—"))
					: null,
				h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", paddingTop: "8px", borderTop: `1px solid ${COLOR_LINE}` } },
					h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
						h("span", { style: { flex: "0 0 84px", fontSize: "12px", color: COLOR_FAINT } }, "更新源"),
						h("input", {
							type: "text",
							value: source,
							onChange: (event) => setSource(event.target.value),
							onBlur: () => saveSource({ updateSource: source.trim() }),
							placeholder: "放新版 zip 的文件夹，或 http 目录（里面有 latest.json）",
							style: {
								flex: "1 1 auto",
								minWidth: 0,
								padding: "5px 8px",
								borderRadius: "6px",
								border: `1px solid ${COLOR_LINE}`,
								background: "transparent",
								color: COLOR_TEXT,
								fontSize: "12px",
							},
						})),
					h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
						h("span", { style: { flex: "0 0 84px", fontSize: "12px", color: COLOR_FAINT } }, "镜像前缀"),
						h("input", {
							type: "text",
							value: proxy,
							onChange: (event) => setProxy(event.target.value),
							onBlur: () => saveSource({ githubProxy: proxy.trim() }),
							placeholder: "可选：GitHub 连不上时填镜像前缀，如 https://gh.llkk.cc",
							style: {
								flex: "1 1 auto",
								minWidth: 0,
								padding: "5px 8px",
								borderRadius: "6px",
								border: `1px solid ${COLOR_LINE}`,
								background: "transparent",
								color: COLOR_TEXT,
								fontSize: "12px",
							},
						})),
					h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", fontSize: "12px", color: COLOR_DIM } },
						h("span", { style: { flex: "0 0 84px", color: COLOR_FAINT } }, "价目表"),
						["input", "cacheRead", "output", "offDiscount"].map((key) =>
							h("label", { key, style: { display: "flex", alignItems: "center", gap: "4px" } },
								h("span", null, PRICE_LABEL[key]),
								h("input", {
									type: "number",
									step: "0.01",
									min: "0",
									value: price[key],
									onChange: (event) => setPrice((prev) => ({ ...prev, [key]: event.target.value })),
									style: {
										width: "62px",
										padding: "4px 6px",
										borderRadius: "5px",
										border: `1px solid ${COLOR_LINE}`,
										background: "transparent",
										color: COLOR_TEXT,
										fontSize: "12px",
									},
								}))),
						h("button", {
							type: "button",
							onClick: savePrice,
							style: {
								padding: "5px 10px",
								borderRadius: "6px",
								border: `1px solid ${COLOR_LINE}`,
								background: "transparent",
								color: COLOR_TEXT,
								fontSize: "12px",
								cursor: "pointer",
							},
						}, "保存价目"),
						h("span", { style: { flexBasis: "100%", fontSize: "11px", color: COLOR_FAINT } },
							"单位：元 / 百万 token，只影响 deepseek-flash。谷价 = 标准价 × 折扣（默认 0.5）。填官方价目就能跟账单对上。")),
					h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" } },
						h("button", {
							type: "button",
							onClick: () => checkUpdate(),
							disabled: busy === "check",
							style: {
								padding: "6px 12px",
								borderRadius: "6px",
								border: `1px solid ${COLOR_LINE}`,
								background: "transparent",
								color: COLOR_TEXT,
								fontSize: "12px",
								cursor: busy === "check" ? "default" : "pointer",
							},
						}, busy === "check" ? "检查中…" : "检查更新"),
						h("button", {
							type: "button",
							onClick: installUpdate,
							disabled: busy === "install" || !(probe && probe.ok && probe.needsUpdate),
							style: {
								padding: "6px 12px",
								borderRadius: "6px",
								border: `1px solid ${probe && probe.needsUpdate ? "rgba(255,157,63,0.55)" : COLOR_LINE}`,
								background: probe && probe.needsUpdate ? "rgba(255,157,63,0.18)" : "transparent",
								color: probe && probe.needsUpdate ? COLOR_TEXT : COLOR_FAINT,
								fontSize: "12px",
								cursor: busy === "install" || !(probe && probe.needsUpdate) ? "default" : "pointer",
							},
						}, busy === "install" ? "下载中…" : "安装并重启"),
						h("span", { style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: COLOR_DIM } },
							h("span", null, "自动检查"),
							h(Toggle, { on: auto, busy: false, onToggle: toggleAuto })),
						h("span", { style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: COLOR_DIM } },
							h("span", null, "自动安装"),
							h(Toggle, { on: autoInstall, busy: false, onToggle: toggleAutoInstall })),
					),
					probe ? h("div", { style: { fontSize: "12px", color: COLOR_DIM } }, probeText(probe)) : null,
					h("span", { style: { fontSize: "12px", color: COLOR_FAINT } }, "装完要重启 DSH 才生效；更新只会覆盖插件目录里的文件，不碰你的开关和会话数据")),
				h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", paddingTop: "4px", borderTop: `1px solid ${COLOR_LINE}` } },
					h("button", {
						type: "button",
						onClick: uninstall,
						disabled: busy === "uninstall",
						style: {
							padding: "6px 12px",
							borderRadius: "6px",
							border: "1px solid rgba(224,90,90,0.55)",
							background: careful ? "rgba(224,90,90,0.22)" : "transparent",
							color: careful ? "#ff8080" : COLOR_DIM,
							fontSize: "12px",
							cursor: busy === "uninstall" ? "default" : "pointer",
						},
					}, careful ? "确认卸载（不可撤销）" : "一键卸载"),
					h("span", { style: { fontSize: "12px", color: COLOR_FAINT } }, "会从 profile 的 bundles / dependencies 里摘掉本插件，并删除插件目录")),
				msg ? h("div", { style: { fontSize: "12px", color: COLOR_DIM, lineHeight: 1.5 } }, msg) : null);
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			// 等「切会话」这个客户端服务就绪；有它，点明细里的会话行才能跳过去
			// 包了 try：万一这个环境的 ctx 不支持 inject，也不能让整张卡片加载失败
			try {
				ctx.inject(["uiWorkspace"], (scoped) => {
					workspaceNav = scoped.uiWorkspace || null;
				});
			} catch (error) {
				workspaceNav = ctx.uiWorkspace || null;
			}
			// 另外两个服务只用来「查状态」，拿不到也没关系，所以单独 inject，别拖累上面那个
			try {
				ctx.inject(["sessions", "workspaces"], (scoped) => {
					clientServices = { sessions: scoped.sessions, workspaces: scoped.workspaces };
				});
			} catch (error) {
				// 没就没有
			}

			const tagId = "dsh-balance-panel";
			if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
				const style = document.createElement("style");
				style.dataset.plugin = "dsh-balance-panel";
				style.dataset.pluginCss = tagId;
				style.textContent = [
					"div[class*='footerActions']{flex-wrap:wrap}",
					"@keyframes dsh-balance-pulse{0%,100%{opacity:1}50%{opacity:0.25}}",
				].join("\n");
				document.head.appendChild(style);
			}

			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
				{ name: "sidebar.footer.action", id: "dsh-balance", order: 90, label: "余额" },
				(props) => h(BalanceCell, { wide: props.wide, ctx }),
			));

			// 设置 → 集成 里那一栏（开关 + 一键卸载）
			try {
				ctx.slots.inject("settings.section", () => ctx.slots.register(
					{ name: "settings.section", id: "dsh-balance-settings", order: 92, label: "更好的显示" },
					() => h(SettingsPanel),
				));
			} catch (error) {
				console.warn("[dsh-balance-panel] 设置页那一栏没挂上", error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__internals = { money, tokens, duration, clock, countdown, currencyMark };

		return module.exports;
	},
});
