/**
 * dsh-balance-panel — host half.
 *
 * 注册一个路由：
 *
 *   GET /api/balance-panel   余额 + 每个会话的花费 / token / 耗时 / 是否在跑
 *
 * 数据来源（全部本机只读）：
 *   · 余额——凭证服务里 DSH 登录留下的 DeepSeek grant（键 `deepseek-account-platform/default`，
 *     令牌在 `payload.token`），请求头 `x-dsh-auth-token` 打 GET https://api.deepseek.com/user/balance。
 *   · 会话——`<DSH_HOME>/storages/session_projcache/sessions/session-*.json`。每个文件是
 *     DSH 的会话快照，用到的字段：
 *       record.identity.cwd
 *       record.rows.title.val                                 标题
 *       record.rows.tokenUsage.val.totals                     {uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}
 *       record.rows.sessionStats.val                          {turns, steps, llmMs, toolMs, openStep, pendingCalls}
 *       record.rows.modelSelection.val.lastUsed               {provider, model, reasoningEffort}
 *       record.rows.turnBoundary.val.openTurnStartSeq         非 null = 有未收尾的 turn
 *       record.rows.sessionListMetadata.val.lastPromptAt      最近一次发问的时间戳
 *       record.rows.contextActivity.val.days                  按天的用量（见下）
 *   「在跑」= 有未收尾的 turn / 有未完成的 step / 有挂起的工具调用。
 *
 * 「今天花了多少」用的是 `contextActivity.val.days`——DSH 自己按日期分好的桶，形如
 *   days["2026-10-29"].cost[provider][model]["peak" | "off"] = {uncached, cacheRead, cacheWrite, output}
 * 它同时把峰谷档记进去了，所以每一天的花费可以按**当时**那一档折价，不用按「现在」猜。
 * 只有老会话没有这份按天记账时，才退回「累计 token × 当前档位」的估算（数值标 costBasis: "estimate"）。
 *
 * 会话文件可能很大（几 MB），按 mtime+size 缓存，只有变过的文件才重新解析；每次请求
 * 最多重解析 MAX_PARSE_PER_POLL 个，避免把宿主的事件循环卡住。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 插件自己的目录（lib 的上一层）——打包跟着走的那几只 wav 就放在 <root>/assets 下，
// 换了台没有肥鱼服务的机器也能出声。
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const name = "dsh-balance-panel";
const inject = ["credentials", "webServer"];

const ROUTE_PATH = "/api/balance-panel";
// 设置页用：开关（卡片显不显示）与一键卸载
const PREFS_ROUTE = "/api/balance-panel/prefs";
const UNINSTALL_ROUTE = "/api/balance-panel/uninstall";
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const ACCOUNT_GRANT_KEY = "deepseek-account-platform/default";
const BALANCE_TTL_MS = 30 * 1000;
// 平时一次只补几个新文件，别把宿主的事件循环卡住；
// 但冷启动（缓存基本是空的）必须一口气读完，否则要等好几轮才凑出正确金额。
const MAX_PARSE_PER_POLL = 24;
const MAX_PARSE_COLD = 400;
const SCAN_BUDGET_MS = 400;
const COLD_SCAN_BUDGET_MS = 2500;

// ---- 路径 ---------------------------------------------------------------
function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === "string" && env.trim() !== "") return env.trim();
  return path.join(os.homedir(), ".dsh");
}

function sessionsDir() {
  return path.join(dshHome(), "storages", "session_projcache", "sessions");
}

// ---- 开关 / 卸载 ---------------------------------------------------------
// 开关存成一个小 json，改完立刻生效（卡片下次取数据时就知道自己该不该出现）
function prefsPath() {
  return path.join(dshHome(), "dsh-balance-panel.json");
}

async function readPrefs() {
  try {
    const parsed = JSON.parse(await fsp.readFile(prefsPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writePrefs(patch) {
  const current = await readPrefs();
  const next = { ...current, ...patch };
  try {
    await fsp.mkdir(dshHome(), { recursive: true });
    await fsp.writeFile(prefsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn("[dsh-balance-panel] 开关没存下来", error);
    throw error;
  }
  return next;
}

// ---- 更新 ---------------------------------------------------------------
// 更新源两种都认：
//   ① 一个 http(s) 目录：里面放 latest.json 与 zip
//        latest.json = { "version": "0.1.3", "file": "更好的显示_v0.1.3.zip" }（file 也可给完整 url）
//   ② 一个本地文件夹：里面放 .zip，按文件名里的版本号比，没有版本号就按修改时间比
// 真正的解压与覆盖交给一个 PowerShell 脚本在后台干——node 这边只负责把包放到盘上、
// 把脚本点起来，然后请人重启。这样不会出现「自己改自己改到一半」的乱局。
const UPDATE_ROUTE = "/api/balance-panel/update";

function pluginVersion() {
  try {
    const raw = fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = pluginVersion();

function versionParts(value) {
  return String(value || "")
    .split(/[.+-]/)
    .map((piece) => Number.parseInt(piece, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function isHttpSource(source) {
  return /^https?:\/\//i.test(source);
}

// ---- GitHub 仓库当更新源 -------------------------------------------------
// 认这几种写法：
//   owner/repo
//   https://github.com/owner/repo
//   https://github.com/owner/repo/tree/main
// 有 Release 就用 Release 里的 zip + tag 号比版本；没有 Release 就退回「盯分支」，
// 拿最新 commit 的 sha 跟上次装过的 sha 比——仓库一 push，这边就知道该更新了。
function parseGitHub(source) {
  const raw = String(source || "").trim();
  if (!raw) return null;
  const short = raw.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (short) return { owner: short[1], repo: short[2].replace(/\.git$/i, ""), branch: "" };
  const full = raw.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w.\-/]+))?\/?$/i);
  if (full) return { owner: full[1], repo: full[2], branch: full[3] || "" };
  return null;
}

function applyProxy(url, proxy) {
  const prefix = String(proxy || "").trim().replace(/\/+$/, "");
  if (!prefix || !isHttpSource(prefix) || !isHttpSource(url)) return url;
  return `${prefix}/${url}`;
}

async function ghJson(url) {
  const res = await fetch(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "dsh-balance-panel" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  return res.json();
}

async function probeGitHub(source, prefs) {
  const gh = parseGitHub(source);
  if (!gh) return null;
  const repoBase = `https://api.github.com/repos/${gh.owner}/${gh.repo}`;
  const proxy = prefs && typeof prefs.githubProxy === "string" ? prefs.githubProxy : "";
  let tagVersion = "";
  let zip = "";
  let kind = "github";

  try {
    const release = await ghJson(`${repoBase}/releases/latest`);
    tagVersion = String((release && release.tag_name) || "").trim().replace(/^v/i, "");
    const asset = Array.isArray(release && release.assets)
      ? release.assets.find((a) => /\.zip$/i.test(String((a && a.name) || "")))
      : null;
    if (asset && asset.browser_download_url) {
      zip = applyProxy(String(asset.browser_download_url), proxy);
      kind = "github-release";
    }
  } catch {
    // 没发 Release，走分支
  }

  let branch = gh.branch;
  let sha = "";
  if (!zip) {
    if (!branch) {
      try {
        const repo = await ghJson(repoBase);
        branch = String((repo && repo.default_branch) || "main");
      } catch {
        branch = "main";
      }
    }
    try {
      const commit = await ghJson(`${repoBase}/commits/${encodeURIComponent(branch)}`);
      sha = String((commit && commit.sha) || "");
    } catch (error) {
      return {
        ok: false,
        current: VERSION,
        error: tagVersion
          ? `GitHub 连不上：${error && error.message ? error.message : error}`
          : `这个仓库还没有 Release，也读不到 ${branch} 分支（可能是被墙，试试填镜像前缀）`,
      };
    }
    zip = applyProxy(`https://codeload.github.com/${gh.owner}/${gh.repo}/zip/refs/heads/${branch}`, proxy);
    kind = "github-branch";
  }

  const installedSha = prefs && typeof prefs.installedSha === "string" ? prefs.installedSha : "";
  const latest = tagVersion || sha.slice(0, 7) || "未知";
  const needsUpdate = tagVersion
    ? compareVersions(tagVersion, VERSION) > 0
    : Boolean(sha) && sha !== installedSha;

  return {
    ok: true,
    current: VERSION,
    latest,
    needsUpdate,
    zip,
    source,
    kind,
    sha,
    branch,
    repo: `${gh.owner}/${gh.repo}`,
    viaProxy: zip !== "" && zip !== `https://codeload.github.com/${gh.owner}/${gh.repo}/zip/refs/heads/${branch}`,
  };
}

async function probeUpdate(sourceRaw, prefs) {
  const source = String(sourceRaw || "").trim();
  if (!source) return { ok: false, current: VERSION, error: "还没填更新源" };
  const fromGitHub = await probeGitHub(source, prefs);
  if (fromGitHub) return fromGitHub;
  if (isHttpSource(source)) {
    const base = source.replace(/\/+$/, "");
    let manifest;
    try {
      const res = await fetch(`${base}/latest.json`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return { ok: false, current: VERSION, error: `更新源回 HTTP ${res.status}` };
      manifest = await res.json();
    } catch (error) {
      return { ok: false, current: VERSION, error: `连不上更新源：${error && error.message ? error.message : error}` };
    }
    const version = String((manifest && manifest.version) || "").trim();
    const file = String((manifest && manifest.file) || "").trim();
    if (!version || !file) return { ok: false, current: VERSION, error: "latest.json 里缺 version 或 file" };
    return {
      ok: true,
      current: VERSION,
      latest: version,
      needsUpdate: compareVersions(version, VERSION) > 0,
      zip: isHttpSource(file) ? file : `${base}/${file}`,
      source,
      kind: "http",
    };
  }

  let names = [];
  try {
    names = await fsp.readdir(source);
  } catch (error) {
    return { ok: false, current: VERSION, error: `读不了这个文件夹：${error && error.message ? error.message : error}` };
  }
  const zips = names.filter((n) => /\.zip$/i.test(n));
  if (zips.length === 0) return { ok: false, current: VERSION, error: "这个文件夹里没有 .zip" };
  const picked = [];
  for (const n of zips) {
    try {
      const st = await fsp.stat(path.join(source, n));
      const version = (n.match(/_v?(\d+(?:\.\d+)*)/) || [])[1] || "";
      picked.push({ n, mtime: st.mtimeMs, version });
    } catch {
      /* 读不到就跳过 */
    }
  }
  if (picked.length === 0) return { ok: false, current: VERSION, error: "文件夹里的 zip 都读不了" };
  picked.sort((a, b) => (a.version && b.version ? compareVersions(b.version, a.version) : b.mtime - a.mtime));
  const pick = picked[0];
  let pluginMtime = 0;
  try {
    pluginMtime = (await fsp.stat(path.join(PLUGIN_ROOT, "package.json"))).mtimeMs;
  } catch {
    /* 无所谓 */
  }
  const needsUpdate = pick.version
    ? compareVersions(pick.version, VERSION) > 0
    : pick.mtime > pluginMtime + 1000;
  return {
    ok: true,
    current: VERSION,
    latest: pick.version || "（按修改时间判断）",
    needsUpdate,
    zip: path.join(source, pick.n),
    source,
    kind: "file",
  };
}

