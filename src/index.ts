/**
 * dsh-notify-ding 的宿主半身。
 *
 * 职责只有一件：在 dsh 的 web 载体上注册一条精确路由 POST /dsh-notify-ding/ding，
 * 收到请求就用 PowerShell 的 System.Media.SoundPlayer 播放 Windows 自带的提示音。
 * 之所以要绕宿主这一圈，是因为浏览器沙箱读不到 C:\Windows\Media 下的文件，
 * 而 Windows 本家音色只有读得到那些 wav 的宿主进程才播得出来。
 *
 * 浏览器半身负责判断「该响了」；本半身不参与任何触发判断，只负责发声。
 *
 * @module dsh-notify-ding
 */
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'

/** 插件名，同时也是配置项 id。 */
export const name = 'dsh-notify-ding'

/** 依赖宿主 web 载体的具名路由注册能力。没有 web 载体时本插件不激活。 */
export const inject = ['webServer']

/** 播音路由的绝对路径。 */
const ROUTE_PATH = '/dsh-notify-ding/ding'

/** Windows 通知音的绝对路径，本家音色。 */
export const SOUND_FILE = 'C:\\Windows\\Media\\Windows Notify System Generic.wav'

/** 一次「叮咚」播放的次数，一声即可，重复反而显得吵。 */
export const BEEP_COUNT = 1

/** 宿主 web 载体的最小面，只取本插件用得到的那一条。 */
interface WebServerFace {
  /** 注册一条精确路径路由，返回移除该路由的 disposer。 */
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: unknown, res: WebResponseFace) => void
  }): () => void
}

/** 只用到状态码与结束响应这两个动作的响应面。 */
interface WebResponseFace {
  statusCode: number
  end(body?: string): void
}

/**
 * 组装播音用的 PowerShell 脚本。
 *
 * 路径经单引号转义后拼进脚本字面量，避免文件名里的特殊字符被当成命令解析。
 * 播放次数写进脚本，因此一次进程启动就能响完整段声音，不必每声各起一个进程。
 *
 * @returns 一段自包含的 PowerShell 脚本。
 */
function buildPlayScript(): string {
  const escaped = SOUND_FILE.replace(/'/g, "''")
  return [
    "$ErrorActionPreference = 'Stop'",
    // 首次加载模块会往 stderr 写一条 CLIXML 进度记录，静音掉免得污染宿主日志。
    "$ProgressPreference = 'SilentlyContinue'",
    "$player = New-Object System.Media.SoundPlayer '" + escaped + "'",
    "for ($i = 0; $i -lt " + BEEP_COUNT + "; $i++) {",
    '  $player.PlaySync()',
    '}',
  ].join('\n')
}

/**
 * 把播音请求交给一个脱离宿主事件循环的 PowerShell 进程。
 *
 * 用 detached 启动，因此响铃不会被 dsh 的生命周期或响应结束打断；
 * stderr 仍要接住，否则播放失败时宿主会留下无人消费的管道数据。
 *
 */
function spawnPlayer(): void {
  const script = buildPlayScript()
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const child = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  )
  // stderr 只用于诊断：正常播放时它是空的，有内容说明播放链路出了问题。
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim()
    if (text) console.warn('[dsh-notify-ding] 播音进程报错：' + text)
  })
  child.on('error', (error: Error) => {
    console.warn('[dsh-notify-ding] 播音进程启动失败：' + error.message)
  })
  child.on('close', (code: number | null) => {
    if (code !== 0 && code !== null) {
      console.warn('[dsh-notify-ding] 播音进程退出码：' + String(code))
    }
  })
  child.unref()
}

/**
 * 挂载播音路由。
 *
 * @param ctx 宿主上下文，webServer 服务已就绪。
 */
export function apply(ctx: Context): void {
  const webServer = ctx.get('webServer') as WebServerFace | undefined
  if (!webServer) {
    console.warn('[dsh-notify-ding] 未找到 webServer 服务，播音路由不注册。')
    return
  }

  webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: (req, res) => {
      if ((req as { method?: string }).method !== 'POST') {
        res.statusCode = 405
        res.end('method not allowed')
        return
      }
      try {
        spawnPlayer()
      } catch (error) {
        // 进程都起不来时如实报错，宿主日志里能定位到具体原因。
        console.warn('[dsh-notify-ding] 播音调用失败：' + (error as Error).message)
        res.statusCode = 500
        res.end('spawn failed')
        return
      }
      res.statusCode = 200
      res.end('ding')
    },
  })
}
