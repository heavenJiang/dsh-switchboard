/**
 * The settings page's line list: one card per bot account, with its
 * platform credentials and who may use it. The page stages edits here and
 * writes them, with any new secrets, in its single save.
 */

import { SettingsSecretField, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import { defaultSecretRef, LINE_ID, type ChannelType } from '../lines.ts'
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
  disabled: boolean
  onChange: (rows: LineRow[]) => void
}): ReactNode {
  const { t, rows, disabled } = props
  const update = (index: number, patch: { users?: string; chats?: string; secret?: string; value?: Partial<LineValue> }): void => {
    props.onChange(rows.map((row, i) => i !== index ? row : {
      ...row, ...patch, value: { ...row.value, ...patch.value },
    }))
  }
  return (
    <div className="tgb-lines-editor">
      <p className="tgb-muted tgb-small">{t('linesHint')}</p>
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
        return (
          <section key={index} className="tgb-line-card" data-type={v.type}>
            <header className="tgb-line-head">
              <span className="tgb-tag" data-channel={v.type}>{v.type === 'feishu' ? t('lineTypeFeishu') : t('lineTypeTelegram')}</span>
              <input className="tgb-input tgb-line-name" value={v.name} placeholder={t('lineNamePlaceholder')} aria-label={t('lineName')}
                disabled={disabled} onChange={(event) => { update(index, { value: { name: event.target.value } }) }} />
              {state !== undefined && <LineStateTag state={state} type={v.type} t={t} />}
              <label className="tgb-line-switch">
                <span>{t('lineEnabled')}</span>
                <Switch checked={v.enabled} label={t('lineEnabled')} disabled={disabled}
                  onChange={(on) => { update(index, { value: { enabled: on } }) }} />
              </label>
              <button type="button" className="tgb-button" disabled={disabled}
                onClick={() => { if (window.confirm(t('lineRemoveConfirm'))) props.onChange(rows.filter((_, i) => i !== index)) }}>
                {t('lineRemove')}
              </button>
            </header>
            {state?.kind === 'error' && <p className="tgb-line-error" role="alert">{state.message}</p>}
            <p className="tgb-muted tgb-small">
              {t('lineId')}: <code>{v.id}</code>{bad.id === true ? ` — ${t('lineInvalidId')}` : ''}
            </p>
            {v.type === 'telegram'
              ? (
                <>
                  <SettingsSecretField id={`${id}-secret`} label={t('botToken')} hint={t('telegramTokenHint')} disabled={disabled}
                    text={row.secret} configured={props.configured[v.id] === true}
                    stateLabel={props.configured[v.id] === true ? t('lineSecretSet') : t('lineSecretUnset')}
                    onEdit={(text) => { update(index, { secret: text }) }} />
                  {field('apiBaseUrl', t('apiBaseUrl'), t('apiBaseUrlHint'), v.apiBaseUrl, (text) => { update(index, { value: { apiBaseUrl: text.trim().replace(/\/+$/u, '') } }) })}
                </>
              )
              : (
                <>
                  <p className="tgb-line-setup">{t('feishuSetup')}</p>
                  {field('appId', t('feishuAppId'), t('feishuAppIdHint'), v.appId, (text) => { update(index, { value: { appId: text.trim() } }) }, 'cli_a1b2c3d4e5f6')}
                  <SettingsSecretField id={`${id}-secret`} label={t('feishuSecret')} hint={t('feishuSecretHint')} disabled={disabled}
                    text={row.secret} configured={props.configured[v.id] === true}
                    stateLabel={props.configured[v.id] === true ? t('lineSecretSet') : t('lineSecretUnset')}
                    onEdit={(text) => { update(index, { secret: text }) }} />
                  <div className="tgb-line-field">
                    <label htmlFor={`${id}-domain`}>{t('feishuDomain')}</label>
                    <select id={`${id}-domain`} className="tgb-select" value={v.domain} disabled={disabled}
                      onChange={(event) => { update(index, { value: { domain: event.target.value === 'lark' ? 'lark' : 'feishu' } }) }}>
                      <option value="feishu">{t('domainFeishu')}</option>
                      <option value="lark">{t('domainLark')}</option>
                    </select>
                  </div>
                </>
              )}
            <SettingsValueField id={`${id}-users`} label={t('lineUsers')}
              hint={v.type === 'feishu' ? t('lineUsersFeishuHint') : t('lineUsersTelegramHint')}
              text={row.users} placeholder={v.type === 'feishu' ? 'ou_xxx' : '123456789, @alice'}
              overridden={false} invalid={false} overriddenLabel="" resetLabel="" invalidLabel={t('invalid')}
              disabled={disabled} onEdit={(text) => { update(index, { users: text }) }} onReset={() => {}} />
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
            {field('secretRef', t('lineSecretRef'), t('lineSecretRefHint'), v.secretRef, (text) => { update(index, { value: { secretRef: text.trim() } }) })}
          </section>
        )
      })}
      <div className="tgb-link-row">
        <button type="button" className="tgb-button" disabled={disabled} onClick={() => { props.onChange([...rows, newRow('telegram', rows)]) }}>{t('addTelegram')}</button>
        <button type="button" className="tgb-button" disabled={disabled} onClick={() => { props.onChange([...rows, newRow('feishu', rows)]) }}>{t('addFeishu')}</button>
      </div>
    </div>
  )
}

function LineStateTag({ state, type, t }: { state: LineState; type: ChannelType; t: T }): ReactNode {
  const label = state.kind === 'running' ? `${type === 'telegram' ? '@' : ''}${state.username}`
    : state.kind === 'connecting' ? t('stateConnecting')
      : state.kind === 'error' ? t('stateError') : t('stateStopped')
  return <span className="tgb-state" data-kind={state.kind} title={state.kind === 'error' ? state.message : undefined}>{label}</span>
}