function updateDir() {
  return path.join(dshHome(), "balance-panel-update");
}

const APPLY_SCRIPT = `param([string]$Zip, [string]$Target, [string]$LogPath)
Add-Content -LiteralPath $LogPath -Value ("[apply] start " + (Get-Date -Format o))
Start-Sleep -Seconds 3
$tmp = Join-Path $env:TEMP ("dbp-" + [guid]::NewGuid().ToString("N"))
try {
  Expand-Archive -LiteralPath $Zip -DestinationPath $tmp -Force
  $root = $tmp
  $sub = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
  if ($sub) { $root = $sub.FullName }
  Copy-Item -Path (Join-Path $root "*") -Destination $Target -Recurse -Force
  Add-Content -LiteralPath $LogPath -Value ("[apply] ok " + (Get-Date -Format o))
} catch {
  Add-Content -LiteralPath $LogPath -Value ("[apply] fail " + $_.Exception.Message)
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
`;

async function fetchZip(zip) {
  if (isHttpSource(zip)) {
    const res = await fetch(zip, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`下载回 HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fsp.readFile(zip);
}

async function stageUpdate(zip) {
  const buffer = await fetchZip(zip);
  if (!buffer || buffer.length < 500) throw new Error("拿到的包是空的");
  const dir = updateDir();
  await fsp.mkdir(dir, { recursive: true });
  const staged = path.join(dir, "package.zip");
  await fsp.writeFile(staged, buffer);
  const script = path.join(dir, "apply-update.ps1");
  await fsp.writeFile(script, APPLY_SCRIPT, "utf8");
  return { staged, script, bytes: buffer.length, log: path.join(dir, "apply.log") };
}

function runDetached(script, args) {
  try {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    child.unref();
    return true;
  } catch (error) {
    console.warn("[dsh-balance-panel] 起不来更新脚本", error);
    return false;
  }
}

// ---- 价格表（元 / 百万 token，与 @dougen/dsh-deepseek-usage 的 DeepSeek 快照同源）----
const PRICES_CNY = {
  "deepseek-flash": {
    standard: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
    offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
  },
  "deepseek-v4-pro": {
    standard: { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 },
    offPeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 0, output: 13.5 },
  },
  "deepseek-chat": {
    standard: { input: 2, cacheRead: 0.5, cacheWrite: 0, output: 8 },
    offPeak: { input: 2, cacheRead: 0.5, cacheWrite: 0, output: 8 },
  },
  "deepseek-reasoner": {
    standard: { input: 4, cacheRead: 1, cacheWrite: 0, output: 16 },
    offPeak: { input: 4, cacheRead: 1, cacheWrite: 0, output: 16 },
  },
};

const MODEL_ALIAS = {
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
};

/** DeepSeek 的贵时段：工作日（北京时间）09:00–12:00、14:00–18:00。节假日没有算（会偏贵一点）。 */
function isPeak(now) {
  const t = new Date(now + 8 * 3600 * 1000);
  const day = t.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hours = t.getUTCHours() + t.getUTCMinutes() / 60;
  return (hours >= 9 && hours < 12) || (hours >= 14 && hours < 18);
}

/** 取该会话模型的单价；不认识就返回 null（前端显示「—」而不是 0）。 */
function priceFor(provider, model, now) {
  const id = MODEL_ALIAS[model] || model;
  const entry = PRICES_CNY[id];
  if (!entry) return null;
  if (provider && !String(provider).startsWith("deepseek")) return null;
  const peak = isPeak(now);
  const unit = peak || !entry.offPeak ? entry.standard : entry.offPeak;
  return { unit, currency: "CNY", peak };
}

/** 会话里用得最多的模型（按 token 数），用来决定「1M token 多少钱」按谁的价算。 */
function mostUsedModel(sessions) {
  const byModel = new Map();
  for (const s of sessions) {
    if (!s || !s.model) continue;
    byModel.set(s.model, (byModel.get(s.model) || 0) + (s.tokens ? s.tokens.total : 0));
  }
  let best = "";
  let bestTokens = -1;
  for (const [model, total] of byModel) {
    if (total > bestTokens) {
      best = model;
      bestTokens = total;
    }
  }
  return best;
}

/** 本地时间今天零点（epoch ms），用来切「今日」。 */
function dayStart(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 「今天」的日期键。DSH 在 contextActivity.days 里按日期分桶，
 * 主键看起来是本地日期；保险起见两个都备着，取文件里存在的那个。
 */
function todayKeys(now) {
  const pad = (n) => String(n).padStart(2, "0");
  const local = new Date(dayStart(now));
  const utc = new Date(now);
  return [
    `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`,
    `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`,
  ];
}

/** 按会话文件里记下的峰谷档（"peak" / "off"）取单价，而不是按「现在」这一刻的档。 */
function priceForTier(provider, model, tier) {
  const id = MODEL_ALIAS[model] || model;
  const entry = PRICES_CNY[id];
  if (!entry) return null;
  if (provider && !String(provider).startsWith("deepseek")) return null;
  const tag = String(tier || "").toLowerCase();
  const isOff = tag === "off" || tag === "offpeak" || tag === "off-peak" || tag === "valley";
  const unit = isOff ? (entry.offPeak || entry.standard) : entry.standard;
  return { unit, currency: "CNY", peak: !isOff };
}

/** 一份用量桶按单价折算成钱（元）。 */
function costOfBuckets(b, unit) {
  return (
    (Number(b.uncached) || 0) * unit.input +
    (Number(b.cacheRead) || 0) * unit.cacheRead +
    (Number(b.cacheWrite) || 0) * (unit.cacheWrite || 0) +
    (Number(b.output) || 0) * unit.output
  ) / 1e6;
}

/**
 * 下一个峰谷切换点（epoch ms）。工作日每天 09:00 / 12:00 / 14:00 / 18:00 各切一次，
 * 区间内档位不变，所以「最近的边界」就是切换时刻；周末没有切换，
 * 周五 18:00 之后直接跳到周一 09:00。
 */
function nextSwitchAt(now) {
  const BJ = 8 * 3600 * 1000;
  const d = new Date(now + BJ);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  for (let offset = 0; offset < 8; offset += 1) {
    const midnight = Date.UTC(year, month, day + offset);
    const weekday = new Date(midnight).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    for (const hour of [9, 12, 14, 18]) {
      const at = midnight + hour * 3600 * 1000 - BJ;
      if (at > now) return at;
    }
  }
  return null;
}

/** 卡片要的那块「一百万 token 多少钱 + 现在是峰还是谷 + 还有多久切换」。 */
function priceCard(modelHint, now) {
  const id = MODEL_ALIAS[modelHint] || modelHint;
  const resolved = PRICES_CNY[id] ? id : "deepseek-flash";
  const entry = PRICES_CNY[resolved];
  const peak = isPeak(now);
  const unit = peak ? entry.standard : (entry.offPeak || entry.standard);
  const at = nextSwitchAt(now);
  // 混合口径：输入 : 输出 = 3 : 1（日常写代码时缓存读另有单价，单独列）
  const blended = Math.round(((unit.input * 3 + unit.output) / 4) * 1000) / 1000;
  return {
    currency: "CNY",
    model: resolved,
    peak,
    tier: peak ? "peak" : "offPeak",
    unit: { ...unit },
    standard: { ...entry.standard },
    offPeak: { ...(entry.offPeak || entry.standard) },
    blendRatio: "3:1",
    perMillion: {
      input: unit.input,
      cacheRead: unit.cacheRead,
      cacheWrite: unit.cacheWrite,
      output: unit.output,
      blended,
    },
    nextSwitchAt: at,
    nextSwitchTo: at == null ? null : (isPeak(at) ? "peak" : "offPeak"),
    windows: "工作日 09:00–12:00、14:00–18:00（北京时间）",
  };
}

// ---- 会话扫描 -----------------------------------------------------------
/** file -> { mtimeMs, size, data } */
const fileCache = new Map();

const val = (rows, key) => (rows && rows[key] && rows[key].val !== undefined ? rows[key].val : undefined);

function parseSession(json, id, file) {
  const record = json && json.record ? json.record : {};
  const rows = record.rows || {};
  const title = (() => {
    const t = val(rows, "title");
    return typeof t === "string" && t.trim() !== "" ? t.trim() : "（未命名会话）";
  })();
  const totals = val(rows, "tokenUsage")?.totals || {};
  const stats = val(rows, "sessionStats") || {};
  const lastUsed = val(rows, "modelSelection")?.lastUsed || {};
  const boundary = val(rows, "turnBoundary") || {};
  const meta = val(rows, "sessionListMetadata") || {};
  const timeCtx = val(rows, "timeContext") || {};
  const pending = stats.pendingCalls && typeof stats.pendingCalls === "object"
    ? Object.keys(stats.pendingCalls).length
    : 0;
  const running = boundary.openTurnStartSeq != null || stats.openStep != null || pending > 0;

  // 子代理会话：rows.subagent.val.identity.mode === "continuable"。
  // 它们的用量已经算进父会话的累计里（同一笔钱），所以只计数、不进榜、不进合计，
  // 否则就正好重复一遍。（~/.dsh 里没有 parentSessionId 这种东西，别去那里找。）
  const subagent = val(rows, "subagent") || null;
  const subagentIdentity = subagent && typeof subagent === "object" ? subagent.identity : null;
  const isSubagent = Boolean(
    subagentIdentity && typeof subagentIdentity === "object" && subagentIdentity.mode === "continuable",
  );
  const subagentLabel = isSubagent && typeof subagentIdentity.label === "string" ? subagentIdentity.label : "";

  const tokens = {
    uncachedInput: Number(totals.uncachedInputTokens) || 0,
    cacheRead: Number(totals.cacheReadTokens) || 0,
    cacheWrite: Number(totals.cacheWriteTokens) || 0,
    output: Number(totals.outputTokens) || 0,
  };
  tokens.total = tokens.uncachedInput + tokens.cacheRead + tokens.cacheWrite + tokens.output;

  // DSH 自己按天记了用量：contextActivity.days["2026-10-29"].cost[provider][model][peak|off]
  // 这才是「今日」的正解——tokenUsage.totals 只有会话累计，跨天会被算重。
  const activity = val(rows, "contextActivity") || {};
  const rawDays = activity.days && typeof activity.days === "object" ? activity.days : {};
  const days = {};
  for (const [key, dayRaw] of Object.entries(rawDays)) {
    if (!dayRaw || typeof dayRaw !== "object") continue;
    const buckets = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    let cost = 0;
    let priced = false;
    const costMap = dayRaw.cost && typeof dayRaw.cost === "object" ? dayRaw.cost : {};
    for (const [dayProvider, models] of Object.entries(costMap)) {
      if (!models || typeof models !== "object") continue;
      for (const [dayModel, tiers] of Object.entries(models)) {
        if (!tiers || typeof tiers !== "object") continue;
        for (const [tier, b] of Object.entries(tiers)) {
          if (!b || typeof b !== "object") continue;
          buckets.uncached += Number(b.uncached) || 0;
          buckets.cacheRead += Number(b.cacheRead) || 0;
          buckets.cacheWrite += Number(b.cacheWrite) || 0;
          buckets.output += Number(b.output) || 0;
          const price = priceForTier(dayProvider, dayModel, tier);
          if (price) {
            cost += costOfBuckets(b, price.unit);
            priced = true;
          }
        }
      }
    }
    const sum = buckets.uncached + buckets.cacheRead + buckets.cacheWrite + buckets.output;
    days[key] = {
      tokens: sum || Number(dayRaw.tokens) || 0,
      cost: priced ? cost : null,
    };
  }

  return {
    id,
    file,
    title,
    cwd: (record.identity || {}).cwd || "",
    provider: typeof lastUsed.provider === "string" ? lastUsed.provider : "",
    model: typeof lastUsed.model === "string" ? lastUsed.model : "",
    tokens,
    turns: Number(stats.turns) || 0,
    steps: Number(stats.steps) || 0,
    llmMs: Number(stats.llmMs) || 0,
    toolMs: Number(stats.toolMs) || 0,
    lastAt: Number(meta.lastPromptAt) || Number(timeCtx.lastMessageTime) || 0,
    running,
    pendingCalls: pending,
    // 子代理会话：用量已在父会话里，界面上不单列，只用来统计条数
    isSubagent,
    subagentLabel,
    // 按天、按峰谷档的真实用量（DSH 自己记的），「今日」就从这里取
    days,
  };
}

async function listSessionFiles() {
  let names;
  try {
    names = await fsp.readdir(sessionsDir());
  } catch {
    return [];
  }
  return names.filter((n) => n.startsWith("session-") && n.endsWith(".json"));
}

/** 读一个会话文件，按 mtime+size 缓存；解析失败（正在写入）就沿用上一次的成功结果。 */
const inflight = new Map();

function readSession(id, file) {
  // 同一个文件可能被「开机预热」和「界面第一问」同时要，别读两遍
  const running = inflight.get(file);
  if (running) return running;
  const task = readSessionFile(id, file).finally(() => inflight.delete(file));
  inflight.set(file, task);
  return task;
}

async function readSessionFile(id, file) {
  const full = path.join(sessionsDir(), file);
  let stat;
  try {
    stat = await fsp.stat(full);
  } catch {
    return null;
  }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.data;
  let text;
  try {
    text = await fsp.readFile(full, "utf8");
  } catch {
    return hit ? hit.data : null;
  }
  let data;
  try {
    data = parseSession(JSON.parse(text), id, file);
  } catch {
    return hit ? hit.data : null;
  }
  fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, data });
  return data;
}

async function scanSessions(now) {
  const files = await listSessionFiles();
  const known = new Set(files);
  for (const key of fileCache.keys()) if (!known.has(key)) fileCache.delete(key);

  // 冷启动判据：缓存里的文件还不到一半，就按冷启动给大预算（否则要等好几轮 15 秒才凑对金额）。
  const cold = fileCache.size < files.length * 0.5;
  const budget = cold ? MAX_PARSE_COLD : MAX_PARSE_PER_POLL;
  const deadline = Date.now() + (cold ? COLD_SCAN_BUDGET_MS : SCAN_BUDGET_MS);

  // 按 mtime 从新到旧读：最近动过的会话总在前头，界面上先看到的就是「今天的钱」。
  const entries = [];
  for (const file of files) {
    let mtimeMs = 0;
    try {
      mtimeMs = (await fsp.stat(path.join(sessionsDir(), file))).mtimeMs;
    } catch {
      continue; // 文件正在被删/改名
    }
    entries.push({ file, mtimeMs });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const results = [];
  let parsed = 0;
  for (const { file } of entries) {
    const cached = fileCache.get(file);
    if (!cached) {
      if (parsed >= budget || Date.now() > deadline) continue;
      parsed += 1;
    }
    // DSH 的 SessionId 是带前缀的全名（session-8a48e310-…），跳转要用全名，别剥。
    const id = file.replace(/\.json$/, "");
    const data = await readSession(id, file);
    if (data) results.push(data);
  }

  // 子代理会话不单列：它们花掉的 token 已经包含在父会话的累计里，
  // 两边都加就是重复计钱（合计会虚高）。只留个条数给人看。
  const subagentCount = results.filter((s) => s.isSubagent).length;
  if (subagentCount > 0) {
    const own = results.filter((s) => !s.isSubagent);
    results.length = 0;
    results.push(...own);
  }

  const todayKeysWanted = todayKeys(now);
  for (const s of results) {
    // ① 优先用会话文件里的按天用量：真实、按当时的峰谷档计价
    const dayKeysInFile = s.days ? Object.keys(s.days) : [];
    let allDaysPriced = dayKeysInFile.length > 0;
    let sumCost = 0;
    for (const key of dayKeysInFile) {
      const day = s.days[key];
      if (!day || day.cost == null) {
        allDaysPriced = false;
        continue;
      }
      sumCost += day.cost;
    }
    const todayEntry = dayKeysInFile.length
      ? (todayKeysWanted.map((k) => s.days[k]).find(Boolean) || null)
      : null;

    if (allDaysPriced) {
      s.cost = sumCost;
      s.currency = "CNY";
      s.costBasis = "daily";
    } else {
      // ② 老会话/没有按天记账的，退回「累计 token × 当前档位」的估算
      const price = priceFor(s.provider, s.model, now);
      if (!price) {
        s.cost = null;
        s.currency = null;
        s.peak = null;
      } else {
        s.cost = costOfBuckets({
          uncached: s.tokens.uncachedInput,
          cacheRead: s.tokens.cacheRead,
          cacheWrite: s.tokens.cacheWrite,
          output: s.tokens.output,
        }, price.unit);
        s.currency = price.currency;
        s.peak = price.peak;
      }
      s.costBasis = "estimate";
    }

    // ③ 「今日」只认今天那一桶：跨天的会话不再整条计入
    if (dayKeysInFile.length) {
      s.todayTokens = todayEntry ? todayEntry.tokens : 0;
      s.todayCost = todayEntry ? (todayEntry.cost == null ? null : todayEntry.cost) : 0;
      s.todayBasis = "daily";
      // 按天加起来的总量（和按天加起来的钱对得上，比 totals 更一致）
      s.tokensByDay = dayKeysInFile.reduce((sum, key) => sum + ((s.days[key] && s.days[key].tokens) || 0), 0);
    } else {
      s.todayTokens = s.lastAt >= dayStart(now) ? s.tokens.total : 0;
      s.todayCost = s.lastAt >= dayStart(now) ? s.cost : null;
      s.todayBasis = "estimate";
      s.tokensByDay = null;
    }

    s.workMs = s.llmMs + s.toolMs;
  }

  // 空壳会话（建了没说过话：0 token、也没有最后活动时间）不进榜、不占位置
  for (let i = results.length - 1; i >= 0; i -= 1) {
    if (!results[i].tokens.total && !results[i].lastAt) results.splice(i, 1);
  }

  results.sort((a, b) => (b.cost || 0) - (a.cost || 0) || b.lastAt - a.lastAt);
  return {
    results,
    parsed,
    total: entries.length,
    loaded: fileCache.size,
    // 还有没读到的文件 → 合计金额还会变，界面上要标出来，并且快点再问一次
    partial: fileCache.size < entries.length,
    subagentCount,
  };
}

// ---- 余额 ---------------------------------------------------------------
let balanceCache = { at: 0, value: null };

async function readBalance(ctx) {
  const now = Date.now();
  if (balanceCache.value && now - balanceCache.at < BALANCE_TTL_MS) return balanceCache.value;

  const readRecord = ctx.credentials?.readRecord;
  if (typeof readRecord !== "function") {
    return { ok: false, error: "no-credential-service" };
  }
  let record;
  try {
    record = await readRecord.call(ctx.credentials, ACCOUNT_GRANT_KEY);
  } catch {
    return { ok: false, error: "no-grant" };
  }
  const token = typeof record?.payload?.token === "string" ? record.payload.token.trim() : "";
  if (token === "") return { ok: false, error: "no-grant" };

  let body;
  try {
    const res = await fetch(BALANCE_URL, {
      headers: { "x-dsh-auth-token": token, accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, error: `http-${res.status}` };
    body = await res.json();
  } catch {
    return { ok: false, error: "network" };
  }

  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  const info = infos.find((i) => i && i.total_balance != null) || infos[0];
  if (!info) return { ok: false, error: "no-balance" };
  const value = {
    ok: true,
    total: Number(info.total_balance) || 0,
    granted: Number(info.granted_balance) || 0,
    toppedUp: Number(info.topped_up_balance) || 0,
    currency: typeof info.currency === "string" ? info.currency : "CNY",
    available: body?.is_available !== false,
    at: now,
  };
  balanceCache = { at: now, value };
  return value;
}

// ---- 路由 ---------------------------------------------------------------
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function isLocalRequest(req, bindHost) {
  const host = String(req.headers.host || "");
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (bindHost && host === bindHost) return true;
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

// ---- 「烦不烦」：借她那套 TTS（肥鱼音色）念一句 ---------------------------
// 本机的 TTS shim 是 OpenAI 形状的 /v1/audio/speech（E:\GPT\GSVI\shim，默认 9883 →
// 9890 的肥鱼声音服务，CosyVoice3 + RVC）。念过的存内存，第二下就秒回。
const SAY_ROUTE = "/api/balance-panel/say";
const SAY_DEFAULT_URL = "http://127.0.0.1:9883/v1/audio/speech";
const SAY_CACHE = new Map();

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function synthesize(url, voice, text, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer feiyu" },
      body: JSON.stringify({ model: voice, voice, input: text, response_format: "wav" }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`tts ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1000) throw new Error("tts empty");
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

// 她自己的声音服务（E:\FeiyuVoice，CosyVoice3 + RVC，开机自启在 9890）。
// 它是异步任务形状：POST /v1/speech 拿 job id → 轮询 /v1/jobs/{id} → /audio 取 wav。
// 我们直接打它，不依赖 9883 那个 python shim（那个要手动起，没起就只剩机械音）。
const FEIYU_BASE_DEFAULT = "http://127.0.0.1:9890";
const FEIYU_KEY_DEFAULT = "eEzIYd6pCZBFm9aUAB4oftZq_rAwcneEzkO5cNorGFM";

async function feiyuSpeak(text, options) {
  const base = String(options.base || FEIYU_BASE_DEFAULT).replace(/\/+$/, "");
  const headers = {
    "content-type": "application/json; charset=utf-8",
    authorization: `Bearer ${options.key || FEIYU_KEY_DEFAULT}`,
  };
  const deadline = Date.now() + (options.timeoutMs || SAY_TIMEOUT_DEFAULT);
  const speak = await fetch(`${base}/v1/speech`, {
    method: "POST",
    headers,
    body: JSON.stringify({ voice: options.voice || "feiyu", text, style: options.style || "cute" }),
  });
  if (!speak.ok) throw new Error(`feiyu speech ${speak.status}`);
  const job = await speak.json().catch(() => ({}));
  const jobId = job && job.id;
  if (!jobId) throw new Error("feiyu 没给 job id");
  const pollMs = Number(options.pollMs) || 700;
  while (Date.now() < deadline) {
    const stateResp = await fetch(`${base}/v1/jobs/${jobId}`, { headers });
    const state = await stateResp.json().catch(() => ({}));
    const status = String((state && state.status) || "").toLowerCase();
    if (status === "success" || status === "succeeded" || status === "done" || status === "completed") {
      const audioResp = await fetch(`${base}/v1/jobs/${jobId}/audio`, { headers });
      if (!audioResp.ok) throw new Error(`feiyu audio ${audioResp.status}`);
      const buffer = Buffer.from(await audioResp.arrayBuffer());
      if (buffer.length < 1000) throw new Error("feiyu 回了个空文件");
      return buffer;
    }
    if (status === "failed" || status === "error" || status === "cancelled") {
      throw new Error(`feiyu job ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error("feiyu 合成超时");
}

// 合成好的三句话存成 wav 落在磁盘上（DSH_HOME/balance-panel-say），重启也还在，
// 之后就是「读文件直接回」，既不排队也不怕她那台 TTS 忙。
const SAY_FILE_ROUTE = "/api/balance-panel/sayfile";
// 按钮上那三句：宿主一启动就先合成好存盘，界面加载出来就能直接放
const SAY_PRESET_LINES = ["烦不烦", "你很无聊吗", "变态"];
// 冷启动那一单要等模型加载（实测 35s 起），再叠上排队；60s 根本不够，
// 一到点就 502，前端只好退回「咚」。给足三分钟。
const SAY_TIMEOUT_DEFAULT = 180000;
// 同一句话同时来几次就只合成一次，别把她的队列灌爆
const SAY_INFLIGHT = new Map();

function sayDir() {
  return path.join(dshHome(), "balance-panel-say");
}

function sayFileName(voice, style, text) {
  const hash = createHash("sha1").update(`${voice}|${style}|${text}`).digest("hex").slice(0, 16);
  return `${hash}.wav`;
}

// 随包携带的那三句话：<插件目录>/assets/<同名>.wav。
// 别的机器上没有肥鱼服务时，就读这里——纯文件，不联网、不需要 TTS。
function sayAssetsDir() {
  return path.join(PLUGIN_ROOT, "assets");
}

function sayCandidates(voice, style, text) {
  const name = sayFileName(voice, style, text);
  return [path.join(sayAssetsDir(), name), path.join(sayDir(), name)];
}

// 本机已经合成过、但还没进包里的：启动时顺手拷进 assets，方便之后打包带走。
async function adoptIntoAssets(voice, style, text) {
  const name = sayFileName(voice, style, text);
  const asset = path.join(sayAssetsDir(), name);
  try {
    await fsp.access(asset);
    return asset;
  } catch {
    // 包里还没有，看看本机合成过没有
  }
  try {
    const buffer = await fsp.readFile(path.join(sayDir(), name));
    await fsp.mkdir(sayAssetsDir(), { recursive: true });
    await fsp.writeFile(asset, buffer);
    console.info(`[dsh-balance-panel] 「${text}」已收进包里：${asset}`);
    return asset;
  } catch {
    return null;
  }
}

// 从 profile 的 package.json 里把本插件摘干净（bundles + dependencies），
// 再把 node_modules 里自己那份删掉。文件是在后台删的：先把响应回给界面再说。
async function stripFromProfiles() {
  const root = path.join(dshHome(), "profiles");
  const touched = [];
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return touched;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const file = path.join(dir, "package.json");
    let doc;
    try {
      doc = JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
      continue;
    }
    let changed = false;
    const bundles = doc && doc.dsh && doc.dsh.profile && doc.dsh.profile.bundles;
    if (Array.isArray(bundles)) {
      const next = bundles.filter((item) => item !== name);
      if (next.length !== bundles.length) {
        doc.dsh.profile.bundles = next;
        changed = true;
      }
    }
    if (doc && doc.dependencies && typeof doc.dependencies === "object" && name in doc.dependencies) {
      delete doc.dependencies[name];
      changed = true;
    }
    if (!changed) continue;
    try {
      await fsp.writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
      touched.push(file);
    } catch (error) {
      console.warn("[dsh-balance-panel] profile 改不动", file, error);
      continue;
    }
    setTimeout(() => {
      fsp.rm(path.join(dir, "node_modules", name), { recursive: true, force: true }).catch(() => {});
    }, 1200);
  }
  return touched;
}

async function synthesizeAny(text, options) {
  const timeoutMs = options.timeoutMs || SAY_TIMEOUT_DEFAULT;
  const attempts = [
    () => feiyuSpeak(text, {
      base: options.base,
      key: options.key,
      voice: options.voice,
      style: options.style,
      timeoutMs,
    }),
    () => synthesize(options.shimUrl || SAY_DEFAULT_URL, options.voice, text, timeoutMs),
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const buffer = await attempt();
      if (buffer) return buffer;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("没有可用的 TTS");
}

function apply(ctx) {
  const bindHost = typeof ctx.webServer?.host === "string" ? ctx.webServer.host : "";
  let config = {};
  try {
    if (ctx.config && typeof ctx.config === "object") config = ctx.config;
  } catch {
    config = {};
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      handler: async (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return sendJson(res, 405, { ok: false, error: "method" });
        }
        if (!isLocalRequest(req, bindHost)) {
          return sendJson(res, 403, { ok: false, error: "forbidden" });
        }
        const now = Date.now();
        try {
          const [scan, balance] = await Promise.all([
            scanSessions(now),
            readBalance(ctx).catch(() => ({ ok: false, error: "failed" })),
          ]);
          const sessions = scan.results;
          const running = sessions.filter((s) => s.running);
          let costTotal = 0;
          let tokenTotal = 0;
          let todayCost = 0;
          let todayTokens = 0;
          let apiCost = 0;
          let apiTokens = 0;
          for (const s of sessions) {
            costTotal += s.cost || 0;
            tokenTotal += s.tokensByDay != null ? s.tokensByDay : s.tokens.total;
            // 今日＝会话文件里今天那一桶的用量（跨天的会话只算今天那部分）
            todayCost += s.todayCost || 0;
            todayTokens += s.todayTokens || 0;
            // 只有按官方价目算出来的（DeepSeek 的模型）才计入「API 花费」，本地模型算 0
            if (s.cost != null) {
              apiCost += s.cost;
              apiTokens += s.tokens.total;
            }
          }
          const prefs = await readPrefs();
          sendJson(res, 200, {
            ok: true,
            updatedAt: now,
            // 设置页里的开关：关掉之后界面上这张卡片直接不画
            hidden: prefs.hidden === true,
            peak: isPeak(now),
            pricing: priceCard(mostUsedModel(sessions), now),
            balance,
            totals: {
              cost: costTotal,
              tokens: tokenTotal,
              sessions: sessions.length,
              running: running.length,
              todayCost,
              todayTokens,
              apiCost,
              apiTokens,
              // 还差多少没读到：刚开机那几秒界面会显示「载入 61/82」，读完就消失
              partial: scan.partial,
              loaded: scan.loaded,
              total: scan.total,
            },
            running: running.map((s) => ({ id: s.id, title: s.title, lastAt: s.lastAt, workMs: s.workMs, turns: s.turns })),
            sessions: sessions.map((s) => ({
              id: s.id,
              title: s.title,
              cwd: s.cwd,
              provider: s.provider,
              model: s.model,
              tokens: s.tokens,
              cost: s.cost,
              currency: s.currency,
              turns: s.turns,
              steps: s.steps,
              workMs: s.workMs,
              llmMs: s.llmMs,
              toolMs: s.toolMs,
              lastAt: s.lastAt,
              running: s.running,
              // 今日口径：会话文件里今天那一桶（DSH 自己按天记的），跨天不再整条算进来
              todayCost: s.todayCost,
              todayTokens: s.todayTokens,
              costBasis: s.costBasis,
              todayBasis: s.todayBasis,
            })),
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: "scan-failed", message: String(error && error.message || error) });
        }
      },
    }),
    "dsh-balance-panel: usage route",
  );

  // 解压按钮的台词：POST {text} → 回一段 wav（肥鱼音色）。
  // 先打 9890 她的声音服务本体，再退 9883 的 shim；合成过的落到磁盘，重启也在。
  try {
    ctx.effect(
      () => ctx.webServer.register({
        kind: "exact",
        path: SAY_ROUTE,
        handler: async (req, res) => {
          if (req.method !== "POST") {
            return sendJson(res, 405, { ok: false, error: "method" });
          }
          if (!isLocalRequest(req, bindHost)) {
            return sendJson(res, 403, { ok: false, error: "forbidden" });
          }
          try {
            const raw = await readBody(req);
            const payload = JSON.parse(raw || "{}");
            const text = String(payload.text || "烦不烦").slice(0, 120);
            const voice = String(payload.voice || config.feiyuVoice || "feiyu");
            const style = String(payload.style || config.feiyuStyle || "cute");
            const timeoutMs = Number(config.feiyuTimeoutMs) || 60000;
            const key = `${voice}|${style}|${text}`;
            let audio = SAY_CACHE.get(key);
            if (!audio) {
              audio = await synthesizeAny(text, {
                base: config.feiyuBase,
                key: config.feiyuKey,
                voice,
                style,
                timeoutMs,
                shimUrl: config.feiyuUrl,
              });
              if (SAY_CACHE.size > 32) SAY_CACHE.clear();
              SAY_CACHE.set(key, audio);
            }
            res.writeHead(200, {
              "content-type": "audio/wav",
              "cache-control": "no-store",
              "content-length": audio.length,
            });
            res.end(audio);
          } catch (error) {
            sendJson(res, 502, {
              ok: false,
              error: "tts-failed",
              message: String((error && error.message) || error),
            });
          }
        },
      }),
      "dsh-balance-panel: say route",
    );

    // GET /api/balance-panel/say/file?text=… → 直接回磁盘上那只 wav（没有就现合成一次再存）。
    // 前端按这个地址取，浏览器也能自己缓存，点下去就是立刻出声。
    ctx.effect(
      () => ctx.webServer.register({
        kind: "exact",
        path: SAY_FILE_ROUTE,
        handler: async (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            return sendJson(res, 405, { ok: false, error: "method" });
          }
          if (!isLocalRequest(req, bindHost)) {
            return sendJson(res, 403, { ok: false, error: "forbidden" });
          }
          try {
            const url = new URL(req.url || "/", "http://127.0.0.1");
            const text = String(url.searchParams.get("text") || "").trim().slice(0, 120);
            if (!text) return sendJson(res, 400, { ok: false, error: "empty-text" });
            const voice = String(url.searchParams.get("voice") || config.feiyuVoice || "feiyu");
            const style = String(url.searchParams.get("style") || config.feiyuStyle || "cute");
            const candidates = sayCandidates(voice, style, text);
            const file = candidates[candidates.length - 1];
            let audio = SAY_CACHE.get(file);
            if (!audio) {
              // 先看包里带的 assets（别的机器就靠它），再看本机合成过的缓存
              for (const candidate of candidates) {
                try {
                  audio = await fsp.readFile(candidate);
                  break;
                } catch {
                  audio = null;
                }
              }
            }
            if (!audio) {
              let job = SAY_INFLIGHT.get(file);
              if (!job) {
                job = (async () => {
                  const buffer = await synthesizeAny(text, {
                    base: config.feiyuBase,
                    key: config.feiyuKey,
                    voice,
                    style,
                    timeoutMs: Number(config.feiyuTimeoutMs) || SAY_TIMEOUT_DEFAULT,
                    shimUrl: config.feiyuUrl,
                  });
                  try {
                    await fsp.mkdir(sayDir(), { recursive: true });
                    await fsp.writeFile(file, buffer);
                  } catch (error) {
                    console.warn("[dsh-balance-panel] 声音没存下来，下次还得再合成", error);
                  }
                  return buffer;
                })().finally(() => SAY_INFLIGHT.delete(file));
                SAY_INFLIGHT.set(file, job);
              }
              audio = await job;
            }
            if (SAY_CACHE.size > 32) SAY_CACHE.clear();
            SAY_CACHE.set(file, audio);
            res.writeHead(200, {
              "content-type": "audio/wav",
              "cache-control": "public, max-age=604800",
              "content-length": audio.length,
            });
            res.end(audio);
          } catch (error) {
            sendJson(res, 502, {
              ok: false,
              error: "tts-failed",
              message: String((error && error.message) || error),
            });
          }
        },
      }),
      "dsh-balance-panel: say file route",
    );
  } catch (error) {
    console.warn("[dsh-balance-panel] say 路由没挂上（按钮会退回系统语音）", error);
  }

  // 设置页那两件事：开关（存在 DSH_HOME\dsh-balance-panel.json）与一键卸载
  try {
    ctx.effect(
      () => ctx.webServer.register({
        kind: "exact",
        path: PREFS_ROUTE,
        handler: async (req, res) => {
          if (!isLocalRequest(req, bindHost)) {
            return sendJson(res, 403, { ok: false, error: "forbidden" });
          }
          try {
            if (req.method === "GET" || req.method === "HEAD") {
              const prefs = await readPrefs();
              return sendJson(res, 200, {
                ok: true,
                hidden: prefs.hidden === true,
                version: VERSION,
                dir: PLUGIN_ROOT,
                prefsFile: prefsPath(),
                updateSource: typeof prefs.updateSource === "string" ? prefs.updateSource : "",
                autoUpdate: prefs.autoUpdate === true,
                autoInstall: prefs.autoInstall === true,
                githubProxy: typeof prefs.githubProxy === "string" ? prefs.githubProxy : "",
              });
            }
            if (req.method === "POST") {
              const raw = await readBody(req, 4096);
              const body = JSON.parse(raw || "{}");
              const patch = {};
              if ("hidden" in body) patch.hidden = body.hidden === true;
              if ("updateSource" in body) patch.updateSource = String(body.updateSource || "").trim();
              if ("autoUpdate" in body) patch.autoUpdate = body.autoUpdate === true;
              if ("autoInstall" in body) patch.autoInstall = body.autoInstall === true;
              if ("githubProxy" in body) patch.githubProxy = String(body.githubProxy || "").trim();
              const prefs = await writePrefs(patch);
              return sendJson(res, 200, {
                ok: true,
                hidden: prefs.hidden === true,
                updateSource: typeof prefs.updateSource === "string" ? prefs.updateSource : "",
                autoUpdate: prefs.autoUpdate === true,
                autoInstall: prefs.autoInstall === true,
                githubProxy: typeof prefs.githubProxy === "string" ? prefs.githubProxy : "",
                version: VERSION,
              });
            }
            return sendJson(res, 405, { ok: false, error: "method" });
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: "prefs-failed", message: String((error && error.message) || error) });
          }
        },
      }),
      "dsh-balance-panel: prefs route",
    );

    ctx.effect(
      () => ctx.webServer.register({
        kind: "exact",
        path: UNINSTALL_ROUTE,
        handler: async (req, res) => {
          if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method" });
          if (!isLocalRequest(req, bindHost)) return sendJson(res, 403, { ok: false, error: "forbidden" });
          try {
            const touched = await stripFromProfiles();
            console.info("[dsh-balance-panel] 已从 profile 摘掉，重启 DSH 后彻底消失", touched);
            return sendJson(res, 200, { ok: true, touched, needRestart: true });
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: "uninstall-failed", message: String((error && error.message) || error) });
          }
        },
      }),
      "dsh-balance-panel: uninstall route",
    );

    // 更新：GET ?check=1 查一下有没有新版；POST 把包放到盘上、起后台脚本覆盖，然后请人重启
    ctx.effect(
      () => ctx.webServer.register({
        kind: "exact",
        path: UPDATE_ROUTE,
        handler: async (req, res) => {
          if (!isLocalRequest(req, bindHost)) return sendJson(res, 403, { ok: false, error: "forbidden" });
          if (req.method === "GET") {
            const url = new URL(req.url || "", "http://127.0.0.1");
            const prefs = await readPrefs();
            const source = url.searchParams.get("source") || prefs.updateSource || "";
            const probe = await probeUpdate(source, prefs);
            return sendJson(res, 200, { ...probe, target: PLUGIN_ROOT });
          }
          if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method" });
          let payload = {};
          try {
            payload = JSON.parse((await readBody(req)) || "{}");
          } catch {
            return sendJson(res, 400, { ok: false, error: "bad-json" });
          }
          if (payload.action !== "install") return sendJson(res, 400, { ok: false, error: "unknown-action" });
          const prefs = await readPrefs();
          const source = String(payload.source || prefs.updateSource || "").trim();
          const probe = payload.zip ? { ok: true, zip: String(payload.zip) } : await probeUpdate(source, prefs);
          if (!probe.ok) return sendJson(res, 400, { ok: false, error: probe.error || "no-source" });
          try {
            const staged = await stageUpdate(probe.zip);
            const started = runDetached(staged.script, [staged.staged, PLUGIN_ROOT, staged.log]);
            // 记下装的是哪个 commit / 版本：下次「盯分支」时才分得清有没有新东西
            if (probe.sha) await writePrefs({ installedSha: String(probe.sha) });
            console.info("[dsh-balance-panel] 更新包已就位", staged.staged, staged.bytes, started ? "脚本已起" : "脚本没起");
            return sendJson(res, 200, {
              ok: true,
              staged: staged.staged,
              log: staged.log,
              bytes: staged.bytes,
              started,
              from: VERSION,
              latest: probe.latest || "",
              kind: probe.kind || "",
              needRestart: true,
            });
          } catch (error) {
            return sendJson(res, 500, {
              ok: false,
              error: "update-failed",
              message: String((error && error.message) || error),
            });
          }
        },
      }),
      "dsh-balance-panel: update route",
    );
  } catch (error) {
    console.warn("[dsh-balance-panel] 设置页路由没挂上", error);
  }

  // 开机就把会话先读一遍（异步、不挡路），侧栏第一次画出来就是齐的金额，
  // 不用用户点好几次去「催」。
  ctx.effect(() => {
    const timer = setTimeout(() => {
      if (fileCache.size === 0) scanSessions(Date.now()).catch(() => {});
    }, 1200);
    return () => clearTimeout(timer);
  }, "dsh-balance-panel: warm cache");

  // 自动更新：开了「自动检查」就每 6 小时去更新源问一次；再开了「自动安装」，
  // 有新东西就直接下下来覆盖（DSH 下次启动生效），不用点任何按钮。
  ctx.effect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const prefs = await readPrefs();
        const source = String(prefs.updateSource || "").trim();
        if (prefs.autoUpdate !== true || !source) return;
        const probe = await probeUpdate(source, prefs);
        if (!probe || !probe.ok) {
          console.warn("[dsh-balance-panel] 自动检查更新没成", probe && probe.error);
          return;
        }
        if (!probe.needsUpdate) return;
        if (prefs.autoInstall === true) {
          const staged = await stageUpdate(probe.zip);
          runDetached(staged.script, [staged.staged, PLUGIN_ROOT, staged.log]);
          if (probe.sha) await writePrefs({ installedSha: String(probe.sha) });
          console.info(`[dsh-balance-panel] 已自动装上 ${probe.latest}（原 ${VERSION}），重启 DSH 生效`, staged.staged);
        } else {
          console.info(`[dsh-balance-panel] 有新版本 ${probe.latest}（当前 ${VERSION}），去设置里点「安装并重启」`);
        }
      } catch (error) {
        console.warn("[dsh-balance-panel] 自动检查更新出错", error);
      }
    };
    const first = setTimeout(tick, 20000);
    const every = setInterval(tick, 6 * 60 * 60 * 1000);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(every);
    };
  }, "dsh-balance-panel: auto update");

  // 那三句话也先合成好落到磁盘：之后点按钮就是纯读文件，不排队、不怕 TTS 忙。
  // （合成不成功就等界面来要的时候再试，不挡启动。）
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      const voice = String(config.feiyuVoice || "feiyu");
      const style = String(config.feiyuStyle || "cute");
      for (const text of SAY_PRESET_LINES) {
        const file = path.join(sayDir(), sayFileName(voice, style, text));
        // 包里已经有就直接用；本机合成过但包里没有的，顺手收进 assets（下次打包就带走了）
        const adopted = await adoptIntoAssets(voice, style, text);
        if (adopted) continue;
        try {
          await fsp.access(file);
          continue;
        } catch {
          // 没有就往下合成
        }
        try {
          const audio = await synthesizeAny(text, {
            base: config.feiyuBase,
            key: config.feiyuKey,
            voice,
            style,
            timeoutMs: Number(config.feiyuTimeoutMs) || SAY_TIMEOUT_DEFAULT,
            shimUrl: config.feiyuUrl,
          });
          await fsp.mkdir(sayDir(), { recursive: true });
          await fsp.writeFile(file, audio);
          await adoptIntoAssets(voice, style, text).catch(() => null);
          console.info(`[dsh-balance-panel] 「${text}」已经合成好了：${file}`);
        } catch (error) {
          console.warn(`[dsh-balance-panel] 预先合成「${text}」没成`, error);
        }
      }
    }, 2500);
    return () => clearTimeout(timer);
  }, "dsh-balance-panel: preset say");
}

export { name, inject, apply };
