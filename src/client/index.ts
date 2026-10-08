/**
 * dsh-notify-ding 的浏览器半身。
 *
 * 只做两件事：判断「该响了」，然后弹一条浏览器系统通知。
 * 提示音由系统通知自带，插件不另外发声，全屏专注时通知音会被系统一并静音。
 *
 * 触发条件有两个：
 * 1. 某个会话出现了新的等待回复交互，question / plan-review / approval 都算；
 * 2. 某个会话从「执行中」落到「空闲」，即一轮对话跑完；会话的目标还在自动续跑时照样响，只是改报「目标进行中」，横幅自动消失，免得每轮堆一条常驻通知。
 *
 * 按用户选择，两种都响，且不判断页面是否聚焦、不区分是否为当前会话。
 * 重复靠两道闸门挡：同一待回答请求的 key 只响一次，以及跨标签页共享的最小间隔，避免多开标签页时同一件事响好几轮。
 *
 * 通知不设自动关闭时间，会一直挂在系统通知里，直到对应会话发生操作：会话被选中、该会话开始新一轮、待回答被解决，或会话从列表移除。每个会话最多只保留最新一条，新通知会顶掉旧的；点击通知会聚焦窗口并切到该会话。
 *
 * 一轮结束的通知在会话还有后台任务在跑时，把「已空闲」换成任务数量摘要：任务常常活过一轮，只说已空闲会让人以为全都干完了。名册来自 ctx.jobs，按会话引用计数订阅；组合里没有 job-controller 时照旧报「已空闲」。
 *
 * @module dsh-notify-ding/client
 */
/** 插件名，同时也是配置项 id。 */
export const name = 'dsh-notify-ding'

/**
 * 本插件需要的客户端服务。
 *
 * ctx.jobs 不在其中：组合里可能没有 job-controller，缺了它只是通知里少一行后台任务，不该让整个插件不加载，所以按可选服务读取。
 */
export const inject = ['uiSession', 'sessions']

/** 两次响铃之间的最小间隔，窗口内的合并成一次。 */
const MIN_INTERVAL_MS = 800

/** 跨标签页共享「上次响铃时刻」的 localStorage 键。 */
const LAST_DING_KEY = 'dsh-notify-ding.lastDingAt'

/** 通知正文里任务详情最多列几个，超出只报总数。 */
const JOB_DETAIL_LIMIT = 3

/** 任务详情里单个任务名的最大长度，超出取头截断。 */
const JOB_DETAIL_LABEL_LIMIT = 24

/** goal 处于这个持久阶段时 DSH 会自动续跑下一轮，一轮结束不等于轮到用户。 */
const GOAL_ACTIVE_PHASE = 'active'

/** 目标自动续跑时那轮空闲的通知标题，内容只在通知中心留一小会儿。 */
const GOAL_PROGRESS_TITLE = 'DSH 目标进行中'

/** 当前挂在系统通知里、按会话索引的通知，新通知会顶掉同会话的旧通知。 */
const liveNotifications = new Map<string, Notification>()

/** 打开会话的入口，由 apply 从 ctx.sessions 注入；缺失时点击通知只关通知。 */
let sessionOpener: ((id: string) => void) | undefined

/** 会话列表快照源，点击通知切会话前用它确认会话还在。 */
let listSourceRef: SnapshotSourceFace<SessionListStateFace> | undefined

/** 上一帧被选中的会话，用来识别「用户选中了某个会话」这个操作信号。 */
let lastCurrent: string | undefined

/** 一个等待回复的交互，只关心其稳定 key。 */
interface PendingInteractionFace {
  readonly key: string
}

