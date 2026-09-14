# dsh·通知叮咚插件

在 DSH 需要你人工回答或一轮对话跑完时，弹出系统通知。

纯浏览器端的插件，不替换任何原生界面。

## 引言

<!-- 本节由作者本人撰写，AI 不代笔。 -->
最小的 Windows 11 系统通知 + 内置提示音的提醒插件。

## 功能

- 某个会话出现新的待人工回答交互时叮咚一次，question、plan-review、approval 都算。
- 某个会话从执行中落到空闲、也就是一轮对话跑完时叮咚一次。
- 两种触发都会弹一条浏览器系统通知，提示音由 Windows 通知系统自带。
- 不判断页面是否聚焦，也不区分是否为当前会话，任何会话有事都会响。
- 通知不设自动关闭时间，会一直留在系统通知里，直到对应会话发生操作：会话被选中、该会话开始新一轮、待回答被解决，或会话从列表移除。
- 每个会话最多保留一条通知，新通知会顶掉同会话的旧通知；点击通知会聚焦窗口并切到该会话。
- 同一待回答请求只响一次，两次响铃之间至少有 800 毫秒间隔，且该间隔跨标签页共享，多开标签页不会重复响。

## 使用

### 首次使用

浏览器系统通知需要页面授权。插件在加载时会尝试请求一次，若被浏览器拒绝，会在你下一次点击或按键时再请求一次。所以在第一次看到页面后点一下任意位置，授权弹窗就会出来。

### 提示音从哪来

插件不自行发声，提示音由 Windows 的通知系统在弹通知时自带。提示音的音量与静音都跟着系统通知设置走，和插件本身无关。

### 全屏时通知会被系统静默

Windows 11 的「专注」有一条自动规则「当我在全屏使用应用时」，全屏看视频或玩游戏时会自动进入专注状态，通知横幅不显示、通知音被静音，通知只落进通知中心，看起来就像插件根本没响。这是系统行为，插件感知不到也绕不开。

想在全屏时也看到横幅，去 设置 → 系统 → 通知 → 专注，关闭「自动开启专注会话」里的「当我在全屏使用应用时」。代价是全屏时其他应用的通知也会冒出来。

此时插件没有任何声音提示，因为它不自己发声，提示音就是被一并静音的通知音。

## 安装

**从 GitHub 安装**：源码在 `src/`，`lib/` 不入仓库，安装时 npm 会触发 `prepare` 脚本现场构建。

```powershell
dsh plugin --profile web add github:better-er/dsh-notify-ding
```

**从 npm 安装**：包内已含构建产物 `lib/index.js` 与 `lib/client.js`，安装时不再构建。

```powershell
dsh plugin --profile web add dsh-notify-ding
```

两种方式装完都会自动挂载，重启 DSH web 后启用，无需手工编辑任何文件。

## 卸载

```powershell
dsh plugin --profile web remove dsh-notify-ding
```

彻底移除，重启 DSH web 后不再加载。

## 工作原理

浏览器半身订阅 `ctx.sessions.list` 与 `ctx.uiSession.pendingInteractions` 两个只读快照，用边沿检测判断该不该响：运行态从真落到假算一轮跑完，出现新 key 的待回答交互算需要人工介入。首帧只建基线不发声，同一待回答请求只响一次，两次响铃之间留至少 800 毫秒并把该时刻写入 localStorage 跨标签页共享。

判定通过时它弹出一条浏览器系统通知。通知按会话记录且不设自动关闭，同一会话只留最新一条；会话被选中、开始新一轮、待回答被解决或从列表移除时会关掉对应通知，点击通知则聚焦窗口、切换过去并关掉该条。完整设计见 [设计说明](docs/design.md)。

## 要求与开发

- 是标准形态的 dsh client 插件，声明 `dsh.client`，导出 `./client`。
- 同时声明了 `dsh.bundle`，因此也是一个自挂载的 bundle 层插件：用 `dsh plugin --profile <name> add` 从 GitHub 安装后会被自动识别为 profile layer 并挂载，无需手工写组合 entry。
- 浏览器半身依赖 `uiSession` 与 `sessions`；宿主入口没有运行时行为，只为让包能被 Loader 加载。
- 构建型插件：`src/` 是 TypeScript 源码，`lib/` 是构建产物且不入库，安装或发布前由 `prepare` 构建。

## 开发

```powershell
pnpm install
pnpm run typecheck   # tsc --noEmit 严格类型检查
pnpm run build       # tsdown，产出 lib/index.js 与 lib/client.js
```

- `src/index.ts`：宿主入口，无运行时行为，只用于让包被 Loader 加载。
- `src/client/index.ts`：浏览器半身，边沿检测与通知。
- 构建用 tsdown，client 产物是 `window.__ModuleLoader__.load({ id, factory })` 的注册式模块，`@deepseek-ai/cordis` 保持外部依赖。

## License

[MIT](./LICENSE)
