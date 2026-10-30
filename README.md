# 更好的显示（dsh-balance-panel）

DSH 侧边栏的余额 / 花费小面板。卡片落在**左侧栏最底部**，常显余额，鼠标悬浮看谁在跑，点一下看每条会话花了多少钱。

> 包名（`dsh-balance-panel`）是给 DSH 加载用的标识，不要改；显示名、文档、界面上叫「更好的显示」。
>
> **给别人装 → 看 [INSTALL.md](./INSTALL.md)**：放哪个目录、profile 里怎么登记、怎么验证、出问题怎么查，全在那份里。
>
> **改了哪些东西 → 看 [CHANGELOG.md](./CHANGELOG.md)**。

## 它显示什么

| 位置 | 内容 |
| --- | --- |
| 卡片（常显） | 3×2 六格：实时余额 / 今日花费 / 今日 token / 总消耗 / 在跑会话 + 解压按钮 / 峰谷与倒计时；收起态只有 `¥数字` |
| 悬浮 | 每格各弹各的：余额格给账户余额与档位，今日两格给今日拆分，总消耗格给总量与输入·缓存·输出，**在跑格弹会话名单**（标题 + 已跑多久，悬停 3 秒常驻、点行跳转），峰谷格给价目与时段 |
| 点击 | 浮层列表，每条会话一行：`工作区` + 标题 / **花费 + 今日 ¥x** / 工作区·模型·总 token（入·缓·出）/ 最后运行时间 + 耗时；底部是今日排行榜、价目一行小字、合计与刷新 |
| 设置 → 集成 → 更好的显示 | 一个开关（关掉后侧栏那张卡不画）+ 一键卸载（从 profile 的 bundles / dependencies 摘掉并删除插件目录，重启后彻底消失）；另有版本、插件目录、开关文件三个路径信息 |

开关状态存在 `<DSH_HOME>\dsh-balance-panel.json`（`{"hidden":true}`），**一按就生效**：设置页存完立刻广播一个 `dsh-balance-panel:visibility` 事件，卡片当场隐掉或回来，不等 15 秒轮询，也不用重启。卸载是**两次点击**确认后才动手，且真正删目录是在响应返回之后后台做的。

明细按**最后活动时间**排（最近用过的在上），一屏看得见 4 行、其余滚动。数据 15 秒自动刷一次，点开卡片会立刻再取一次。
**倒计时不等心跳**：切换时刻由宿主算好（`pricing.nextSwitchAt`），前端用本地时钟每秒走一格。

## 峰谷与「一百万 token 多少钱」

- 档位：**高峰 = 北京时间周一至周五 09:00–12:00、14:00–18:00（不含法定节假日）**；其余时间全是空闲时段（夜间、午休、周末、节假日），价格刚好是高峰的五折。峰谷是 2:1 的关系，所以档位认错了金额就会差一倍——这就是为什么历史金额一律按会话文件里记下的档位算，而不是按「现在这一刻」。
- 每 100 万 token 的价钱按**当前档位** × **你这堆会话里用得最多的那个模型**（宿主 `mostUsedModel()`；一个模型都没用到时退回 `deepseek-flash`）算，给四种口径：输入、输出、缓存命中，以及「混合 3:1」的粗口径（3 份输入 + 1 份输出）。
- 倒计时显示「距离下一次切换还有多久」，并写明是转峰价还是转谷价。工作日一天切四次（09:00 转峰、12:00 转谷、14:00 转峰、18:00 转谷），所以周五 18:00 之后的下一次切换是**下周一 09:00**。

## 数据从哪来

宿主侧 `lib/index.js` 注册了一个只读路由 `GET /api/balance-panel`，只接受本机请求：