/** 一条会话摘要里本插件用得到的字段。 */
interface SessionSummaryFace {
  readonly id: string
  readonly displayTitle?: string
  readonly running: boolean
  /** 宿主算好的投影值；本插件只关心 goal。 */
  readonly projectionValues?: {
    readonly goal?: {
      readonly goal?: { readonly phase?: string }
      readonly roundsStarted?: number
    } | null
  }
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

/** 后台任务名册里一行本插件用得到的字段。 */
interface JobRowFace {
  readonly id: string
  readonly label: string
  readonly status: string
  readonly owner?: string
}

/** 后台任务名册快照里本插件用得到的字段。 */
interface JobsStateFace {
  readonly rows: Readonly<Record<string, readonly JobRowFace[]>>
}

/** 客户端后台任务服务 ctx.jobs 里本插件用得到的部分。 */
interface JobsFace {
  readonly state: { getSnapshot(): JobsStateFace }
  watchRows(sessionId: string): () => void
}

/** uiSession 状态快照里本插件用得到的一行。 */
interface SessionStatusFace {
  readonly pendingInteraction?: PendingInteractionFace
}

/** 会话状态快照源，按会话 id 索引。 */
type SessionStatusSourceFace = SnapshotSourceFace<ReadonlyMap<string, SessionStatusFace>>

/** 浏览器与服务两端都够用的一小片客户端上下文。 */
interface NotifyClientContext {
  readonly sessions: {
    readonly list: SnapshotSourceFace<SessionListStateFace>
    open?(id: string): void
  }
  readonly uiSession: { readonly sessionStatus: SessionStatusSourceFace }
  effect(callback: () => (() => void) | void): void
  /** 按名字取可选客户端服务；组合里没有的服务返回 undefined。 */
  get?(name: string): unknown
}

/** 每个会话在上一帧里的运行态与已见过的待回答 key。 */
interface SessionTrack {
  running: boolean
  pendingKeys: Set<string>
}

/** 记录各会话上一帧状态，用来做边沿检测。 */
const tracks = new Map<string, SessionTrack>()

/** 已经持有引用的后台任务名册，键为会话 id，值为释放函数。 */
const watchedRosters = new Map<string, () => void>()

/** 客户端后台任务服务，apply 时解析；组合里没有 job-controller 时保持 undefined。 */
let jobsFace: JobsFace | undefined

/** 本页面上次响铃的时间戳，兜住同一帧内的重复触发。 */
let lastDingAt = 0

/** 因节流被暂时压下的最新一条待响请求，窗口过后补发。 */
let deferred: { sessionId: string; title: string; body: string; transient: boolean } | null = null

/** 补发定时器的句柄，0 表示当前没有挂起的补发。 */
let deferredTimer = 0

/**
 * 读取跨标签页共享的上次响铃时刻。
 *
 * localStorage 可能因隐私模式或禁用存储而抛错，抛错时按 0 处理即可，最坏退化成只在单个标签页内节流。
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
 * 浏览器未授权时不强行索要权限，而是记下需要补授权，等到用户下一次与页面交互时再请求——权限请求必须由用户手势触发。
 *
 * @param sessionId 这条通知所属的会话。
 * @param title 通知标题。
 * @param body 通知正文。
 * @param transient 是否临时提示；true 时不要求常驻，横幅按系统默认时长自动消失。
 */
function showSystemNotification(sessionId: string, title: string, body: string, transient: boolean): void {
  if (typeof Notification === 'undefined') return

  const present = (): void => {
    closeNotification(sessionId)
    try {
      const notification = new Notification(title, { body, requireInteraction: !transient })
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
 * 被节流压下的请求不会直接丢弃，而是挂到窗口边界的定时器上补发，这样连续两次状态变化仍然各响一次，只是间隔被拉开，不会出现漏报。
 * 正文由调用方在触发那一刻算好，补发的通知因此带的是触发时刻的任务名册。
 *
 * @param sessionId 这条通知所属的会话。
 * @param title 通知标题。
 * @param body 通知正文。
 * @param transient 是否临时提示；目标续跑那种报个信就够的用 true，横幅自动消失。
 */
function ding(sessionId: string, title: string, body: string, transient = false): void {
  const now = Date.now()
  const since = now - Math.max(lastDingAt, readSharedLastDing())
  if (since < 0 || since >= MIN_INTERVAL_MS) {
    lastDingAt = now
    writeSharedLastDing(now)
    showSystemNotification(sessionId, title, body, transient)
    return
  }
  deferred = { sessionId, title, body, transient }
  if (deferredTimer !== 0) return
  deferredTimer = window.setTimeout(() => {
    deferredTimer = 0
    const pending = deferred
    deferred = null
    if (pending === null) return
    const stamp = Date.now()
    lastDingAt = stamp
    writeSharedLastDing(stamp)
    showSystemNotification(pending.sessionId, pending.title, pending.body, pending.transient)
  }, MIN_INTERVAL_MS - since)
}

/** 会话标题，缺失时退回会话 id，保证通知里总有个能认的名字。 */
function titleOf(summary: SessionSummaryFace | undefined, fallbackId: string): string {
  const raw = summary?.displayTitle
  return raw && raw.length > 0 ? raw : fallbackId
}

/** 从客户端上下文取后台任务服务；组合里没有 job-controller 时返回 undefined。 */
function readJobsFace(ctx: NotifyClientContext): JobsFace | undefined {
  try {
    return ctx.get?.('jobs') as JobsFace | undefined
  } catch (error) {
    console.warn('[dsh-notify-ding] 读取后台任务服务失败：' + String(error))
    return undefined
  }
}

/** 开始持有某会话的后台任务名册引用；没有该服务或已经持有则什么都不做。 */
function watchRoster(sessionId: string): void {
  if (jobsFace === undefined || watchedRosters.has(sessionId)) return
  try {
    watchedRosters.set(sessionId, jobsFace.watchRows(sessionId))
  } catch (error) {
    console.warn('[dsh-notify-ding] 订阅后台任务名册失败：' + String(error))
  }
}

/** 释放某会话的后台任务名册引用，会话从列表移除或插件卸载时调用。 */
function unwatchRoster(sessionId: string): void {
  const release = watchedRosters.get(sessionId)
  if (release === undefined) return
  watchedRosters.delete(sessionId)
  try {
    release()
  } catch (error) {
    console.warn('[dsh-notify-ding] 释放后台任务名册失败：' + String(error))
  }
}

/** 释放全部后台任务名册引用，插件卸载时收尾。 */
function unwatchAllRosters(): void {
  for (const sessionId of Array.from(watchedRosters.keys())) unwatchRoster(sessionId)
}

/**
 * 挑出某会话仍在跑的后台任务。
 *
 * 只取归属该会话的任务：无主任务会出现在每个会话的名册里，列进去会在每条通知里重复。
 *
 * @param sessionId 通知所属会话。
 * @returns 名册里归属该会话且仍在运行的行；没有则为空数组。
 */
function runningJobs(sessionId: string): readonly JobRowFace[] {
  const rows = jobsFace?.state.getSnapshot().rows[sessionId]
  if (rows === undefined || rows.length === 0) return []
  return rows.filter((row) => {
    if (row.status !== 'running' && row.status !== 'stopping') return false
    return row.owner !== undefined && String(row.owner) === sessionId
  })
}

/** 单个任务在详情行里的短名字，标签为空时退回 id，过长时取头截断。 */
function describeJob(row: JobRowFace): string {
  const label = row.label.trim()
  if (label.length === 0) return row.id
  const head = label.length > JOB_DETAIL_LABEL_LIMIT ? label.slice(0, JOB_DETAIL_LABEL_LIMIT) + '…' : label
  return row.id + ' ' + head
}

/**
 * 一轮结束时的通知正文。
 *
 * 还有后台任务时，「已空闲」的位置报数量，次一级的位置列出任务详情的前几个；任务常常活过一轮，只说已空闲会让人以为全都干完了。
 *
 * @param sessionId 通知所属会话。
 * @param title 会话标题。
 * @returns 通知正文，需要时带一个换行分成两行。
 */
function idleBody(sessionId: string, title: string): string {
  let running: readonly JobRowFace[]
  try {
    running = runningJobs(sessionId)
  } catch (error) {
    console.warn('[dsh-notify-ding] 读取后台任务名册失败：' + String(error))
    return title + ' 已空闲'
  }
  if (running.length === 0) return title + ' 已空闲'
  const details = running.slice(0, JOB_DETAIL_LIMIT).map(describeJob).join('、')
  const rest = running.length > JOB_DETAIL_LIMIT ? ' 等 ' + running.length + ' 个' : ''
  return title + ' 后台还有 ' + running.length + ' 个任务\n' + details + rest
}

/**
 * 该会话是否有一个还会自动续跑的目标。
 *
 * 目标处于 active 时 DSH 会自己接着跑下一轮，轮与轮之间都会短暂落到空闲。
 * 这种空闲不报「完成了一轮」，改报目标进行中的临时提示，免得每轮堆一条常驻通知。
 *
 * @param summary 当前会话摘要。
 * @returns 目标处于 active 时为真。
 */
function hasActiveGoal(summary: SessionSummaryFace): boolean {
  return summary.projectionValues?.goal?.goal?.phase === GOAL_ACTIVE_PHASE
}

/**
 * 目标自动续跑时那轮空闲的通知正文。
 *
 * 这里报「完成了一轮」会让人以为可以回来看了，所以改报目标还在进行，并带上已经跑完的轮数。
 *
 * @param summary 当前会话摘要。
 * @param title 会话标题。
 * @returns 通知正文。
 */
function goalProgressBody(summary: SessionSummaryFace, title: string): string {
  const rounds = summary.projectionValues?.goal?.roundsStarted
  const progress = typeof rounds === 'number' && rounds > 0 ? '已跑 ' + rounds + ' 轮' : '正在自动续跑'
  return title + ' 目标进行中，' + progress
}

/**
 * 用一帧会话列表快照做边沿检测：新出现的待回答交互响一次，运行态从真落到假响一次。
 *
 * 首帧只建基线不响，否则每次刷新页面都会把既有状态补报一轮。
 * 同时识别「会话被操作」的信号，把对应会话还挂着的通知关掉：运行态从假升到真说明已回到该会话开始新一轮，会话被选中，以及会话从列表消失，都算一次操作。
 *
 * 选中变化先于响铃处理，否则同一帧里既跑完又刚被选中的会话，通知会建立后立刻被关掉。current 短暂变空是 DSH 的 masked gap，选中会话暂时不在列表时就会出现，不算一次操作，也不该把上一个有效选中抹掉。
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
    watchRoster(id)
    let track = tracks.get(id)
    if (!track) {
      track = { running: summary.running, pendingKeys: new Set<string>() }
      tracks.set(id, track)
    }
    if (!baseline) {
      // 一轮对话跑完：运行态下降沿响一次。目标还会自动续跑时改报「目标进行中」的临时提示，横幅自动消失，免得每轮堆一条常驻通知。
      if (track.running && !summary.running) {
        const title = titleOf(summary, id)
        if (hasActiveGoal(summary)) ding(id, GOAL_PROGRESS_TITLE, goalProgressBody(summary, title), true)
        else ding(id, 'DSH 完成了一轮', idleBody(id, title))
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
      unwatchRoster(id)
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

/** 从会话状态快照里投影出待回答交互，按会话 id 索引。 */
function readPending(statusSource: SessionStatusSourceFace): ReadonlyMap<string, PendingInteractionFace> {
  const projected = new Map<string, PendingInteractionFace>()
  for (const [id, row] of statusSource.getSnapshot()) {
    if (row.pendingInteraction) projected.set(id, row.pendingInteraction)
  }
  return projected
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
  const statusSource = ctx.uiSession.sessionStatus
  const listSource = ctx.sessions.list
  const open = ctx.sessions.open
  // 点击通知时用来切会话；入口缺失时点击只关通知。
  sessionOpener = typeof open === 'function' ? open.bind(ctx.sessions) : undefined
  listSourceRef = listSource
  jobsFace = readJobsFace(ctx)

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
      scanPending(readPending(statusSource), state, baseline)
    } catch (error) {
      console.warn('[dsh-notify-ding] 读取待回答交互失败：' + String(error))
    }
  }

  const unsubscribeList = listSource.subscribe(scan)
  const unsubscribePending = statusSource.subscribe(scan)
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
    unwatchAllRosters()
    sessionOpener = undefined
    listSourceRef = undefined
    jobsFace = undefined
    lastCurrent = undefined
    tracks.clear()
  })
}

/** 兼容旧产物的默认导出形态：同时提供命名导出与 default。 */
export default { name, inject, apply }
