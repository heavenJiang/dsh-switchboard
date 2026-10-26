/**
 * The chat history viewer, across every line: a chat list beside the selected chat's
 * messages, read from the Host's owner-only `/api/switchboard/*` routes
 * and refreshed by polling while the page is open and visible.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import type { ChatAttachment, ChatEntry, ChatPage, ChatStats, ChatSummary } from '../history-types.ts'
import type { TelegramBridgeLocaleKey } from './locales.ts'
import { pendingRequests } from './MembersView.tsx'
import type { UpdateCheck } from './update.ts'

/** Connection state as the Host reports it. */
type BridgeState =
  | { kind: 'stopped' } | { kind: 'connecting' } | { kind: 'running'; username: string } | { kind: 'error'; message: string }

/** One line and its connection. */
interface LineStatus {
  id: string
  type: 'telegram' | 'feishu'
  name: string
  state: BridgeState
  /** Messages waiting for the line to come back. */
  queued?: number
}

/** What the page asks of the rest of the Web client. */
export interface PanelActions {
  /** Show a Session's conversation; false when the client cannot. */
  openSession(sessionId: string): boolean
  /** Open the bundle's page on the Plugins panel. */
  openSettings(): void
  /** Hook: the shared update check (installed version, source, newer release). */
  useUpdate(): UpdateCheck | undefined
  /** The Lines, Settings, and Members tabs, rendered over the shared settings form. */
  Lines: ComponentType<{ t: T }>
  Settings: ComponentType<{ t: T }>
  Members: ComponentType<{ t: T; chats: readonly ChatSummary[] | undefined }>
}

type Tab = 'chats' | 'lines' | 'members' | 'settings'
const TAB_KEY = 'dsh-switchboard:tab'

function readTab(): Tab {
  try {
    const value = localStorage.getItem(TAB_KEY)
    return value === 'lines' || value === 'members' || value === 'settings' ? value : 'chats'
  } catch {
    return 'chats'
  }
}

type T = (key: TelegramBridgeLocaleKey) => string

const API = 'api/switchboard'
const POLL_MS = 3000
const PAGE = 100

async function post<V>(path: string, body: object = {}): Promise<V> {
  const response = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json() as V
}

/** Run `tick` now and every `ms` while the document is visible. */
function usePolling(tick: () => Promise<void>, ms: number, deps: readonly unknown[]): void {
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async (): Promise<void> => {
      if (stopped) return
      if (document.visibilityState === 'visible') await tick().catch(() => {})
      if (!stopped) timer = setTimeout(() => { void run() }, ms)
    }
    void run()
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer)
        void run()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

/**
 * Build the panel component over the client's navigation actions.
 * @param actions - session and settings navigation.
 * @returns the `main` slot component.
 */