- **余额**：凭证服务里 DSH 登录留下的 DeepSeek grant（键 `deepseek-account-platform/default`，令牌在 `payload.token`），带 `x-dsh-auth-token` 请求头打 `https://api.deepseek.com/user/balance`，结果缓存 30 秒。
- **会话**：`<DSH_HOME>/storages/session_projcache/sessions/session-*.json`。每个文件是 DSH 的会话快照，取 `record.rows.tokenUsage.val.totals`、`record.rows.sessionStats.val`、`record.rows.modelSelection.val.lastUsed`、`record.rows.turnBoundary.val.openTurnStartSeq`、`record.rows.sessionListMetadata.val.lastPromptAt`。
- **「在跑」**：有未收尾的 turn、有未完成的 step、或有挂起的工具调用。
- **每条会话的「今日」**：`session.todayCost` / `session.todayTokens`，取自会话文件里 `contextActivity.days[今天]` 那一桶——跨天的会话只算今天那部分。今天没动过的会话 `todayCost` 为 `0`（不出现在排行榜里），面板上显示「今日 —」的是拿不到这一桶的老会话。

## 点一条会话就跳过去

明细浮层里每一行都可以点。点击调 `ctx.uiWorkspace.openSession(sessionId)`——这是 DSH 官方「切到某个会话」的客户端入口（宿主文档里签名是 `openSession(target: SessionTarget)`，会同步替换主区域并回到 Conversation）。

`sessionId` 必须是**带前缀的全名**（`session-8a48e310-…`）。早先宿主侧为了好看把 `session-` 剥掉了，结果传进去的 id 谁都不认识，`openSession` 就静默不动作——现在 `lib/index.js` 里保留完整文件名。

宿主自己点会话行之前会先过一遍 `sessionLinkState(id, sessions, workspaces)`（工作区注册表 error / 已归档 / 不在当前列表 → 不切）。插件照抄了一份：判成「不能直接切」时，改成在侧栏 DOM 里找到同标题的那一行 `.click()`（等于用户手点，跨工作区也管用），并且**跳过自己的浮层**（卡片本身就长在侧栏里）。

点了行以后，浮层底部会显示回执（`已跳转（dom）` / `跳转失败：会话列表里还没有它（session-…）`），不用开控制台也能知道发生了什么。

为了不让插件因为缺服务而整个加载失败，`uiWorkspace` **没有写进 `exports.inject`**，而是在 `apply` 里用 `ctx.inject(["uiWorkspace"], …)` 等它就绪；`sessions` / `workspaces` 单独再 inject 一次，只用来查状态，拿不到也不影响卡片。

## 今日排行榜

明细浮层底部那块原来是价目标，现在是**今日排行榜**：

- 按每条会话「今天花的钱」降序，列**全部**今日有消耗的会话；一屏看得见 3 行，其余滚动（不是只取前几条）。
- 条形长度相对第一名画，第一名橙色、其余灰。
- 金额和 token 每 **4 秒**刷新一次（浮层开着才轮询，关掉就停），边聊边看它涨。
- 每行都能点，点了跳到那条会话（跟上面明细行同一套 `openSessionTo`，回执在页脚）。
- 判据跟第四格一致：取 `contextActivity.days[今天]` 的钱数，跨天的会话只算今天那部分。
- 完整价目压成底部一行小字，详细档位仍在第六格的悬浮提示里。

## 按一下会响的那个「咚」

第五格右半是解压按钮，按一下两件事一起发生：

1. **「咚」**：Web Audio 现合成（triangle 波），每按一下升半个音阶、五下绕回，不依赖任何音频文件。
2. **一句话**：「烦不烦 / 你很无聊吗 / 变态」三句随机（不连说同一句），用本机**肥鱼**音色念。

音色走本机 `feiyu_voice_service`：`POST http://127.0.0.1:9890/v1/speech`（`Authorization: Bearer <key>`）→ 轮询 `/v1/jobs/{id}` → `GET /v1/jobs/{id}/audio`；9883 那个 OpenAI 形状的 shim 只作后备。合成结果**落盘缓存**在 `<DSH_HOME>/balance-panel-say/<sha1(voice|style|text) 前16位>.wav`，宿主启动后 2.5 秒会自动把三句补齐——之后点按钮就是纯读文件，重启也不丢。

想换词或换声音，直接覆盖那只 wav 就行（文件名对得上即生效）。服务没起时会安静跳过，只响「咚」，不退回机械的系统语音。

