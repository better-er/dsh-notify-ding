# 贡献指南

感谢你愿意为 dsh-notify-ding 出力。

## 环境

- Node.js 26.3.1
- pnpm 9

```powershell
pnpm install
```

## 常用命令

```powershell
pnpm run typecheck   # 严格类型检查，不产出文件
pnpm run build       # tsdown 构建，产出 lib/index.js、lib/client.js 与 lib/index.d.ts
```

`lib/` 是构建产物，不入库，也不要手改。改行为请改 `src/`。

## 结构

| 路径 | 作用 |
| --- | --- |
| `src/index.ts` | 宿主入口，无运行时行为，只用于让包被 Loader 加载 |
| `src/client/index.ts` | 浏览器半身，边沿检测与通知 |
| `cordis.patch.yml` | bundle 挂载补丁 |
| `docs/design.md` | 设计说明 |

插件只有浏览器半身：它盯住会话状态，判断该不该响，然后弹出系统通知，提示音由 Windows 通知系统自带。宿主入口文件没有运行时行为，只为让客户端模块系统能扫到 `dsh.client` 声明，加功能时都在浏览器侧完成。

## 约定

- 注释与文档一律中文，专有名词除外。
- 一句话写成一行，不要句中硬换行。
- 不用非必要的括号，仅代码里不得已时使用。
- 尽量少用 try，不得不用时 except 或 catch 必须留下能定位原因的日志。
- 浏览器半身对快照的读取用 `getSnapshot()`，订阅用 `subscribe()`。写成 `get()` 会在运行时报 TypeError，而类型检查抓不到，因为接口是你自己声明的。

## 测试

仓库暂无自动化单测，改动后请手工验证：

1. 提问触发：重启 DSH web 后，在会话里触发一次提问，应弹出系统通知，提示音由 Windows 通知系统自带。
2. 完成触发：跑完一轮对话，也应弹出系统通知。
3. 去重：连续触发，间隔小于 800 毫秒的应合并，同一待回答请求只弹一次。
4. 关闭：会话被选中、开始新一轮、待回答被解决或从列表移除时，对应通知应被关掉。

## 发布

推一个形如 `v0.1.0` 的 tag 即可。发布工作流会凭 tag 号同步 `package.json` 版本、跑类型检查与构建、发布 npm，并生成 GitHub Release 草稿。

npm 发布走 Trusted Publishing，无需配置 `NPM_TOKEN`；若 npm 侧未绑定信任关系，发布会失败。

## 提交

- 提交信息用中文，简洁说清做了什么。
- 不要提交 `lib/`、`node_modules/` 或任何密钥。

## License

贡献即表示同意以 [MIT](./LICENSE) 授权。
