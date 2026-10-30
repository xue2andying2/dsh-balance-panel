# 更好的显示 · 安装说明

给「DeepSeek Harness 桌面版（DSH Desktop）」装一个侧边栏小面板：**余额、今日花费、今日 token、总消耗、在跑会话、峰谷倒计时**一眼可见；点一下看每条会话花了多少钱，悬浮看谁正在跑，「咚」按钮还会用肥鱼音色念一句话。

- 平台：Windows（路径按 Windows 写）
- 需要：DSH Desktop 0.2.x（Electron 44 / Chromium），不需要额外装依赖
- 权限：只读本机会话文件 + 用你已登录的 DeepSeek 账号查余额，**不联网上报任何东西**

---

## 一、先把包放进去

解压 `更好的显示_v0.1.0.zip`，会得到一个目录 `dsh-balance-panel\`，里面有：

```
package.json
cordis.patch.yml
README.md
INSTALL.md          ← 本文件
lib\index.js        ← 宿主（Node 侧）
lib\client.js       ← 界面（浏览器侧）
assets\*.wav        ← 按钮那三句话（没有也能装，只是没人声）
```

把整个 `dsh-balance-panel` 目录复制到 DSH 的 profile 下面：

```
C:\Users\<你的用户名>\.dsh\profiles\desktop\node_modules\dsh-balance-panel
```

> `%USERPROFILE%\.dsh` 是 DSH 的家目录。如果你改过 `DSH_HOME` 环境变量，就换成那个路径。
> 目录名必须叫 `dsh-balance-panel`，和 `package.json` 里的 `name` 一致，否则加载不到。

PowerShell 一行版（把 `<你的用户名>` 换成自己的）：

```powershell
Copy-Item -Recurse -Force ".\dsh-balance-panel" "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-balance-panel"
```

## 二、登记到 profile（这一步不做，插件不会被加载）

打开：

```
C:\Users\<你的用户名>\.dsh\profiles\desktop\package.json
```

**1) 在 `dependencies` 里加一行**（路径指向你放的位置）：

```json
"dependencies": {
  "dsh-balance-panel": "file:E:/tools/dsh-plugins/dsh-balance-panel",
  ...其余保持不动
}
```

> 如果你已经按第一步复制进了 `node_modules`，这一行其实可以不写（DSH 直接从 `node_modules` 找得到）。写了更规整，重装依赖也不会丢。

**2) 在 `dsh.profile.bundles` 数组里加一项**：

```json
"dsh": {
  "profile": {
    "bundles": [
      "dsh-balance-panel",
      ...其余保持不动
    ]
  }
}
```

两处都要改，**只进 `bundles` 不复制文件**、或**只复制文件不进 `bundles`**，都不会生效。

## 三、重启并确认

1. 完全退出 DSH（托盘退出 / 任务管理器里结束 `DeepSeek Harness` 进程），再启动。
2. 左侧栏**最底部**应该多出一张卡片：一行六格，右上角有 `¥` 数字。
3. 点卡片 → 弹出「最近用过的会话」+「今日排行榜」；鼠标停在某一格 → 弹该格的小说明；停在最右「在跑」那格 → 弹正在工作的会话名单。

看不到卡片时按 `Ctrl+Shift+I` 打开控制台，找有没有 `dsh-balance-panel: import failed` 这类红字（见第五节）。

## 四、声音（可选）

- 「咚」是浏览器里现合成的，**任何机器都响**，不依赖任何服务。
- 人声有三条来源，宿主按顺序找：
  1. `assets\<hash>.wav`（随包携带 —— 换机器也能响靠这个）
  2. `<DSH_HOME>\balance-panel-say\<hash>.wav`（本机合成缓存）
  3. 本机肥鱼服务 `http://127.0.0.1:9890`（CosyVoice3 + RVC）现合成
- 你机器上**没有肥鱼服务**也没关系：只要 `assets\` 里那三只 wav 在，按下去就有人声；再没有就只响「咚」，其余功能一切正常。
- 想换音色：改本包的 `cordis.patch.yml`（就是把 `name` 那行下面补 `config`）：

```yaml
- insert:
    - id: balance-panel
      name: 'dsh-balance-panel'
      config:
        feiyuBase: 'http://127.0.0.1:9890'
        feiyuKey: '<你的 api key>'
        feiyuVoice: 'feiyu'
        feiyuStyle: 'cute'
        feiyuTimeoutMs: 180000
```

  注意 `assets\` 里的文件名跟 `voice|style` 绑定（默认 `feiyu|cute`）。改了 voice/style 后，包里那三只就对不上，会转去问服务。

## 五、出问题看这里

| 症状 | 原因 / 处理 |
| --- | --- |
| 启动弹「dsh-balance-panel: import failed」 | `lib\client.js` 没解析成功。跑 `node --check "…\node_modules\dsh-balance-panel\lib\client.js"` 看行号；也常见于旧版本被界面缓存住——彻底结束进程 + 删 `%APPDATA%\@deepseek-ai\dsh-desktop\Cache` 与 `Code Cache` |
| 侧栏没有卡片 | 十有八九是 `bundles` 里没加，或目录名不是 `dsh-balance-panel` |
| 卡片在，但数字全是 `—` / `¥0.00` | 宿主路由没起来（看日志里的报错），或会话目录为空；先在 DSH 里随便开一条会话说句话再刷新 |
| 余额是「拿不到」 | 没登录 DeepSeek 账号，或凭证过期。在 DSH 里重新登录一次 |
| 按「咚」只响不念 | 没有 `assets\*.wav`、也没有肥鱼服务。补文件或装服务 |
| 会话列表里有 0 token 的空壳 | 插件已自动过滤「没说过话」的会话，过滤后仍出现说明那条真的动过（比如只切了模型） |

## 六、卸载

**懒人办法**：设置 → 集成 → **更好的显示** → 点「一键卸载」两下（第一下变成「确认卸载（不可撤销）」），它会自己从 profile 的 `bundles` / `dependencies` 里摘掉，并在后台删掉插件目录；然后重启 DSH 就干净了。同一个地方还有**开关**：关掉之后侧栏那张卡片不再显示（插件仍在跑，只是不画）。

手工做法：

1. 从 `dsh.profile.bundles` 里删掉 `"dsh-balance-panel"`（顺手删 `dependencies` 里那行）。
2. 删目录 `…\.dsh\profiles\desktop\node_modules\dsh-balance-panel`。
3. 重启 DSH。合成出来的 `%DSH_HOME%\balance-panel-say\` 可以留着，也可以一起删。

## 七、数据都读了什么

- 会话：`<DSH_HOME>\storages\session_projcache\sessions\session-*.json`（只读，不写、不改）
- 余额：`ctx.credentials.readRecord("deepseek-account-platform/default")` 拿到的令牌，请求头 `x-dsh-auth-token` 打 `https://api.deepseek.com/user/balance`
- 花费：会话文件里 `contextActivity.days` 的按天、按峰谷档用量，乘本插件内置的价目表（与 `@dougen/dsh-deepseek-usage` 同源）。「今日」就是今天那一桶，跨天的会话不再整条计入。老会话没有按天记账时退回估算。节假日没算，会比实际略贵一点点。