**彩蛋**：45 秒的滑动窗口里按够 **50 下**（`EGG_PRESS_COUNT` / `EGG_WINDOW_MS`，嫌多嫌少改这两个数），界面会自己 `location.reload()` 重开一次（先盖一层「……行吧，我重开一下」）。注意这重开的是**渲染层**，不是 DSH 进程；真要重启进程得宿主侧 spawn + exit，没做。

路由：`GET /api/balance-panel/sayfile?text=…`（注意**不是** `/say/file`，那样会被 `/api/balance-panel/say` 的前缀截走）。

## 刚开机那一两秒

宿主侧缓存是空的，得现读 `sessions/*.json`（几十个文件）。所以：

- **冷启动一口气读完**（`MAX_PARSE_COLD` = 400 个 / 单次最多 2.5 秒），平时每次只补 24 个新文件（`MAX_PARSE_PER_POLL`），不挡宿主的事件循环。
- 读的时候按 **mtime 从新到旧**，最近动过的会话最先出来——「今天的钱」一开始就是对的。
- 插件加载后 1.2 秒会自己在后台把会话读一遍（热身），侧栏第一次画出来通常已经齐了。
- 还没读齐时，第四格（总消耗）的标签会显示 `载入 61/82`，前端改成每 1.2 秒补问一次（最多 20 次），齐了回到 15 秒心跳。**不用再点好几次去催。**

## 花费怎么算的

**按天记账，不猜。** 每个会话文件里有 `contextActivity.val.days`，DSH 自己按日期分好了桶，还顺手记下了当时的峰谷档：

```json
days["2026-10-29"].cost["deepseek-account"]["deepseek-flash"]["off"] =
  { uncached: 274891, cacheRead: 8818048, cacheWrite: 0, output: 114726 }
```

所以：

- **每条会话的「今日」= 今天那一桶**（`days[今天]`），跨天的会话只算今天那部分，不再整条计入；今天没动过的会话 `todayCost` 是 `0`（榜单里不出现）。
- **每一桶按它自己那一档折价**：`"peak"` 用标准价、`"off"` 用谷价，所以昨天在峰价时段烧的量不会被按今天的谷价重算。
- 会话的累计花费＝它所有按天桶之和（`costBasis: "daily"`）。

只有**没有按天记账的老会话**才退回估算：该会话最后用的模型 × 累计 token × 标准价与谷价的中间值（`costBasis: "estimate"`）。价目表：

- `deepseek-flash`：高峰 `入 2 / 缓存读 0.04 / 写出 0 / 出 8`，空闲 `1 / 0.02 / 0 / 4`
- `deepseek-v4-pro`：高峰 `9 / 0.3 / 0 / 27`，空闲 `4.5 / 0.15 / 0 / 13.5`
- `deepseek-chat`：`2 / 0.5 / 0 / 8`（已下线，只给老会话认）
- `deepseek-reasoner`：`4 / 1 / 0 / 16`（已下线，只给老会话认）

