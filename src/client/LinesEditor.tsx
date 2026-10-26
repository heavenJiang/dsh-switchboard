/**
 * The settings page's line list: one card per bot account, with its
 * platform credentials and who may use it. The page stages edits here and
 * writes them, with any new secrets, in its single save.
 */

import { SettingsSecretField, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, type ReactNode } from 'react'
import { defaultSecretRef, LINE_ID, type ChannelType } from '../lines.ts'
import { FeishuScan, type ScanResult } from './FeishuScan.tsx'
import type { TelegramBridgeLocaleKey } from './locales.ts'

type T = (key: TelegramBridgeLocaleKey) => string

/** One line as the profile stores it. */
export interface LineValue {
  id: string
  type: ChannelType
  name: string
  enabled: boolean
  secretRef: string
  allowedUsers: string[]
  allowedChats: string[]
  groupMentionOnly: boolean
  workspacePath: string
  apiBaseUrl: string
  appId: string
  domain: 'feishu' | 'lark'
}

/** One line being edited: list fields as typed, plus a new secret (blank keeps the stored one). */
export interface LineRow {
  readonly value: LineValue
  readonly users: string
  readonly chats: string
  readonly secret: string
}

/** Connection state as the overview route reports it. */
export type LineState =
  | { kind: 'stopped' } | { kind: 'connecting' } | { kind: 'running'; username: string } | { kind: 'error'; message: string }

const splitList = (text: string): string[] => text.split(/[,\s]+/u).map(item => item.trim()).filter(item => item !== '')

/** A row for a stored line. */
export function rowOf(value: LineValue): LineRow {
  return { value, users: value.allowedUsers.join(', '), chats: value.allowedChats.join(', '), secret: '' }
}

/** The stored form of a row. */
export function lineOf(row: LineRow): LineValue {
  return { ...row.value, allowedUsers: splitList(row.users), allowedChats: splitList(row.chats) }
}

/** A new line of a type, with an id no other row uses. */
export function newRow(type: ChannelType, rows: readonly LineRow[]): LineRow {
  const taken = new Set(rows.map(row => row.value.id))
  let id: string = type
  for (let n = 2; taken.has(id); n++) id = `${type}-${n}`
  return rowOf({
    id, type, name: '', enabled: true, secretRef: defaultSecretRef(type, id),
    allowedUsers: [], allowedChats: [], groupMentionOnly: true, workspacePath: '',
    apiBaseUrl: 'https://api.telegram.org', appId: '', domain: 'feishu',
  })
}

/** Field problems of one row, by field. */
function problems(row: LineRow, rows: readonly LineRow[]): Partial<Record<'id' | 'secretRef' | 'workspacePath' | 'apiBaseUrl' | 'appId', true>> {
  const v = row.value
  return {
    ...(!LINE_ID.test(v.id) || rows.filter(other => other.value.id === v.id).length > 1 ? { id: true } : {}),
    ...(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(v.secretRef.trim()) ? {} : { secretRef: true }),
    ...(v.workspacePath.trim() === '' || /^(\/|[a-z]:[\\/])/iu.test(v.workspacePath.trim()) ? {} : { workspacePath: true }),
    ...(v.type !== 'telegram' || /^https?:\/\/\S+$/u.test(v.apiBaseUrl.trim()) ? {} : { apiBaseUrl: true }),
    ...(v.type !== 'feishu' || /^cli_\w+$/u.test(v.appId.trim()) ? {} : { appId: true }),
  }
}

/** A row after its Feishu app was created or extended by QR: the scanner may use it at once. */
export function registeredRow(row: LineRow, result: ScanResult): LineRow {
  const users = splitList(row.users)
  if (result.ownerOpenId !== undefined && !users.includes(result.ownerOpenId)) users.push(result.ownerOpenId)
  return { ...row, secret: '', users: users.join(', '), value: { ...row.value, appId: result.appId, domain: result.domain } }
}

