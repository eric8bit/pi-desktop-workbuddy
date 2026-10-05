# pi-desktop-workbuddy · PI-Desktop 插件

把 **WorkBuddy 桌面 App 里登录过的所有账号** 自动并入一个模型池，并接进 PI-Desktop：

- **零配置自动发现** —— 你在桌面 App 登录的每个账号都会自动成为池成员，不需要在插件里手动录入；
- **自动容错轮换** —— 某个账号被限流（HTTP 429）时，请求立刻切到下一个健康账号，调用方看不到 429；
- **国内版 / 国际版各自独立成组** —— 两个网关各是一个供应商分组，账号、积分、模型互不干扰，可同时使用；
- **令牌不进宿主** —— 插件复用 App 自己的登录文件，令牌只在插件进程内使用，在请求上行时附加，不写入 PI-Desktop 的 provider 设置、数据库或任何请求体；
- **真实流式** —— 对话走插件在本机回环地址上运行的 OpenAI 兼容端点，上游 SSE 边到边转发（不是缓冲后一次性返回）。

这是 [`aosi526/dsh-workbuddy-xdpool`](https://github.com/aosi526/dsh-workbuddy-xdpool)（MIT，Copyright (c) 2026 XDTrees）的 PI-Desktop 移植版，功能与原版对齐。本移植版仓库：[`eric8bit/pi-desktop-workbuddy`](https://github.com/eric8bit/pi-desktop-workbuddy)。

---

## 1. 安装

### 方式 A：作为开发插件加载（推荐）

1. 打开 PI-Desktop → **插件** 页；
2. 头部溢出菜单 → **加载开发插件**（Load development plugin）；
3. 选择本目录（含 `manifest.json` 的那一层）；
4. 首次加载会请求以下权限，请核对后同意：

| 权限 | 用途 |
| --- | --- |
| `ui.panel` | 打开账号池面板 |
| `background.service` | 常驻 provider 主机（保持回环端点在线） |
| `provider.register` | 把两个供应商分组加进模型列表 |

> 本插件**不需要** `net.fetch`：上游请求由插件进程自己的 `fetch` 发出，因为宿主的 `net.fetch` 桥会把响应缓冲成一整块文本，那样就丢掉了流式。

### 方式 B：本地构建（开发者）

```sh
npm install
npm run build     # 产出 lib/*.js（CommonJS）
```

`src/*.ts` 是移植过来的核心（账号发现、上游客户端、模型目录、回环端点），
`build.mjs` 用 esbuild 把它们编译成 `lib/` 里的 CommonJS 单文件——
`main.js` 在运行时 `require('./lib/...')`，因此 `lib/` 必须与 `src/` 一起存在。

### 打包成 .piplug

```sh
pwsh -File tools/pack.ps1     # 产出 dist/local.pi-desktop-workbuddy-<版本>.piplug
```

宿主自己解析 .piplug（`crates/host-core/src/plugins/install.rs`），会顺序读取每个条目的本地头，
只要某项的压缩方法不是 0 就整包拒绝（`PLUGIN_INVALID: only store-compressed piplug supported`）。
所以包必须**不压缩**：`Compress-Archive` 一律用 deflate，做出来的包装不上；
`tools/pack.ps1` 用 `CompressionLevel.NoCompression` 写入，并在生成后按宿主的方式重读一遍自检。
**改动 `src/` 后请重新 `npm run build`。**

---

## 2. 首次使用

装好后：

1. **模型选择器**里会出现两个分组：`pi-desktop-workbuddy（国内版）` 与 `pi-desktop-workbuddy（国际版）`；
2. 打开 **插件 → pi-desktop-workbuddy** 面板，可以看到池健康状态、每个账号的令牌有效期 / 积分包 / 签到 / 冷却；
3. 面板「模型」页勾选你想要的模型后点「保存」——回环端点随即只对宿主发布这些模型，模型选择器会跟着更新（无需重载插件）。

### 池里怎么多账号？

池走**自动发现**：WorkBuddy 桌面 App 每次登录都会在本机 `CodeBuddyExtension` 数据目录留下一个登录快照，插件扫描这些快照并全部吸收入池。

因此多账号 = **在桌面 App 里逐个登录 / 切换账号**，然后点面板上的「重新检测账号」（或重启 PI-Desktop），新账号就会成为池成员。

WorkBuddy 5.6 起，当前登录文件里的令牌是 `$wbEncrypted`。插件会向本机已安装的 WorkBuddy 可执行文件要解密密钥再读；解不开就跳过该文件，不会把已登录报成未登录。

> 两个版本各自独立：国内版账号不能登录国际版，反之亦然，需要分别注册。

---

## 3. 面板功能

| 区域 | 说明 |
| --- | --- |
| **账号池** | 池健康摘要（`N 个账号 · X 个冷却中`）、下一个会轮到哪个账号、每个账号的令牌有效期与冷却倒计时、触发过的限流次数 |
| **积分** | 按账号展示积分包（`套餐名 · 剩余 / 总量`）与合计剩余（大字绿色），标注每月刷新与「3 天内过期」 |
| **每日签到** | 每个账号一个签到按钮，显示连签天数、每日积分与里程碑额外奖励；**今日已领取的账号不会被重复领取**（领取前会重新查询一次状态） |
| **模型** | 展开任意模型即可编辑：别名、上下文窗口与最大输出（带与宿主一致的预设档）、思考等级（逐档勾选 + 默认档）、图片输入；改动先为草稿，「保存」后立即生效 |
| **使用方式** | **优先用一个**（先用完一个账号的额度再换下一个）或 **轮流使用**（把消耗均摊到每个账号） |
| **连接检查** | 逐项 PASS/FAIL 的自检报告，可一键复制 |

顶部还有三个按钮：**重新检测账号**、**清除所有冷却**、**刷新**。

---

## 4. 命令与设置

面板里的 `contributes.commands` 也可以在命令面板直接调用：

- `pi-desktop-workbuddy: Open Panel`
- `pi-desktop-workbuddy: Detect Accounts Again`
- `pi-desktop-workbuddy: Clear All Cooldowns`
- `pi-desktop-workbuddy: Daily Check-in (All Accounts)` —— 一次领取所有账号的今日奖励
- `pi-desktop-workbuddy: Run Connection Check`

设置项（**插件 → pi-desktop-workbuddy**）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后 provider 主机不再启动 |
| `distribution` | `priority` | `priority` 先用完一个账号，`round-robin` 均摊 |
| `cooldownSeconds` | `60` | 限流冷却时长（上游能报出重置时间时以它为准） |
| `catalogRefreshMinutes` | `30` | 模型目录刷新间隔 |
| `authFile` | `""` | 登录文件覆盖路径（高级，留空即自动发现） |
| `modelSelection` | `{}` | 面板管理的模型选择，按网关分开保存 |

---

## 5. 它怎么工作

```
WorkBuddy 桌面 App 登录文件（只读）
        │  扫描 CodeBuddyExtension/**/auth/*.info
        ▼
   WorkBuddyAccountPool ── 按「账号 + 模型」维度记 429 冷却，priority / round-robin
        │
        ├─ cn     回环端点 127.0.0.1:41831  ─┐
        └─ global 回环端点 127.0.0.1:41841  ─┤
                                            │  附加令牌，429 时换号重试
                                            ▼
                          copilot.tencent.com / codebuddy.cn / workbuddy.ai
```

两个端点各自绑定自己网关的账号切片：国内版的请求**永远不会**被国际版账号接手（两个网关的令牌不通用），一侧出问题也不会影响另一侧。

端口固定（41831/41832 与 41841/41842，每侧两个候选）是刻意的：宿主在插件进程启动**之前**就从 manifest 读取 provider 的 `baseUrl`，因此端点必须每次回到同一个端口，否则已发布的 provider 行会指向空地址。这四个端口避开了单账号连接插件使用的 41811/41812 与 41821/41822，两个插件可以同时安装。

---

## 6. 权限与数据边界

- **只读发现**：只读取 WorkBuddy 桌面 App 自己的登录文件，不另行发起登录；
- **不复制凭据**：插件不在自己的数据目录里另存令牌副本（数据目录只写 `doctor.txt` 诊断报告）；
- **令牌不外流**：仅作为 `Authorization: Bearer` 发往腾讯 WorkBuddy / CodeBuddy 自己的接口；
- **回环端点**：只监听 `127.0.0.1`，校验 `Host`/`Origin` 必须是回环，并接受宿主的无密钥哨兵 `pi-desktop-no-auth`（因为 provider 声明为 `authKind: "none"`）；伪造的 bearer 一律 401；
- **无遥测、无第三方服务器**。

`manifest.json` 的 `contributes.providers` 由插件在加载时**写进它自己的包内**（这是宿主暴露给插件的唯一 provider 通道），不改动这个包以外的任何文件。模型列表本身则由宿主从本插件的回环端点 `/v1/models` 读取，因此保存后立即生效。

---

## 7. 已知行为

- **模型列表按你的选择发布**：本插件的回环端点在对宿主返回 `/v1/models` 时只列出你在「模型」页勾选的模型
  （以及图片输入、上下文上限），因此**保存后模型选择器会跟着变**，不需要重启应用。
- **保存是即时的**：面板「模型」页点「保存」会写入插件设置文件并立刻生效；若写入失败，面板会明确报错，
  不会假装成功。
- **宿主设置页改的模型选择也会生效**：宿主在保存后会推送 `plugin:settingsChanged`，插件收到后立即重新应用，
  不必重载插件。
- **打不开的检测不再拖慢面板**：打开面板先渲染缓存内容，检测在后台进行；标题栏会显示「正在检测…」，
  检测完成后自动更新。面板顶部「刷新」按钮则等待检测真正完成。
- **选择里若有已下线的模型**：插件会忽略这份失效选择并显示全部模型，同时在面板顶部提示，避免整组模型消失。
- **单账号时轮换无从体现**：池的价值在多账号；只有一个账号时，它的行为等同于单账号连接，但多出池健康、积分、签到与模型筛选能力。
- **国际版需要单独的账号**：没有国际版登录快照时，该分组不会出现在模型选择器里（面板里仍会显示该 tab，并说明如何登录）。
- **推理（思考）等级可调**：宿主 0.15.3 起已修复「插件 provider 的档位被丢弃」的缺陷
  （修复补丁见 `upstream-patch/`）。插件的两个分组会按上游声明的档位如实提供推理菜单，
  例如 `deepseek-v4.1-flash` 有 `off / low / medium / high / xhigh / max`。
  **若你在 0.15.3 之前装过旧版本**：旧版为了让档位可用，附带过一个写宿主数据库的绕行脚本
  （`tools/`）。宿主修好后它已删除，也**不要**再手工添加指向同一端点的重复供应商——
  那会让模型选择器出现重复分组。

---

## 8. 许可

MIT。移植自 [`aosi526/dsh-workbuddy-xdpool`](https://github.com/aosi526/dsh-workbuddy-xdpool)（Copyright (c) 2026 XDTrees），
其设计又参考了 `corrinehu/dsh-workbuddy-connect`（Copyright (c) 2026 Corrine Hu）与 `dingminhua/dsh-connect-workbuddy`（Copyright (c) 2026 LaoDing）。

`upstream-patch/` 保留为历史记录：那是提交给 PI-Desktop 作者的修复补丁与 issue 正文，
已随宿主 0.15.3 落地，不参与插件运行。

---

## 9. 公开分发说明（安全）

本仓库面向公开分发，以下取舍在此明示，避免使用者在不知情的情况下承担风险：

- **回环端点不做强鉴权**：`src/shim.ts` 的 `bearerOk()` 对任意 bearer 都返回 `true`，端点实际靠 `127.0.0.1` 绑定与 `Host` / `Origin` 回环校验兜底（原因见该处注释：宿主的无密钥 provider 注册必须被接受，否则手工添加的 provider 行会拿到 401）。这意味着**同一台机器上的其他进程**可以调用该端点，从而消耗你已登录账号的额度。这是本设计的有意取舍，不是缺陷；若你的威胁模型不接受，请改为拒绝未知 bearer。
- **端口固定**：`41831` / `41832` 与 `41841` / `41842` 是宿主在插件进程启动**之前**读取 `baseUrl` 所必需的，代价是同机程序可抢占这些端口。请只在你信任的机器上运行。
- **不复制凭据**：插件不落盘任何令牌副本，令牌只在内存中按请求附加到腾讯 WorkBuddy / CodeBuddy 自己的接口。

本仓库不含任何密钥、令牌、密码、邮箱或本机路径。`node_modules/`、`dist/`、`*.piplug` 与运行期诊断产物 `doctor.txt` 已在 `.gitignore` 中排除。