export function createTelegramPanel(actions: PanelActions) {
  return function TelegramPanel({ t }: { t: T }): ReactNode {
    const [lines, setLines] = useState<LineStatus[]>([])
    const [chats, setChats] = useState<ChatSummary[] | undefined>(undefined)
    const [failed, setFailed] = useState(false)
    const [selected, setSelected] = useState<string | undefined>(undefined)
    const [query, setQuery] = useState('')
    const [stats, setStats] = useState<ChatStats | undefined>(undefined)
    const [tab, setTabState] = useState<Tab>(readTab)
    const setTab = (next: Tab): void => {
      setTabState(next)
      try { localStorage.setItem(TAB_KEY, next) } catch { /* the tab is a convenience */ }
    }
    const update = actions.useUpdate()

    usePolling(async () => {
      try {
        const overview = await post<{ state: BridgeState; lines?: LineStatus[]; chats: ChatSummary[]; stats?: ChatStats }>('overview')
        setLines(overview.lines ?? [{ id: 'telegram', type: 'telegram', name: 'Telegram', state: overview.state }])
        setStats(overview.stats)
        setChats(overview.chats)
        setFailed(false)
      } catch {
        setFailed(true)
      }
    }, POLL_MS, [])

    const visible = useMemo(() => {
      const needle = query.trim().toLowerCase()
      if (chats === undefined || needle === '') return chats ?? []
      return chats.filter(chat => [chat.title, chat.username ?? '', String(chat.chatId), chat.lastText]
        .some(value => value.toLowerCase().includes(needle)))
    }, [chats, query])
    const current = chats?.find(chat => chat.chatId === selected)
    const pending = pendingRequests(chats ?? []).length
    const lineTrouble = lines.some(line => line.state.kind === 'error') || lines.some(line => (line.queued ?? 0) > 0)
    const tabs: [Tab, TelegramBridgeLocaleKey, ReactNode][] = [
      ['chats', 'tabChats', null],
      ['lines', 'tabLines', lineTrouble ? <i className="tgb-dot" data-tone="error" /> : null],
      ['members', 'tabMembers', pending > 0 ? <span className="tgb-count">{pending}</span> : null],
      ['settings', 'tabSettings', null],
    ]

    return (
      <div className="tgb-container">
        <nav className="tgb-tabs" role="tablist" aria-label={t('panel')}>
          <span className="tgb-tabs-title"><ConsoleIcon size={18} /> {t('panel')}</span>
          {tabs.map(([id, label, badge]) => (
            <button key={id} type="button" role="tab" className="tgb-tabbtn" aria-selected={tab === id} onClick={() => { setTab(id) }}>
              {t(label)}{badge}
            </button>
          ))}
          <span className="tgb-tabs-end">
            {update?.newer === true && update.latest !== undefined && (
              <button type="button" className="tgb-new-badge" title={`${t('newVersion')} v${update.latest.version}`} onClick={actions.openSettings}>
                {t('newBadge')} ↑ v{update.latest.version}
              </button>
            )}
          </span>
        </nav>
        {tab !== 'chats'
          ? (
            <div className="tgb-page">
              <div className="tgb-page-inner">
                {tab === 'lines' && <actions.Lines t={t} />}
                {tab === 'members' && <actions.Members t={t} chats={chats} />}
                {tab === 'settings' && (
                  <>
                    <actions.Settings t={t} />
                    <footer className="tgb-info tgb-info-page">
                      <span>{t('pluginInfo')}: dsh-switchboard{update === undefined ? '' : ` v${update.installed}`}</span>
                      {update?.source.kind === 'github' && (
                        <>· <a href={`https://github.com/${update.source.owner}/${update.source.repo}`} target="_blank" rel="noreferrer">GitHub</a></>
                      )}
                      · <button type="button" onClick={actions.openSettings}>{t('pluginPage')}</button>
                    </footer>
                  </>
                )}
              </div>
            </div>
          )
          : (
        <div className="tgb-root" data-view={current === undefined ? 'list' : 'thread'}>
          <aside className="tgb-list">
            <div className="tgb-list-head">
              <div className="tgb-lines">
                {lines.length === 0
                  ? <StateBadge state={{ kind: 'stopped' }} t={t} />
                  : lines.map(line => (
                    <Fragment key={line.id}>
                      <StateBadge state={line.state} line={line} t={t} />
                      {(line.queued ?? 0) > 0 && <span className="tgb-tag" data-tone="warn">{t('lineQueued').replace('{n}', String(line.queued))}</span>}
                    </Fragment>
                  ))}
              </div>
              {chats !== undefined && chats.length > 0 && (
                <input className="tgb-search" type="search" placeholder={t('search')} value={query}
                  onChange={(event) => { setQuery(event.target.value) }} />
              )}
            </div>
            <div className="tgb-chats" role="list">
              {chats === undefined
                ? <p className="tgb-status">{failed ? t('loadFailed') : t('loading')}</p>
                : visible.map(chat => (
                  <button key={chat.chatId} type="button" role="listitem" className="tgb-chat"
                    aria-current={chat.chatId === selected}
                    onClick={() => { setSelected(chat.chatId) }}>
                    <Avatar id={chat.chatId} name={chat.title} />
                    <span className="tgb-chat-main">
                      <span className="tgb-chat-top">
                        <span className="tgb-chat-name">{chat.title}</span>
                        <span className="tgb-chat-time">{shortTime(chat.lastAt, t)}</span>
                      </span>
                      <span className="tgb-chat-bottom">
                        <span className="tgb-chat-preview">{chat.lastText || '—'}</span>
                        {lines.length > 1 && <span className="tgb-tag" data-channel={chat.channel}>{lineName(lines, chat)}</span>}
                        {chat.deniedOnly && <span className="tgb-tag" data-tone="error">{t('deniedTag')}</span>}
                      </span>
                    </span>
                  </button>
                ))}
            </div>
          </aside>
          <section className="tgb-thread">
            {chats !== undefined && chats.length === 0
              ? <EmptyState t={t} onSettings={() => { setTab('lines') }} />
              : current === undefined
                ? <Dashboard stats={stats} t={t} />
                : <Thread key={current.chatId} chat={current} line={lineName(lines, current)} t={t} actions={actions} onBack={() => { setSelected(undefined) }} />}
          </section>
        </div>
          )}
      </div>
    )
  }
}

