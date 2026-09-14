/**
 * dsh-notify-ding 的浏览器半身。
 *
 * 只做两件事：判断「该响了」，然后弹一条浏览器系统通知。
 * 提示音由系统通知自带，插件不另外发声，全屏专注时通知音会被系统一并静音。
 *
 * 触发条件有两个：
 * 1. 某个会话出现了新的待人工回答交互，question / plan-review / approval 都算；
 * 2. 某个会话从「执行中」落到「空闲」，即一轮对话跑完。
 *
 * 按用户选择，两种都响，且不判断页面是否聚焦、不区分是否为当前会话。
 * 重复靠两道闸门挡：同一待回答请求的 key 只响一次，以及跨标签页共享
 * 的最小间隔，避免多开标签页时同一件事响好几轮。
 *
 * 通知不设自动关闭时间，会一直挂在系统通知里，直到对应会话发生操作：
 * 会话被选中、该会话开始新一轮、待回答被解决，或会话从列表移除。每个会话
 * 最多只保留最新一条，新通知会顶掉旧的；点击通知会聚焦窗口并切到该会话。
 *
 * @module dsh-notify-ding/client
 */
/** 插件名，同时也是配置项 id。 */
export const name = 'dsh-notify-ding'

/** 本插件需要的客户端服务。 */
export const inject = ['uiSession', 'sessions']

/** 两次响铃之间的最小间隔，窗口内的合并成一次。 */
const MIN_INTERVAL_MS = 800

/** 跨标签页共享「上次响铃时刻」的 localStorage 键。 */
const LAST_DING_KEY = 'dsh-notify-ding.lastDingAt'

/** 当前挂在系统通知里、按会话索引的通知，新通知会顶掉同会话的旧通知。 */
const liveNotifications = new Map<string, Notification>()

/** 打开会话的入口，由 apply 从 ctx.sessions 注入；缺失时点击通知只关通知。 */
let sessionOpener: ((id: string) => void) | undefined

/** 会话列表快照源，点击通知切会话前用它确认会话还在。 */
let listSourceRef: SnapshotSourceFace<SessionListStateFace> | undefined

/** 上一帧被选中的会话，用来识别「用户选中了某个会话」这个操作信号。 */
let lastCurrent: string | undefined

/** 一个待人工回答的交互，只关心其稳定 key。 */
interface PendingInteractionFace {
  readonly key: string
}

/** 一条会话摘要里本插件用得到的字段。 */
interface SessionSummaryFace {
  readonly id: string
  readonly displayTitle?: string
  readonly running: boolean
}

/** 会话列表快照里本插件用得到的字段。 */
interface SessionListStateFace {
  readonly byId: Record<string, SessionSummaryFace>
  readonly current?: string
}

/** 一个可取消订阅的只读快照源，读取当前值用 getSnapshot。 */
interface SnapshotSourceFace<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** 待回答交互快照源，按会话 id 索引。 */
type PendingSourceFace = SnapshotSourceFace<ReadonlyMap<string, PendingInteractionFace>>

/** 浏览器与服务两端都够用的一小片客户端上下文。 */
interface NotifyClientContext {
  readonly sessions: {
    readonly list: SnapshotSourceFace<SessionListStateFace>
    open?(id: string): void
  }
  readonly uiSession: { readonly pendingInteractions: PendingSourceFace }
  effect(callback: () => (() => void) | void): void
}

/** 每个会话在上一帧里的运行态与已见过的待回答 key。 */
interface SessionTrack {
  running: boolean
  pendingKeys: Set<string>
}

/** 记录各会话上一帧状态，用来做边沿检测。 */
const tracks = new Map<string, SessionTrack>()

/** 本页面上次响铃的时间戳，兜住同一帧内的重复触发。 */
let lastDingAt = 0

/** 因节流被暂时压下的最新一条待响请求，窗口过后补发。 */
let deferred: { sessionId: string; title: string; body: string } | null = null

/** 补发定时器的句柄，0 表示当前没有挂起的补发。 */
let deferredTimer = 0

