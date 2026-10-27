/**
 * The Members tab: people who asked to use a bot, one click from allowed,
 * and everyone allowed on each line, with where they talk from.
 */

import { useState, type ReactNode } from 'react'
import type { ChatSummary } from '../history-types.ts'
import { ChannelMark, type LineValue } from './LinesEditor.tsx'
import type { TelegramBridgeLocaleKey } from './locales.ts'

type T = (key: TelegramBridgeLocaleKey) => string

export type Role = 'admin' | 'member' | 'guest'

/** One person's configured rights. */
export interface PersonValue {
  line: string
  id: string
  role: Role
  preset?: string
  dirs?: string[]
}

/** Permission presets a member's Sessions may use. */
const PRESETS: [string, TelegramBridgeLocaleKey][] = [['read-only', 'presetReadOnly'], ['workspace-write', 'presetWorkspaceWrite'], ['danger-full-access', 'presetFullAccess']]

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
  people: readonly PersonValue[]
  /** The working directory people without directories are kept to. */
  defaultDir: string
  busy: boolean
  onAllow: (chat: ChatSummary) => void
  onRemove: (lineId: string, userId: string) => void
  /** Store a person's rights; admin removes the record. */
  onPerson: (person: PersonValue) => void
}): ReactNode {
  const { t, lines, chats } = props
  const [open, setOpen] = useState<string | undefined>(undefined)
  const recordOf = (lineId: string, userId: string): PersonValue => props.people.find(person => person.line === lineId && person.id.toLowerCase() === userId.toLowerCase())
    ?? { line: lineId, id: userId, role: 'admin' }
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
                const rowKey = `${line.id}:${userId}`
                const record = recordOf(line.id, userId)
                const expanded = open === rowKey && record.role !== 'admin'
                return (
                  <li key={rowKey} className="tgb-person-block">
                    <div className="tgb-person">
                      <Initial name={name} />
                      <span className="tgb-person-main">
                        <span className="tgb-person-name">{name}</span>
                        <span className="tgb-person-meta">
                          <ChannelMark type={line.type} /> {lineName(line.id)}
                          {chat?.sender !== undefined && <> · <code>{userId}</code></>}
                          {chat !== undefined && <> · {t('membersLastSeen').replace('{time}', when(chat.lastAt))}</>}
                        </span>
                        {record.role !== 'admin' && (
                          <button type="button" className="tgb-person-scope" onClick={() => { setOpen(expanded ? undefined : rowKey) }}>
                            {scopeLabel(t, record, props.defaultDir)} {expanded ? '▴' : '▾'}
                          </button>
                        )}
                      </span>
                      <span className="tgb-person-actions">
                        <select className="tgb-role" aria-label={t('membersRole')} value={record.role} disabled={props.busy}
                          onChange={(event) => {
                            const role = event.target.value as Role
                            props.onPerson({ ...record, role })
                            if (role !== 'admin') setOpen(rowKey)
                          }}>
                          <option value="admin">{t('roleAdmin')}</option>
                          <option value="member">{t('roleMember')}</option>
                          <option value="guest">{t('roleGuest')}</option>
                        </select>
                        <button type="button" className="tgb-button tgb-button-quiet" disabled={props.busy}
                          onClick={() => {
                            if (window.confirm(t('membersRemoveConfirm').replace('{name}', name).replace('{line}', lineName(line.id)))) props.onRemove(line.id, userId)
                          }}>{t('membersRemove')}</button>
                      </span>
                    </div>
                    {expanded && <PersonEditor t={t} record={record} defaultDir={props.defaultDir} busy={props.busy} onSave={props.onPerson} />}
                  </li>
                )
              })}
            </ul>
          )}
      </section>
    </div>
  )
}

/** One line about what a member or guest may do. */
function scopeLabel(t: T, record: PersonValue, defaultDir: string): string {
  const preset = record.role === 'guest' ? 'read-only' : record.preset ?? 'workspace-write'
  const presetName = t(PRESETS.find(([value]) => value === preset)?.[1] ?? 'presetWorkspaceWrite')
  const dirs = record.dirs ?? []
  const where = dirs.length === 0 ? (defaultDir === '' ? t('scopeNoDir') : tildeShort(defaultDir)) : dirs.length === 1 ? tildeShort(dirs[0]!) : t('scopeDirs').replace('{n}', String(dirs.length))
  return `${presetName} · ${where}`
}

function tildeShort(path: string): string {
  const parts = path.replace(/[\\/]+$/u, '').split(/[\\/]/u)
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : path
}

/** A member's or guest's preset and directories, saved together. */
function PersonEditor(props: { t: T; record: PersonValue; defaultDir: string; busy: boolean; onSave: (person: PersonValue) => void }): ReactNode {
  const { t, record } = props
  const [preset, setPreset] = useState(record.preset ?? 'workspace-write')
  const [dirs, setDirs] = useState((record.dirs ?? []).join('\n'))
  const parsed = dirs.split(/\n|,/u).map(dir => dir.trim()).filter(dir => dir !== '')
  const invalid = parsed.some(dir => !/^(\/|[a-z]:[\\/])/iu.test(dir))
  const changed = preset !== (record.preset ?? 'workspace-write') || parsed.join('\n') !== (record.dirs ?? []).join('\n')
  return (
    <div className="tgb-person-editor">
      {record.role === 'member' && (
        <label className="tgb-line-field">
          <span>{t('membersPreset')}</span>
          <select className="tgb-select" value={preset} disabled={props.busy} onChange={(event) => { setPreset(event.target.value) }}>
            {PRESETS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
            {!PRESETS.some(([value]) => value === preset) && <option value={preset}>{preset}</option>}
          </select>
          <span className="tgb-muted tgb-small">{t('membersPresetHint')}</span>
        </label>
      )}
      {record.role === 'guest' && <p className="tgb-muted tgb-small">{t('membersGuestHint')}</p>}
      <label className="tgb-line-field">
        <span>{t('membersDirs')}</span>
        <textarea className="tgb-textarea" rows={2} value={dirs} placeholder={props.defaultDir} disabled={props.busy}
          aria-invalid={invalid} onChange={(event) => { setDirs(event.target.value) }} />
        <span className={invalid ? 'tgb-line-error' : 'tgb-muted tgb-small'}>
          {invalid ? t('membersDirsInvalid') : t('membersDirsHint').replace('{dir}', props.defaultDir === '' ? t('scopeNoDir') : props.defaultDir)}
        </span>
      </label>
      <div className="tgb-link-row">
        <button type="button" className="tgb-button tgb-button-primary" disabled={props.busy || !changed || invalid}
          onClick={() => {
            props.onSave({
              line: record.line, id: record.id, role: record.role, dirs: parsed,
              ...(record.role === 'member' ? { preset } : {}),
            })
          }}>{t('save')}</button>
      </div>
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