function StateBadge({ state, line, t }: { state: BridgeState; line?: LineStatus; t: T }): ReactNode {
  const status = state.kind === 'running' ? `${line?.type === 'feishu' ? '' : '@'}${state.username}`
    : state.kind === 'connecting' ? t('stateConnecting')
      : state.kind === 'error' ? t('stateError') : t('stateStopped')
  const label = line === undefined ? status : `${line.name} · ${status}`
  return <span className="tgb-state" data-kind={state.kind} title={state.kind === 'error' ? state.message : undefined}>{label}</span>
}

/** The display name of a chat's line. */
function lineName(lines: readonly LineStatus[], chat: ChatSummary): string {
  const id = chat.line ?? 'telegram'
  return lines.find(line => line.id === id)?.name ?? id
}

/** The platform's own id inside a chat key. */
function nativeId(key: string): string {
  const at = key.indexOf(':')
  return at < 0 ? key : key.slice(at + 1)
}

function EmptyState({ t, onSettings }: { t: T; onSettings: () => void }): ReactNode {
  return (
    <div className="tgb-empty">
      <span className="tgb-empty-icon"><ConsoleIcon size={48} /></span>
      <strong>{t('noChats')}</strong>
      <p>{t('noChatsHint')}</p>
      <button type="button" className="tgb-button" onClick={onSettings}>{t('openSettings')}</button>
    </div>
  )
}