/**
 * 读取跨标签页共享的上次响铃时刻。
 *
 * localStorage 可能因隐私模式或禁用存储而抛错，抛错时按 0 处理即可，
 * 最坏退化成只在单个标签页内节流。
 *
 * @returns 上次响铃的 Unix 毫秒时间戳。
 */
function readSharedLastDing(): number {
  try {
    const raw = window.localStorage.getItem(LAST_DING_KEY)
    const value = raw === null ? 0 : Number(raw)
    return Number.isFinite(value) ? value : 0
  } catch (error) {
    console.warn('[dsh-notify-ding] 读取共享响铃时刻失败：' + String(error))
    return 0
  }
}

/** 写回跨标签页共享的上次响铃时刻，存储不可用时静默降级。 */
function writeSharedLastDing(stamp: number): void {
  try {
    window.localStorage.setItem(LAST_DING_KEY, String(stamp))
  } catch (error) {
    console.warn('[dsh-notify-ding] 写入共享响铃时刻失败：' + String(error))
  }
}

/** 关掉某会话的通知；没有或已关就当无操作。 */
function closeNotification(sessionId: string): void {
  const notification = liveNotifications.get(sessionId)
  if (!notification) return
  liveNotifications.delete(sessionId)
  try {
    notification.close()
  } catch (error) {
    console.warn('[dsh-notify-ding] 关闭系统通知失败：' + String(error))
  }
}

/** 关掉当前挂着的全部通知，插件卸载时收尾。 */
function closeAllNotifications(): void {
  for (const sessionId of Array.from(liveNotifications.keys())) closeNotification(sessionId)
}

/** 聚焦窗口并切到目标会话；缺少入口或会话已不在列表时只聚焦。 */
function openSessionInUi(sessionId: string): void {
  try {
    window.focus()
  } catch (error) {
    console.warn('[dsh-notify-ding] 聚焦窗口失败：' + String(error))
  }
  const open = sessionOpener
  const source = listSourceRef
  if (!open || !source) return
  try {
    if (source.getSnapshot().byId[sessionId] === undefined) return
    open(sessionId)
  } catch (error) {
    console.warn('[dsh-notify-ding] 打开会话失败：' + String(error))
  }
}

/**
 * 弹一条浏览器系统通知，并挂在对应会话名下。
 *
 * 通知不设自动关闭时间，会一直挂在系统通知里，直到对应会话发生操作。
 * 每个会话最多保留一条，新的会先关掉同会话的旧的。
 * 点击通知会聚焦窗口并切到该会话，同时关掉这条通知。
 *
 * 浏览器未授权时不强行索要权限，而是记下需要补授权，等到用户下一次
 * 与页面交互时再请求——权限请求必须由用户手势触发。
 *
 * @param sessionId 这条通知所属的会话。
 * @param title 通知标题。
 * @param body 通知正文。
 */
function showSystemNotification(sessionId: string, title: string, body: string): void {
  if (typeof Notification === 'undefined') return

  const present = (): void => {
    closeNotification(sessionId)
    try {
      const notification = new Notification(title, { body, requireInteraction: true })
      notification.onclick = () => {
        openSessionInUi(sessionId)
        closeNotification(sessionId)
      }
      notification.onclose = () => {
        if (liveNotifications.get(sessionId) === notification) liveNotifications.delete(sessionId)
      }
      liveNotifications.set(sessionId, notification)
    } catch (error) {
      console.warn('[dsh-notify-ding] 弹出系统通知失败：' + String(error))
    }
  }

  if (Notification.permission === 'granted') {
    present()
    return
  }
  if (Notification.permission === 'denied') return

  // 默认状态：先尝试一次，被拒就挂到下一次用户手势上。
  void Notification.requestPermission().then((permission) => {
    if (permission === 'granted') present()
    else armPermissionGesture()
  }).catch((error: unknown) => {
    console.warn('[dsh-notify-ding] 请求通知权限失败：' + String(error))
  })
}

/** 是否已经挂过一次手势补授权监听。 */
let gestureArmed = false

