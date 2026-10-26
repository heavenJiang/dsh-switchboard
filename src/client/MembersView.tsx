/**
 * The Members tab: people who asked to use a bot, one click from allowed,
 * and everyone allowed on each line, with where they talk from.
 */

import { useState, type ReactNode } from 'react'
import type { ChatSummary } from '../history-types.ts'
import { ChannelMark, type LineValue } from './LinesEditor.tsx'
import type { TelegramBridgeLocaleKey } from './locales.ts'

type T = (key: TelegramBridgeLocaleKey) => string

const IGNORED_KEY = 'dsh-switchboard:ignored-requests'

/** Requests the viewer dismissed, kept in this browser only. */
function readIgnored(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(IGNORED_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(value) ? value.map(String) : [])
  } catch {
    return new Set()
  }
}

function writeIgnored(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(IGNORED_KEY, JSON.stringify([...ids].slice(-200)))
  } catch {
    // Private windows may refuse storage; dismissals then last for this view.
  }
}

/** A stranger's request: the private chat they wrote from, and who they are. */
export function pendingRequests(chats: readonly ChatSummary[], ignored: ReadonlySet<string> = new Set()): ChatSummary[] {
  return chats.filter(chat => chat.deniedOnly && chat.type === 'private' && chat.sender !== undefined && !ignored.has(`${chat.chatId}:${chat.lastAt}`))
}

export function MembersView(props: {
  t: T
  lines: readonly LineValue[]
  chats: readonly ChatSummary[] | undefined
  busy: boolean
  onAllow: (chat: ChatSummary) => void
  onRemove: (lineId: string, userId: string) => void
}): ReactNode {
  const { t, lines, chats } = props
  const [ignored, setIgnored] = useState(readIgnored)
  const pending = pendingRequests(chats ?? [], ignored)
  const lineName = (id: string | undefined): string => {
    const line = lines.find(candidate => candidate.id === (id ?? 'telegram'))
    return line === undefined ? (id ?? 'telegram') : line.name.trim() || (line.type === 'feishu' ? t('lineTypeFeishu') : t('lineTypeTelegram'))
  }
  const lineType = (id: string | undefined) => lines.find(candidate => candidate.id === (id ?? 'telegram'))?.type ?? 'telegram'
  /** Who an allowed id is, from the chats they wrote in. */
  const person = (lineId: string, userId: string): ChatSummary | undefined => (chats ?? []).find(chat =>
    (chat.line ?? 'telegram') === lineId && chat.sender !== undefined
    && (String(chat.sender.id) === userId || (chat.sender.username !== undefined && `@${chat.sender.username.toLowerCase()}` === userId.toLowerCase())))
  const members = lines.flatMap(line => line.allowedUsers.map(userId => ({ line, userId, chat: person(line.id, userId) })))

  return (
    <div className="tgb-members">
      <section className="tgb-block">
        <header className="tgb-block-head">
          <h2>{t('membersPending')}{pending.length > 0 && <span className="tgb-count">{pending.length}</span>}</h2>
          <p>{t('membersPendingHint')}</p>
        </header>
        {chats === undefined
          ? <p className="tgb-muted">{t('loading')}</p>
          : pending.length === 0
            ? <p className="tgb-empty-line">{t('membersNoPending')}</p>
            : (
              <ul className="tgb-people">
                {pending.map(chat => (
                  <li key={chat.chatId} className="tgb-person" data-pending="true">
                    <Initial name={chat.sender!.name} />
                    <span className="tgb-person-main">
                      <span className="tgb-person-name">{chat.sender!.name}</span>
                      <span className="tgb-person-meta">
                        <ChannelMark type={lineType(chat.line)} /> {lineName(chat.line)} · {when(chat.lastAt)}
                        {chat.lastText !== '' && <> · <q>{chat.lastText}</q></>}
                      </span>
                    </span>
                    <span className="tgb-person-actions">
                      <button type="button" className="tgb-button" disabled={props.busy}
                        onClick={() => {
                          const next = new Set(ignored).add(`${chat.chatId}:${chat.lastAt}`)
                          setIgnored(next)
                          writeIgnored(next)
                        }}>{t('membersIgnore')}</button>
                      <button type="button" className="tgb-button tgb-button-primary" disabled={props.busy}
                        onClick={() => { props.onAllow(chat) }}>{t('membersAllow')}</button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
      </section>

      <section className="tgb-block">
        <header className="tgb-block-head">
          <h2>{t('membersAllowed')}<span className="tgb-count" data-tone="quiet">{members.length}</span></h2>
          <p>{t('membersAllowedHint')}</p>
        </header>
        {members.length === 0
          ? <p className="tgb-empty-line">{t('membersNone')}</p>
          : (
            <ul className="tgb-people">
              {members.map(({ line, userId, chat }) => {
                const name = chat?.sender?.name ?? userId
                return (
                  <li key={`${line.id}:${userId}`} className="tgb-person">
                    <Initial name={name} />
                    <span className="tgb-person-main">
                      <span className="tgb-person-name">{name}</span>
                      <span className="tgb-person-meta">
                        <ChannelMark type={line.type} /> {lineName(line.id)}
                        {chat?.sender !== undefined && <> · <code>{userId}</code></>}
                        {chat !== undefined && <> · {t('membersLastSeen').replace('{time}', when(chat.lastAt))}</>}
                      </span>
                    </span>
                    <span className="tgb-person-actions">
                      <button type="button" className="tgb-button tgb-button-quiet" disabled={props.busy}
                        onClick={() => {
                          if (window.confirm(t('membersRemoveConfirm').replace('{name}', name).replace('{line}', lineName(line.id)))) props.onRemove(line.id, userId)
                        }}>{t('membersRemove')}</button>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
      </section>
    </div>
  )
}

function Initial({ name }: { name: string }): ReactNode {
  const colors = ['#e17076', '#faa774', '#a695e7', '#7bc862', '#6ec9cb', '#65aadd', '#ee7aae']
  const hash = [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 1_000_003, 0)
  return <span className="tgb-avatar" style={{ background: colors[hash % colors.length] }} aria-hidden="true">{[...name.trim()][0]?.toUpperCase() ?? '?'}</span>
}

/** A short local time: today's clock, else the date. */
function when(at: number): string {
  const date = new Date(at)
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}