/** Whether every row can be saved. */
export function rowsValid(rows: readonly LineRow[]): boolean {
  return rows.every(row => Object.keys(problems(row, rows)).length === 0)
}

export function LinesEditor(props: {
  t: T
  rows: readonly LineRow[]
  /** Whether each line's secret is stored, by line id. */
  configured: Readonly<Record<string, boolean>>
  states: Readonly<Record<string, LineState>>
  /** Messages waiting for each line to come back, by line id. */
  queued: Readonly<Record<string, number>>
  disabled: boolean
  onChange: (rows: LineRow[]) => void
  /** A Feishu app was created or extended by QR for a row; the page saves it. */
  onRegistered: (index: number, result: ScanResult) => void
}): ReactNode {
  const { t, rows, disabled } = props
  const [scanning, setScanning] = useState<{ index: number; repair: boolean } | undefined>(undefined)
  // Cards start folded; a line added here opens so it can be filled in.
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set())
  const toggle = (index: number, on?: boolean): void => {
    setOpen((current) => {
      const next = new Set(current)
      if (on ?? !next.has(index)) next.add(index)
      else next.delete(index)
      return next
    })
  }
  const update = (index: number, patch: { users?: string; chats?: string; secret?: string; value?: Partial<LineValue> }): void => {
    props.onChange(rows.map((row, i) => i !== index ? row : {
      ...row, ...patch, value: { ...row.value, ...patch.value },
    }))
  }
  const add = (type: ChannelType): void => {
    const index = rows.length
    props.onChange([...rows, newRow(type, rows)])
    toggle(index, true)
    // A Feishu line starts with the QR, the shortest way to a working app.
    if (type === 'feishu') setScanning({ index, repair: false })
  }
  return (
    <div className="tgb-lines-editor">
      {rows.map((row, index) => {
        const v = row.value
        const bad = problems(row, rows)
        const id = `plugin-config-line-${index}`
        const field = (key: 'appId' | 'apiBaseUrl' | 'workspacePath' | 'secretRef', label: string, hint: string, text: string,
          onEdit: (text: string) => void, placeholder?: string) => (
          <SettingsValueField id={`${id}-${key}`} label={label} hint={hint} text={text} placeholder={placeholder ?? ''}
            overridden={false} invalid={bad[key] === true} overriddenLabel="" resetLabel="" invalidLabel={t('invalid')}
            disabled={disabled} onEdit={onEdit} onReset={() => {}} />
        )
        const state = props.states[v.id]
        const queued = props.queued[v.id] ?? 0
        const people = splitList(row.users).length
        const expanded = open.has(index)
        const name = v.name.trim() || (v.type === 'feishu' ? t('lineTypeFeishu') : t('lineTypeTelegram'))
        return (
          <section key={index} className="tgb-line-card" data-type={v.type} data-open={expanded} data-off={!v.enabled}>
            <header className="tgb-line-head">
              <ChannelMark type={v.type} />
              <button type="button" className="tgb-line-title" aria-expanded={expanded} onClick={() => { toggle(index) }}>
                <span className="tgb-line-name-text">{name}</span>
                <span className="tgb-line-sub">
                  {state !== undefined && v.enabled ? <LineStateTag state={state} type={v.type} t={t} /> : <span className="tgb-state" data-kind="stopped">{t('lineOff')}</span>}
                  <span>{t('linePeople').replace('{n}', String(people))}</span>
                  {props.configured[v.id] !== true && (v.type === 'telegram' || v.appId.trim() === '') && <span className="tgb-tag" data-tone="warn">{t('lineUnset')}</span>}
                  {queued > 0 && <span className="tgb-tag" data-tone="warn">{t('lineQueued').replace('{n}', String(queued))}</span>}
                </span>
              </button>
              <Switch checked={v.enabled} label={t('lineEnabled')} disabled={disabled}
                onChange={(on) => { update(index, { value: { enabled: on } }) }} />
              <button type="button" className="tgb-icon-button" aria-label={expanded ? t('lineCollapse') : t('lineEdit')}
                title={expanded ? t('lineCollapse') : t('lineEdit')} onClick={() => { toggle(index) }}>
                <Chevron up={expanded} />
              </button>
            </header>
            {v.enabled && state?.kind === 'error' && <p className="tgb-line-error" role="alert">{state.message}</p>}
            {expanded && (
              <div className="tgb-line-body">
                <SettingsValueField id={`${id}-name`} label={t('lineName')} hint="" text={v.name} placeholder={t('lineNamePlaceholder')}
                  overridden={false} invalid={false} overriddenLabel="" resetLabel="" invalidLabel={t('invalid')}
                  disabled={disabled} onEdit={(text) => { update(index, { value: { name: text } }) }} onReset={() => {}} />
                {v.type === 'telegram'
                  ? (
                    <SettingsSecretField id={`${id}-secret`} label={t('botToken')} hint={t('telegramTokenHint')} disabled={disabled}
                      text={row.secret} configured={props.configured[v.id] === true}
                      stateLabel={props.configured[v.id] === true ? t('lineSecretSet') : t('lineSecretUnset')}
                      onEdit={(text) => { update(index, { secret: text }) }} />
                  )
                  : scanning?.index === index
                    ? (
                      <FeishuScan t={t} domain={v.domain} secretRef={v.secretRef.trim() || 'FEISHU_APP_SECRET'}
                        {...(scanning.repair ? { appId: v.appId } : {})}
                        onDone={(result) => { props.onRegistered(index, result) }}
                        onClose={() => { setScanning(undefined) }} />
                    )
                    : (
                      <div className="tgb-line-action">
                        {v.appId.trim() === ''
                          ? <button type="button" className="tgb-button tgb-button-primary" disabled={disabled || bad.secretRef === true}
                            onClick={() => { setScanning({ index, repair: false }) }}>{t('feishuScan')}</button>
                          : <button type="button" className="tgb-button" disabled={disabled || bad.appId === true}
                            onClick={() => { setScanning({ index, repair: true }) }}>{t('feishuRepair')}</button>}
                        <span className="tgb-muted tgb-small">{v.appId.trim() === '' ? t('feishuScanHint') : t('feishuRepairHint')}</span>
                      </div>
                    )}
                <SettingsValueField id={`${id}-users`} label={t('lineUsers')}
                  hint={v.type === 'feishu' ? t('lineUsersFeishuHint') : t('lineUsersTelegramHint')}
                  text={row.users} placeholder={v.type === 'feishu' ? 'ou_xxx' : '123456789, @alice'}
                  overridden={false} invalid={false} overriddenLabel="" resetLabel="" invalidLabel={t('invalid')}
                  disabled={disabled} onEdit={(text) => { update(index, { users: text }) }} onReset={() => {}} />
                <details className="tgb-more">
                  <summary>{t('lineMore')}</summary>
                  <div className="tgb-more-body">
                    <SettingsValueField id={`${id}-chats`} label={t('lineChats')} hint={t('lineChatsHint')}
                      text={row.chats} placeholder={v.type === 'feishu' ? 'oc_xxx' : '-1001234567890'}
                      overridden={false} invalid={false} overriddenLabel="" resetLabel="" invalidLabel={t('invalid')}
                      disabled={disabled} onEdit={(text) => { update(index, { chats: text }) }} onReset={() => {}} />
                    <label className="tgb-line-toggle">
                      <span>{t('lineMentionOnly')}</span>
                      <Switch checked={v.groupMentionOnly} label={t('lineMentionOnly')} disabled={disabled}
                        onChange={(on) => { update(index, { value: { groupMentionOnly: on } }) }} />
                    </label>
                    {field('workspacePath', t('lineWorkspace'), t('lineWorkspaceHint'), v.workspacePath, (text) => { update(index, { value: { workspacePath: text } }) })}
                    {v.type === 'telegram'
                      ? field('apiBaseUrl', t('apiBaseUrl'), t('apiBaseUrlHint'), v.apiBaseUrl, (text) => { update(index, { value: { apiBaseUrl: text.trim().replace(/\/+$/u, '') } }) })
                      : (
                        <>
                          <div className="tgb-line-field">
                            <label htmlFor={`${id}-domain`}>{t('feishuDomain')}</label>
                            <select id={`${id}-domain`} className="tgb-select" value={v.domain} disabled={disabled}
                              onChange={(event) => { update(index, { value: { domain: event.target.value === 'lark' ? 'lark' : 'feishu' } }) }}>
                              <option value="feishu">{t('domainFeishu')}</option>
                              <option value="lark">{t('domainLark')}</option>
                            </select>
                          </div>
                          <p className="tgb-line-setup">{t('feishuSetup')}</p>
                          {field('appId', t('feishuAppId'), t('feishuAppIdHint'), v.appId, (text) => { update(index, { value: { appId: text.trim() } }) }, 'cli_a1b2c3d4e5f6')}
                          <SettingsSecretField id={`${id}-secret`} label={t('feishuSecret')} hint={t('feishuSecretHint')} disabled={disabled}
                            text={row.secret} configured={props.configured[v.id] === true}
                            stateLabel={props.configured[v.id] === true ? t('lineSecretSet') : t('lineSecretUnset')}
                            onEdit={(text) => { update(index, { secret: text }) }} />
                        </>
                      )}
                    {field('secretRef', t('lineSecretRef'), t('lineSecretRefHint'), v.secretRef, (text) => { update(index, { value: { secretRef: text.trim() } }) })}
                    <p className="tgb-muted tgb-small">
                      {t('lineId')}: <code>{v.id}</code>{bad.id === true ? ` — ${t('lineInvalidId')}` : ''}
                    </p>
                    <button type="button" className="tgb-button tgb-button-danger" disabled={disabled}
                      onClick={() => { if (window.confirm(t('lineRemoveConfirm'))) props.onChange(rows.filter((_, i) => i !== index)) }}>
                      {t('lineRemove')}
                    </button>
                  </div>
                </details>
              </div>
            )}
          </section>
        )
      })}
      <div className="tgb-add-row">
        <button type="button" className="tgb-add" disabled={disabled} onClick={() => { add('telegram') }}>
          <ChannelMark type="telegram" /> {t('addTelegram')}
        </button>
        <button type="button" className="tgb-add" disabled={disabled} onClick={() => { add('feishu') }}>
          <ChannelMark type="feishu" /> {t('addFeishu')}
        </button>
      </div>
    </div>
  )
}