/** 在下一次用户手势时补一次通知权限请求，只挂一次。 */
function armPermissionGesture(): void {
  if (gestureArmed || typeof Notification === 'undefined') return
  if (Notification.permission === 'granted' || Notification.permission === 'denied') return
  gestureArmed = true
  const onGesture = (): void => {
    window.removeEventListener('pointerdown', onGesture, true)
    window.removeEventListener('keydown', onGesture, true)
    void Notification.requestPermission().catch((error: unknown) => {
      console.warn('[dsh-notify-ding] 手势补授权失败：' + String(error))
    })
  }
  window.addEventListener('pointerdown', onGesture, true)
  window.addEventListener('keydown', onGesture, true)
}

/**
 * 发一次「叮咚」，并做节流。
 *
 * 节流时刻写进 localStorage，多标签页共享，避免多开时同一件事响好几轮。
 * 被节流压下的请求不会直接丢弃，而是挂到窗口边界的定时器上补发，
 * 这样连续两次状态变化仍然各响一次，只是间隔被拉开，不会出现漏报。
 *
 * @param sessionId 这条通知所属的会话。
 * @param title 通知标题。
 * @param body 通知正文。
 */
function ding(sessionId: string, title: string, body: string): void {
  const now = Date.now()
  const since = now - Math.max(lastDingAt, readSharedLastDing())
  if (since < 0 || since >= MIN_INTERVAL_MS) {
    lastDingAt = now
    writeSharedLastDing(now)
    showSystemNotification(sessionId, title, body)
    return
  }
  deferred = { sessionId, title, body }
  if (deferredTimer !== 0) return
  deferredTimer = window.setTimeout(() => {
    deferredTimer = 0
    const pending = deferred
    deferred = null
    if (pending === null) return
    const stamp = Date.now()
    lastDingAt = stamp
    writeSharedLastDing(stamp)
    showSystemNotification(pending.sessionId, pending.title, pending.body)
  }, MIN_INTERVAL_MS - since)
}

/** 会话标题，缺失时退回会话 id，保证通知里总有个能认的名字。 */
function titleOf(summary: SessionSummaryFace | undefined, fallbackId: string): string {
  const raw = summary?.displayTitle
  return raw && raw.length > 0 ? raw : fallbackId
}

/**
 * 用一帧会话列表快照做边沿检测：新出现的待回答交互响一次，运行态从真落到假响一次。
 *
 * 首帧只建基线不响，否则每次刷新页面都会把既有状态补报一轮。
 * 同时识别「会话被操作」的信号，把对应会话还挂着的通知关掉：
 * 运行态从假升到真说明已回到该会话开始新一轮，会话被选中，
 * 以及会话从列表消失，都算一次操作。
 *
 * 选中变化先于响铃处理，否则同一帧里既跑完又刚被选中的会话，通知会建立后
 * 立刻被关掉。current 短暂变空是 DSH 的 masked gap，选中会话暂时不在列表时
 * 就会出现，不算一次操作，也不该把上一个有效选中抹掉。
 *
 * @param state 当前会话列表快照。
 * @param baseline 是否首帧，首帧只建基线。
 */
function scanSessions(state: SessionListStateFace, baseline: boolean): void {
  // 用户选中了某个会话，也算对该会话的一次操作。
  if (state.current !== undefined) {
    if (!baseline && state.current !== lastCurrent) closeNotification(state.current)
    lastCurrent = state.current
  }
  const seen = new Set<string>()
  for (const id of Object.keys(state.byId)) {
    const summary = state.byId[id]
    if (!summary) continue
    seen.add(id)
    let track = tracks.get(id)
    if (!track) {
      track = { running: summary.running, pendingKeys: new Set<string>() }
      tracks.set(id, track)
    }
    if (!baseline) {
      // 一轮对话跑完：运行态下降沿，响一次。
      if (track.running && !summary.running) {
        ding(id, 'DSH 完成了一轮', titleOf(summary, id) + ' 已空闲')
      }
      // 运行态上升沿：该会话开始新一轮，关掉它还没撤掉的通知。
      if (!track.running && summary.running) closeNotification(id)
    }
    track.running = summary.running
  }
  // 会话从列表移除，对应通知一并关掉。
  for (const id of Array.from(tracks.keys())) {
    if (!seen.has(id)) {
      closeNotification(id)
      tracks.delete(id)
    }
  }
}