峰价＝工作日两段高峰，其余全是谷价；价目核对日期 2026-10-30，来源是[官方价目表](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。会话文件里有按天按档记的桶（`contextActivity.days[*].cost[provider][model]["peak"|"off"]`），所以历史金额是按各自当时的档位折出来的，不会因为「现在几点」而变。只有没有这份按天记账的老会话才退回估算，且估算用的是「标准价与谷价的中间值」，最多偏 ±33%。

本地模型（ollama 之类）没有价目，花费显示 `—`。

**子代理会话不计入合计。** 被派出去干活的子代理（`rows.subagent.val.identity.mode === "continuable"`）用的是父会话的钱，它自己的会话文件只是同一笔账的另一份记录。所以它们会被识别出来、只计数，不进榜单、不进合计——否则总花费会虚高。

> 顺带记一笔踩过的坑：`~/.dsh` 里**没有** `parentSessionId` 这种字段，别去那里找父子关系；子代理只能靠 `subagent.identity.mode` 认。

## 自动更新（GitHub 仓库）

设置 → 集成 → 更好的显示，填入**更新源**即可：

```
owner/repo                                  ← 最省事
https://github.com/owner/repo               ← 等价
https://github.com/owner/repo/tree/main     ← 指定分支
```

两种模式，自动挑：

1. **仓库发了 Release**（推荐）：读 `releases/latest` 的 `tag_name` 跟当前版本比，下载 Release 里那个 `*.zip`。所以打包时把 zip 传成 release asset 就行。
2. **没发 Release**：盯默认分支的最新 commit，拿 `sha` 跟「上次装过的 sha」比。仓库一 push，这边就知道该更新。

两个开关：

- **自动检查**：启动 20 秒后查一次，之后每 6 小时一次。
- **自动安装**：检查到更新就直接下载、覆盖插件目录（**下次启动 DSH 生效**）。

装的过程不碰正在跑的进程：包先落在 `<DSH_HOME>\balance-panel-update\package.zip`，再由一个 PowerShell 脚本（用 `Expand-Archive`）在后台解压覆盖，做完往同目录 `apply.log` 里记一行。这样不会出现「自己改自己改到一半」。

国内直连 GitHub 常常不通，所以有个**镜像前缀**输入框：填 `https://gh.llkk.cc` 这类加速前缀，下载地址会被改写成 `前缀/原地址`。

手动：`检查更新` → 有新版按钮才亮 → `安装并重启`。

## 装在哪

- **源文件**：`E:\tools\dsh-plugins\dsh-balance-panel\`（`lib/index.js` 宿主、`lib/client.js` 浏览器、`cordis.patch.yml`、本 README）
- **生效位置**：`C:\Users\30102\.dsh\profiles\desktop\node_modules\dsh-balance-panel\`
  - `lib/index.js` 是一个转发壳（`import * as impl from "file:///E:/tools/dsh-plugins/dsh-balance-panel/lib/index.js"`），宿主侧只有 E: 那一份真代码，改完不用复制。
  - `lib/client.js` **是实体副本**——浏览器从 web 路由取文件，取不到 `file://`，所以这一份要手动同步。
- 已登记：`C:\Users\30102\.dsh\profiles\desktop\package.json` 的 `dependencies`（`file:E:/...`）与 `dsh.profile.bundles`（`"dsh-balance-panel"`）。

改完浏览器侧后同步一句：

```powershell
Copy-Item E:\tools\dsh-plugins\dsh-balance-panel\lib\client.js `
  C:\Users\30102\.dsh\profiles\desktop\node_modules\dsh-balance-panel\lib\client.js -Force
```

然后重启 DSH。如果哪天 pnpm 重装依赖把 `node_modules\dsh-balance-panel` 抹掉了，重新拷一次那三个文件即可（`package.json`、`cordis.patch.yml`、`lib\`）。

## 想换位置

卡片槽位写在 `lib/client.js` 的 `apply()` 里：

```js
ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
  { name: "sidebar.footer.action", id: "dsh-balance", order: 90, label: "余额" },
  (props) => h(BalanceCell, { wide: props.wide }),
));
```

`sidebar.footer.action` 是 DSH 侧栏里唯一确认**可叠加**的整行位置，所以默认放这儿。要挪到顶部得占 `sidebar.brand.mark` / `sidebar.brand.name`——那是单槽且带 fallback，占了会把品牌行顶掉，不建议。

想调整和别的底部插件的左右顺序，改 `order` 即可。

## 换到没有肥鱼服务的机器

「咚」是 Web Audio 现合成的，任何机器都响；那个人声则依赖本机的肥鱼服务（`http://127.0.0.1:9890`，CosyVoice3 + RVC）。为了让别的机器也出声，宿主会**先读包里的 wav**：

- 位置：`<插件目录>\assets\<sha1(voice|style|text)前16位>.wav`，三句各一只。
- 顺序：`assets\` → `<DSH_HOME>\balance-panel-say\`（本机合成缓存）→ 都没有才去问 9890。
- 自动收纳：DSH 一启动，宿主会检查那三句——包里没有、本机缓存里有的，**自动拷贝进 `assets\`**。所以在这台已经出过声的机器上重启一次 DSH，`assets\` 就会自己长出来，之后打包带走即可（`Compress-Archive` 时把 `assets\` 一起打进去）。
- 注意：文件名跟 `voice|style` 绑定。默认 `feiyu|cute`；如果换了 `feiyuVoice` / `feiyuStyle` 配置，包里那三只就对不上，会退回"去问服务"这条路——没服务的机器上就没声了。