/** A line's connection, as a dot and a short label. */
export function LineStateTag({ state, type, t }: { state: LineState; type: ChannelType; t: T }): ReactNode {
  const label = state.kind === 'running' ? `${type === 'telegram' ? '@' : ''}${state.username}`
    : state.kind === 'connecting' ? t('stateConnecting')
      : state.kind === 'error' ? t('stateError') : t('stateStopped')
  return <span className="tgb-state" data-kind={state.kind} title={state.kind === 'error' ? state.message : undefined}>{label}</span>
}

/** The platform's colored mark. */
export function ChannelMark({ type }: { type: ChannelType }): ReactNode {
  return (
    <span className="tgb-mark" data-channel={type} aria-hidden="true">
      {type === 'telegram'
        ? <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21.5 4.3 2.9 11.4c-1.2.5-1.2 1.2-.2 1.5l4.7 1.5 1.8 5.6c.2.6.4.8.9.8.4 0 .6-.2.8-.4l2.3-2.2 4.7 3.5c.9.5 1.5.2 1.7-.8l3.1-14.7c.3-1.3-.5-1.9-1.4-1.5ZM8.9 14.1l9-5.7c.4-.3.8-.1.5.2l-7.5 6.8-.3 3.1-1.7-4.4Z" /></svg>
        : <span className="tgb-mark-letter">飞</span>}
    </span>
  )
}

function Chevron({ up }: { up: boolean }): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ transform: up ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }}>
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