/**
 * 用一帧待回答交互快照做边沿检测：某会话冒出新的 key 时响一次。
 *
 * 先处理「旧 key 失效」：被解决或被新 key 顶掉时关掉该会话的通知；
 * 再处理「新 key 出现」并叮咚，因此替换场景下新通知不会被误关。
 *
 * @param pending 当前按会话索引的待回答交互快照。
 * @param state 与本次快照同时读到的会话列表，用来取标题。
 * @param baseline 是否首帧，首帧只建基线。
 */
function scanPending(
  pending: ReadonlyMap<string, PendingInteractionFace>,
  state: SessionListStateFace,
  baseline: boolean,
): void {
  // 待回答被解决或被替换：关掉对应会话还没撤掉的通知。
  if (!baseline) {
    for (const [id, track] of tracks) {
      if (track.pendingKeys.size === 0) continue
      const currentKey = pending.get(id)?.key
      if (currentKey !== undefined && track.pendingKeys.has(currentKey)) continue
      closeNotification(id)
    }
  }
  // 新出现的 key：响一次。
  for (const [id, interaction] of pending) {
    const track = tracks.get(id)
    if (!track) continue
    if (track.pendingKeys.has(interaction.key)) continue
    track.pendingKeys.add(interaction.key)
    if (baseline) continue
    ding(id, 'DSH 需要你回答', titleOf(state.byId[id], id) + ' 正在等你')
  }
  // 同步记录，只保留当前仍有效的 key。
  for (const [id, track] of tracks) {
    if (track.pendingKeys.size === 0) continue
    const stillPending = pending.get(id)
    if (stillPending === undefined) {
      track.pendingKeys.clear()
      continue
    }
    for (const key of Array.from(track.pendingKeys)) {
      if (key !== stillPending.key) track.pendingKeys.delete(key)
    }
  }
}

/**
 * 同时盯住会话列表与待回答交互两个快照源。
 *
 * @param ctx 客户端根上下文，sessions 与 uiSession 已就绪。
 */
export function apply(ctx: NotifyClientContext): void {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    armPermissionGesture()
  }

  const pendingSource = ctx.uiSession.pendingInteractions
  const listSource = ctx.sessions.list
  const open = ctx.sessions.open
  // 点击通知时用来切会话；入口缺失时点击只关通知。
  sessionOpener = typeof open === 'function' ? open.bind(ctx.sessions) : undefined
  listSourceRef = listSource

  /** 是否已经用首帧快照建立过基线；首帧只记录不发声。 */
  let initialized = false

  /** 读两个源并各扫一遍，保证两处看到的是同一帧会话列表。 */
  const scan = (): void => {
    let state: SessionListStateFace
    try {
      state = listSource.getSnapshot()
    } catch (error) {
      console.warn('[dsh-notify-ding] 读取会话列表失败：' + String(error))
      return
    }
    const baseline = !initialized
    initialized = true
    scanSessions(state, baseline)
    try {
      scanPending(pendingSource.getSnapshot(), state, baseline)
    } catch (error) {
      console.warn('[dsh-notify-ding] 读取待回答交互失败：' + String(error))
    }
  }

  const unsubscribeList = listSource.subscribe(scan)
  const unsubscribePending = pendingSource.subscribe(scan)
  scan()

  ctx.effect(() => () => {
    unsubscribeList()
    unsubscribePending()
    if (deferredTimer !== 0) {
      window.clearTimeout(deferredTimer)
      deferredTimer = 0
    }
    deferred = null
    closeAllNotifications()
    sessionOpener = undefined
    listSourceRef = undefined
    lastCurrent = undefined
    tracks.clear()
  })
}

/** 兼容旧产物的默认导出形态：同时提供命名导出与 default。 */
export default { name, inject, apply }