/** One chat's messages: newest page first, older pages on demand, polled for new entries. */
function Thread({ chat, line, t, actions, onBack }: { chat: ChatSummary; line: string; t: T; actions: PanelActions; onBack: () => void }): ReactNode {
  const [entries, setEntries] = useState<ChatEntry[] | undefined>(undefined)
  const [more, setMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [sender, setSender] = useState<string | undefined>(undefined)
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  usePolling(async () => {
    const page = await post<ChatPage>('history', { chatId: chat.chatId, limit: PAGE })
    setEntries((previous) => {
      if (previous === undefined) {
        setMore(page.more)
        return page.entries
      }
      const known = new Set(previous.map(entry => entry.id))
      const added = page.entries.filter(entry => !known.has(entry.id))
      return added.length === 0 ? previous : [...previous, ...added]
    })
  }, POLL_MS, [chat.chatId])

  // Follow new messages only while the reader is at the bottom.
  useEffect(() => {
    const node = scroller.current
    if (node !== null && stickToBottom.current) node.scrollTop = node.scrollHeight
  }, [entries])

  const loadOlder = useCallback(async () => {
    const first = entries?.[0]
    if (first === undefined) return
    setLoadingOlder(true)
    const node = scroller.current
    const fromBottom = node === null ? 0 : node.scrollHeight - node.scrollTop
    try {
      const page = await post<ChatPage>('history', { chatId: chat.chatId, before: first.id, limit: PAGE })
      stickToBottom.current = false
      setEntries(previous => [...page.entries, ...(previous ?? [])])
      setMore(page.more)
      requestAnimationFrame(() => { if (node !== null) node.scrollTop = node.scrollHeight - fromBottom })
    } finally {
      setLoadingOlder(false)
    }
  }, [chat.chatId, entries])

  const meta = [
    line,
    chat.type === 'private' ? t('privateChat') : t('groupChat'),
    chat.username === undefined ? undefined : `@${chat.username}`,
    chat.model === undefined ? undefined : `🧠 ${chat.model}`,
    `ID ${nativeId(chat.chatId)}`,
    `${chat.count} ${t('messages')}`,
  ].filter(Boolean).join(' · ')

  return (
    <>
      <header className="tgb-thread-head">
        <button type="button" className="tgb-button tgb-back" onClick={onBack}>‹ {t('back')}</button>
        <Avatar id={chat.chatId} name={chat.title} />
        <div className="tgb-thread-title">
          <h2 className="tgb-thread-name">{chat.title}</h2>
          <span className="tgb-thread-meta">{meta}</span>
        </div>
        {chat.sessionId === undefined
          ? <span className="tgb-tag">{t('noSession')}</span>
          : (
            <button type="button" className="tgb-button" title={chat.sessionId}
              onClick={() => { if (chat.sessionId !== undefined) actions.openSession(chat.sessionId) }}>
              {t('openSession')} ↗
            </button>
          )}
      </header>
      <div className="tgb-messages" ref={scroller} onScroll={(event) => {
        const node = event.currentTarget
        stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
      }} onLoadCapture={(event) => {
        // Images load after layout and grow the list; keep a bottom reader at the bottom.
        if (stickToBottom.current) event.currentTarget.scrollTop = event.currentTarget.scrollHeight
      }}>
        {entries === undefined && <p className="tgb-status">{t('loading')}</p>}
        {more && (
          <button type="button" className="tgb-button tgb-older" disabled={loadingOlder} onClick={() => { void loadOlder() }}>
            {loadingOlder ? t('loading') : t('loadOlder')}
          </button>
        )}
        {chat.type !== 'private' && entries !== undefined && (
          <SenderChips entries={entries} selected={sender} onSelect={setSender} t={t} />
        )}
        {(sender === undefined ? entries : entries?.filter(entry => entry.from !== undefined && String(entry.from.id) === sender))?.map((entry, index, shown) => (
          <Fragment key={entry.id}>
            {(index === 0 || !sameDay(shown[index - 1]!.at, entry.at)) && <div className="tgb-day">{dayLabel(entry.at, t)}</div>}
            <Entry entry={entry} chat={chat} t={t} />
          </Fragment>
        ))}
      </div>
    </>
  )
}

/** Per-member filter for group chats: who sent how much. */
function SenderChips({ entries, selected, onSelect, t }: {
  entries: ChatEntry[]; selected: string | undefined; onSelect: (id: string | undefined) => void; t: T
}): ReactNode {
  const counts = new Map<string, { name: string; count: number }>()
  for (const entry of entries) {
    if (entry.dir !== 'in' || entry.from === undefined) continue
    const id = String(entry.from.id)
    const row = counts.get(id) ?? { name: entry.from.name, count: 0 }
    row.count++
    counts.set(id, row)
  }
  if (counts.size < 2) return null
  return (
    <div className="tgb-chips" role="group">
      <button type="button" className="tgb-chip" aria-pressed={selected === undefined} onClick={() => { onSelect(undefined) }}>{t('allSenders')}</button>
      {[...counts].sort((a, b) => b[1].count - a[1].count).map(([id, row]) => (
        <button key={id} type="button" className="tgb-chip" aria-pressed={selected === id} onClick={() => { onSelect(selected === id ? undefined : id) }}>
          <Avatar id={id} name={row.name} size="xs" /> {row.name} · {row.count}
        </button>
      ))}
    </div>
  )
}

/** The panel's landing view: activity figures and a 14-day chart. */
function Dashboard({ stats, t }: { stats: ChatStats | undefined; t: T }): ReactNode {
  if (stats === undefined) {
    return <div className="tgb-empty"><span className="tgb-empty-icon"><ConsoleIcon size={40} /></span><p>{t('pickChat')}</p></div>
  }
  const peak = Math.max(1, ...stats.series.map(day => day.in + day.out))
  const tiles: [string, string][] = [
    [t('dashToday'), `${stats.today.in + stats.today.out}`],
    [t('dashChats'), `${stats.week.activeChats}`],
    [t('dashApprovals'), `${stats.week.allowed} / ${stats.week.rejected}`],
    [t('dashDenied'), `${stats.week.denied}`],
  ]
  return (
    <div className="tgb-dash">
      <h2 className="tgb-dash-title">{t('dashTitle')}</h2>
      <div className="tgb-tiles">
        {tiles.map(([label, value]) => (
          <div key={label} className="tgb-tile"><span className="tgb-tile-value">{value}</span><span className="tgb-tile-label">{label}</span></div>
        ))}
      </div>
      <div className="tgb-chart">
        <div className="tgb-chart-head">
          <span>{t('dashSeries')}</span>
          <span className="tgb-legend"><i data-k="in" />{t('dashIn')} <i data-k="out" />{t('dashOut')}</span>
        </div>
        <div className="tgb-bars" role="img" aria-label={t('dashSeries')}>
          {stats.series.map(day => (
            <div key={day.day} className="tgb-bar" title={`${day.day} · ${t('dashIn')} ${day.in} · ${t('dashOut')} ${day.out}`}>
              <div className="tgb-bar-stack" style={{ height: `${((day.in + day.out) / peak) * 100}%` }}>
                <span data-k="out" style={{ flexGrow: day.out }} />
                <span data-k="in" style={{ flexGrow: day.in }} />
              </div>
              <span className="tgb-bar-label">{day.day.slice(8)}</span>
            </div>
          ))}
        </div>
      </div>
      <p className="tgb-dash-hint">{t('pickChat')}</p>
    </div>
  )
}

function Entry({ entry, chat, t }: { entry: ChatEntry; chat: ChatSummary; t: T }): ReactNode {
  const time = clock(entry.at)
  switch (entry.kind) {
    case 'tool':
      return <div className="tgb-line" data-kind="tool"><span>{entry.text}</span><span className="tgb-line-time">{time}</span></div>
    case 'notice':
      return <div className="tgb-line" data-kind="notice"><span>{entry.text}</span><span className="tgb-line-time">{time}</span></div>
    case 'denied':
      return (
        <div className="tgb-line" data-kind="denied">
          <span>⛔ {t('deniedLine')}: {entry.from?.name ?? '?'} (ID {entry.from?.id}){entry.text === undefined ? '' : ` — ${entry.text}`}</span>
          <span className="tgb-line-time">{time}</span>
        </div>
      )
    case 'approval': {
      const approval = entry.approval
      if (approval === undefined) return null
      const [label, tone] = approval.outcome === 'allowed-once' ? [t('outcomeAllowed'), 'success']
        : approval.outcome === 'rejected' ? [t('outcomeRejected'), 'error']
          : approval.outcome === 'timeout' ? [t('outcomeTimeout'), 'warn'] : [t('outcomeCancelled'), undefined]
      return (
        <div className="tgb-approval">
          <div className="tgb-approval-head">
            <span>🔐 {t('approvalTitle')} · {approval.tool}</span>
            <span className="tgb-tag" data-tone={tone}>{label}</span>
          </div>
          {approval.detail !== undefined && <pre>{approval.detail}</pre>}
          {entry.text !== undefined && <span className="tgb-approval-meta">{entry.text}</span>}
          <span className="tgb-approval-meta">{time}{approval.by === undefined ? '' : ` · ${t('by')} ${approval.by}`}</span>
        </div>
      )
    }
    default: {
      const incoming = entry.dir === 'in'
      const name = incoming ? (chat.type === 'private' ? undefined : entry.from?.name) : undefined
      const images = (entry.attachments ?? []).filter(a => a.kind === 'image' && a.media !== undefined)
      const files = (entry.attachments ?? []).filter(a => !(a.kind === 'image' && a.media !== undefined))
      return (
        <div className="tgb-row" data-dir={entry.dir}>
          {incoming && chat.type !== 'private' && <Avatar id={entry.from?.id ?? 0} name={entry.from?.name ?? '?'} size="sm" />}
          <div className="tgb-bubble">
            {name !== undefined && <div className="tgb-sender">{name}</div>}
            {images.length > 0 && (
              <div className="tgb-images" data-count={images.length === 1 ? 1 : undefined}>
                {images.map(image => (
                  <a key={image.media} href={mediaUrl(chat.chatId, image.media!)} target="_blank" rel="noreferrer" title={image.name}>
                    <img src={mediaUrl(chat.chatId, image.media!)} alt={image.name} loading="lazy" />
                  </a>
                ))}
              </div>
            )}
            {files.map(file => <FileChip key={`${file.name}-${file.path ?? ''}`} file={file} />)}
            {entry.text !== undefined && entry.text !== '' && <div className="tgb-text" data-kind={entry.kind}>{entry.text}</div>}
            <div className="tgb-foot">
              {!incoming && <span>{entry.kind === 'assistant' ? t('agent') : entry.kind === 'file' ? t('sentFile') : entry.kind === 'web' ? t('webSent') : t('bot')}</span>}
              <span>{time}</span>
            </div>
          </div>
        </div>
      )
    }
  }
}

function FileChip({ file }: { file: ChatAttachment }): ReactNode {
  const extension = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1).toUpperCase().slice(0, 4) : 'FILE'
  const meta = [file.size === undefined ? undefined : bytes(file.size), file.path].filter(Boolean).join(' · ')
  return (
    <div className="tgb-file" title={file.path ?? file.name}>
      <span className="tgb-file-icon">{file.kind === 'image' ? '🖼' : extension.length <= 3 ? extension : '📄'}</span>
      <span className="tgb-file-main">
        <span className="tgb-file-name">{file.name}</span>
        {meta !== '' && <span className="tgb-file-meta">{meta}</span>}
      </span>
    </div>
  )
}

