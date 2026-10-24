/**
 * The Telegram tab inside a Session: which chats are linked to it, linking
 * another chat (bind to talk, or follow for notices), sending a message as
 * the bot, and the Session's Telegram activity. Data comes from the Host's
 * owner-only `/api/telegram-bridge/session` route, polled while visible.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ChatEntry, ChatSummary } from '../history-types.ts'
import type { TelegramBridgeLocaleKey } from './locales.ts'

type T = (key: TelegramBridgeLocaleKey) => string

interface SessionView {
  connected: boolean
  links: { chatId: number; mode: 'active' | 'watch'; title: string }[]
  chats: ChatSummary[]
  entries: (ChatEntry & { chatId: number })[]
}

const POLL_MS = 4000

async function post<V>(path: string, body: object): Promise<V> {
  const response = await fetch(`api/telegram-bridge/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const value = await response.json() as V & { error?: string }
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
  return value
}

const KIND_ICON: Partial<Record<ChatEntry['kind'], string>> = {
  text: '💬', command: '⌨️', media: '📎', assistant: '🤖', tool: '🔧', notice: 'ℹ️', file: '📤', approval: '🔐', web: '🖥', denied: '⛔',
}

/**
 * Render the tab for one Session.
 * @param props.sessionId - the Session the conversation view shows.
 */
export function SessionTab({ sessionId, t }: { sessionId: string; t: T }): ReactNode {
  const [view, setView] = useState<SessionView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [picked, setPicked] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setView(await post<SessionView>('session', { sessionId }))
      setError(undefined)
    } catch (failure: unknown) {
      setError(String(failure))
    }
  }, [sessionId])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      if (document.visibilityState === 'visible') await load()
      if (!stopped) timer = setTimeout(() => { void tick() }, POLL_MS)
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [load])

  const act = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await operation()
      await load()
    } catch (failure: unknown) {
      setError(String(failure))
    } finally {
      setBusy(false)
    }
  }
  const link = (chatId: number, mode: 'active' | 'watch' | 'none'): Promise<void> => act(() => post('link', { chatId, sessionId, mode }))

  if (view === undefined) return <div className="tgb-tab"><p className="tgb-status">{error ?? t('loading')}</p></div>
  const titleOf = (chatId: number): string => view.chats.find(chat => chat.chatId === chatId)?.title ?? String(chatId)
  const bound = view.links.filter(item => item.mode === 'active')
  const linkable = view.chats.filter(chat => !view.links.some(item => item.chatId === chat.chatId))

  return (
    <div className="tgb-tab">
      {!view.connected && <p className="tgb-tab-warn">{t('tabDisconnected')}</p>}
      {error !== undefined && <p className="tgb-tab-warn">{error}</p>}

      <section className="tgb-card">
        <h3>{t('tabLinked')}</h3>
        {view.links.length === 0
          ? <p className="tgb-muted">{t('tabNone')}</p>
          : (
            <ul className="tgb-links">
              {view.links.map(item => (
                <li key={item.chatId}>
                  <span className="tgb-link-title">{item.title}</span>
                  <span className="tgb-tag" data-tone={item.mode === 'active' ? 'success' : undefined}>{item.mode === 'active' ? t('tabActive') : t('tabWatch')}</span>
                  <button type="button" className="tgb-button" disabled={busy} onClick={() => { void link(item.chatId, 'none') }}>{t('tabUnlink')}</button>
                </li>
              ))}
            </ul>
          )}
        {view.chats.length === 0
          ? <p className="tgb-muted">{t('tabNoChats')}</p>
          : linkable.length > 0 && (
            <div className="tgb-link-row">
              <select className="tgb-select" aria-label={t('tabLinkTo')} value={picked} onChange={(event) => { setPicked(event.target.value) }}>
                <option value="">{t('tabPickChat')}</option>
                {linkable.map(chat => (
                  <option key={chat.chatId} value={chat.chatId}>{chat.title}{chat.username === undefined ? '' : ` @${chat.username}`}</option>
                ))}
              </select>
              <button type="button" className="tgb-button tgb-button-primary" disabled={busy || picked === ''}
                onClick={() => { void link(Number(picked), 'active').then(() => { setPicked('') }) }}>{t('tabBind')}</button>
              <button type="button" className="tgb-button" disabled={busy || picked === ''}
                onClick={() => { void link(Number(picked), 'watch').then(() => { setPicked('') }) }}>{t('tabWatchBtn')}</button>
            </div>
          )}
        <p className="tgb-muted tgb-small">{t('tabBindHint')}</p>
      </section>

      {bound.length > 0 && (
        <section className="tgb-card">
          <h3>{t('tabSend')}</h3>
          <textarea className="tgb-textarea" rows={3} placeholder={t('tabSendPlaceholder')} value={draft}
            onChange={(event) => { setDraft(event.target.value) }} />
          <div className="tgb-link-row tgb-end">
            <span className="tgb-muted tgb-small">{bound.map(item => item.title).join('、')}</span>
            <button type="button" className="tgb-button tgb-button-primary" disabled={busy || draft.trim() === '' || !view.connected}
              onClick={() => {
                void act(async () => {
                  for (const item of bound) await post('send', { chatId: item.chatId, text: draft })
                  setDraft('')
                })
              }}>{t('tabSendBtn')}</button>
          </div>
        </section>
      )}

      <section className="tgb-card">
        <h3>{t('tabHistory')}</h3>
        {view.entries.length === 0
          ? <p className="tgb-muted">{t('tabNoHistory')}</p>
          : (
            <ol className="tgb-activity">
              {[...view.entries].reverse().map(entry => (
                <li key={`${entry.chatId}-${entry.id}`} data-dir={entry.dir}>
                  <span className="tgb-activity-icon" aria-hidden="true">{KIND_ICON[entry.kind] ?? '·'}</span>
                  <span className="tgb-activity-body">
                    <span className="tgb-activity-meta">
                      {new Date(entry.at).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      {' · '}{titleOf(entry.chatId)}{entry.from === undefined ? '' : ` · ${entry.from.name}`}
                    </span>
                    <span className="tgb-activity-text">
                      {entry.approval !== undefined ? `${entry.approval.tool} → ${entry.approval.outcome}` : ''}
                      {entry.attachments?.map(a => a.name).join(', ')}
                      {entry.text === undefined ? '' : ` ${entry.text.length > 280 ? `${entry.text.slice(0, 279)}…` : entry.text}`}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
      </section>
    </div>
  )
}