const AVATAR_COLORS = ['#e17076', '#faa774', '#a695e7', '#7bc862', '#6ec9cb', '#65aadd', '#ee7aae']

function Avatar({ id, name, size }: { id: string | number; name: string; size?: 'sm' | 'xs' }): ReactNode {
  const hash = [...String(id)].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 1_000_003, 0)
  const color = AVATAR_COLORS[hash % AVATAR_COLORS.length]
  const initial = [...name.trim()][0]?.toUpperCase() ?? '?'
  return <span className="tgb-avatar" data-size={size} style={{ background: color }} aria-hidden="true">{initial}</span>
}

/**
 * Switchboard mark: a chat bubble holding a command prompt, drawn in the
 * current text color for the sidebar entry, the Session tab, and empty states.
 * @param props.size - icon edge in pixels.
 */
export function ConsoleIcon({ size }: { size: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4.5 7.2A3.2 3.2 0 0 1 7.7 4h8.6a3.2 3.2 0 0 1 3.2 3.2v6.1a3.2 3.2 0 0 1-3.2 3.2h-4.6l-3.6 3.1c-.4.3-.9 0-.9-.4v-2.7h0a2.7 2.7 0 0 1-2.7-2.7V7.2Z"
        stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="m8.6 8.4 2.3 1.9-2.3 1.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.6 12.4h2.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function mediaUrl(chatId: string, name: string): string {
  return `${API}/media?chat=${encodeURIComponent(chatId)}&name=${encodeURIComponent(name)}`
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

function dayLabel(at: number, t: T): string {
  const day = new Date(at)
  const today = new Date()
  if (day.toDateString() === today.toDateString()) return t('today')
  if (day.toDateString() === new Date(today.getTime() - 86_400_000).toDateString()) return t('yesterday')
  return day.toLocaleDateString(undefined, { year: day.getFullYear() === today.getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric' })
}

function shortTime(at: number, t: T): string {
  return sameDay(at, Date.now()) ? clock(at) : dayLabel(at, t)
}

function bytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
