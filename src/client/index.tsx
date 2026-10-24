/**
 * Telegram bridge settings page, browser half. Registers the bundle's own
 * configuration into the Plugins page's `plugins.bundle.config` slot while
 * the Host serves the `telegram-bridge` entry, and edits that entry's
 * volatile Config through the shared configuration form, so a save is one
 * revision-fenced, Host-validated profile patch write that the running
 * bridge picks up without a restart.
 *
 * The bot token is a `role('secret')` field: the Host never returns it, so
 * the page only learns whether one is set, and a blank draft keeps it.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: ctx.locale.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: ctx.configForms and its form types.
import type { ConfigForm, SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: ctx.slots.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the Plugins page's SlotMap entries.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import {
  SettingsForm, SettingsSecretField, SettingsValueField, Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, useSyncExternalStore, type CSSProperties } from 'react'
import { en, zh, type TelegramBridgeLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Telegram bridge settings page copy. */
    telegramBridge: TelegramBridgeLocaleKey
  }
}

/** Dictionary namespace owned by this page. */
const NS = 'telegramBridge'
/** Bundle package name: the `plugins.bundle.config` key. */
const PACKAGE = 'dsh-telegram-bridge'
/** Profile entry id the bundle patch gives the bridge row: the settings namespace. */
const ENTRY = 'telegram-bridge'

/** The Config fields this page edits, as the Host resolves them (the token is redacted). */
interface BridgeValues {
  enabled?: boolean
  allowedUsers?: string[]
  workspacePath?: string
  agentPreset?: string
  permissionPreset?: string
  approvalViaTelegram?: boolean
  approvalTimeoutSec?: number
  notifyToolCalls?: boolean
  language?: 'zh' | 'en'
  apiBaseUrl?: string
  maxDownloadMb?: number
  sendDeliverables?: boolean
}

type TextField = 'allowedUsers' | 'workspacePath' | 'agentPreset' | 'permissionPreset' | 'approvalTimeoutSec' | 'maxDownloadMb' | 'apiBaseUrl'
type ToggleField = 'enabled' | 'approvalViaTelegram' | 'notifyToolCalls' | 'sendDeliverables' | 'englishReplies'

/** How a text field renders and parses; `undefined` from parse marks the draft invalid. */
const TEXT_FIELDS: Record<TextField, { format: (v: BridgeValues) => string; parse: (text: string) => string | string[] | number | undefined }> = {
  allowedUsers: {
    format: v => (v.allowedUsers ?? []).join(', '),
    parse: text => text.split(/[,\s]+/u).map(s => s.trim()).filter(s => s !== ''),
  },
  workspacePath: {
    format: v => v.workspacePath ?? '',
    // Absolute POSIX or Windows path, or blank.
    parse: text => text.trim() === '' || /^(\/|[a-z]:[\\/])/iu.test(text.trim()) ? text.trim() : undefined,
  },
  agentPreset: { format: v => v.agentPreset ?? '', parse: text => text.trim() },
  permissionPreset: { format: v => v.permissionPreset ?? '', parse: text => text.trim() },
  approvalTimeoutSec: {
    format: v => v.approvalTimeoutSec === undefined ? '' : String(v.approvalTimeoutSec),
    parse: (text) => {
      const n = Number(text.trim())
      return Number.isInteger(n) && n >= 10 && n <= 3600 ? n : undefined
    },
  },
  maxDownloadMb: {
    format: v => v.maxDownloadMb === undefined ? '' : String(v.maxDownloadMb),
    parse: (text) => {
      const n = Number(text.trim())
      return Number.isInteger(n) && n >= 1 && n <= 2000 ? n : undefined
    },
  },
  apiBaseUrl: {
    format: v => v.apiBaseUrl ?? '',
    parse: text => /^https?:\/\/\S+$/u.test(text.trim()) ? text.trim().replace(/\/+$/u, '') : undefined,
  },
}

/** A toggle's Config field and how its boolean maps to the stored value. */
const TOGGLES: Record<ToggleField, { field: keyof BridgeValues; read: (v: BridgeValues) => boolean; write: (on: boolean) => boolean | string }> = {
  enabled: { field: 'enabled', read: v => v.enabled ?? true, write: on => on },
  approvalViaTelegram: { field: 'approvalViaTelegram', read: v => v.approvalViaTelegram ?? true, write: on => on },
  notifyToolCalls: { field: 'notifyToolCalls', read: v => v.notifyToolCalls ?? true, write: on => on },
  sendDeliverables: { field: 'sendDeliverables', read: v => v.sendDeliverables ?? true, write: on => on },
  englishReplies: { field: 'language', read: v => v.language === 'en', write: on => on ? 'en' : 'zh' },
}

/** One path edit of the shared form's atomic write. */
type PathOp = Parameters<ConfigForm<BridgeValues>['mutate']>[0][number]

/** One staged edit. */
type Draft = { kind: 'text'; text: string } | { kind: 'toggle'; on: boolean } | { kind: 'reset' }

const styles = {
  toggle: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16,
    fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)',
  },
  hint: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
  feature: { display: 'grid', gap: 6 },
} satisfies Record<string, CSSProperties>

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the page while the Host serves the bridge entry.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const off = [ctx.locale.register(NS, 'en', en), ctx.locale.register(NS, 'zh', zh)]
    return () => { for (const dispose of off) dispose() }
  }, 'telegram-bridge: dictionaries')
  const form = ctx.configForms.get<BridgeValues>(ENTRY)
  const describe = ctx.configForms.describe()
  const Page = createPage(form, describe)
  ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: PACKAGE, locale: NS,
  }, Page))), 'telegram-bridge: page')
}

/** Whether the Host reports a stored bot token. */
function tokenConfigured(describe: SettingsDescribeFace): boolean {
  const view = describe.getSnapshot().view?.namespaces.find(entry => entry.ns === ENTRY)
  return view?.secrets.some(secret => secret.path.length === 1 && secret.path[0] === 'botToken' && secret.set) ?? false
}

/** Whether the user layer stores a field (what marks it overridden). */
function userHas(user: unknown, field: string): boolean {
  return user !== null && typeof user === 'object' && Object.hasOwn(user, field)
}

/**
 * Build the page component over one entry's shared form.
 * @param form - the bridge entry's configuration form.
 * @param describe - the settings mirror, read for the token's configured state.
 * @returns the slot component.
 */
function createPage(form: ConfigForm<BridgeValues>, describe: SettingsDescribeFace) {
  return function TelegramBridgePage(props: { t: (key: TelegramBridgeLocaleKey) => string; view: 'summary' | 'page' }) {
    const { t } = props
    const snapshot = useSyncExternalStore(form.subscribe.bind(form), form.getSnapshot.bind(form))
    const configured = useSyncExternalStore(describe.subscribe.bind(describe), () => tokenConfigured(describe))
    const [drafts, setDrafts] = useState<Partial<Record<TextField | ToggleField, Draft>>>({})
    const [token, setToken] = useState('')
    const [saving, setSaving] = useState(false)
    const [failed, setFailed] = useState(false)

    if (props.view === 'summary') return <>{t('summary')}</>

    const values = snapshot.value ?? {}
    const base = (snapshot.base ?? {}) as BridgeValues
    const stage = (field: TextField | ToggleField, draft: Draft): void => {
      setFailed(false)
      setDrafts(current => ({ ...current, [field]: draft }))
    }

    const textState = (field: TextField) => {
      const draft = drafts[field]
      const text = draft?.kind === 'text' ? draft.text : TEXT_FIELDS[field].format(draft?.kind === 'reset' ? base : values)
      return {
        text,
        overridden: draft === undefined ? userHas(snapshot.user, field) : draft.kind !== 'reset',
        invalid: draft?.kind === 'text' && TEXT_FIELDS[field].parse(draft.text) === undefined,
      }
    }
    const toggleOn = (field: ToggleField): boolean => {
      const draft = drafts[field]
      return draft?.kind === 'toggle' ? draft.on : TOGGLES[field].read(draft?.kind === 'reset' ? base : values)
    }

    const invalid = (Object.keys(TEXT_FIELDS) as TextField[]).some(field => textState(field).invalid)
    const dirty = Object.keys(drafts).length > 0 || token.trim() !== ''
    const disabled = !snapshot.writable || saving

    const save = (): void => {
      const list: PathOp[] = []
      for (const [key, draft] of Object.entries(drafts) as [TextField | ToggleField, Draft][]) {
        if (key in TOGGLES) {
          const { field, write } = TOGGLES[key as ToggleField]
          if (draft.kind === 'reset') list.push({ op: 'unset', path: [field] })
          else if (draft.kind === 'toggle') list.push({ op: 'set', path: [field], value: write(draft.on) })
        } else if (draft.kind === 'reset') {
          list.push({ op: 'unset', path: [key] })
        } else if (draft.kind === 'text') {
          list.push({ op: 'set', path: [key], value: TEXT_FIELDS[key as TextField].parse(draft.text) ?? '' })
        }
      }
      if (token.trim() !== '') list.push({ op: 'set', path: ['botToken'], value: token.trim() })
      if (list.length === 0) return
      setSaving(true)
      form.mutate(list, snapshot.revision).then((accepted) => {
        if (accepted) {
          setDrafts({})
          setToken('')
        }
        setFailed(!accepted)
      }, () => { setFailed(true) }).finally(() => { setSaving(false) })
    }

    const valueField = (field: TextField, id: string, extra: { numeric?: boolean; placeholder?: string } = {}) => (
      <SettingsValueField
        id={`plugin-config-telegram-${id}`}
        label={t(field)}
        hint={t(`${field}Hint` as TelegramBridgeLocaleKey)}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalid')}
        disabled={disabled}
        {...extra}
        {...textState(field)}
        onEdit={(text) => { stage(field, { kind: 'text', text }) }}
        onReset={() => { stage(field, { kind: 'reset' }) }}
      />
    )
    const toggle = (field: ToggleField) => (
      <div style={styles.feature}>
        <label style={styles.toggle}>
          <span>{t(field)}</span>
          <Switch checked={toggleOn(field)} label={t(field)} disabled={disabled}
            onChange={(on) => { stage(field, { kind: 'toggle', on }) }} />
        </label>
        <p style={styles.hint}>{t(`${field}Hint` as TelegramBridgeLocaleKey)}</p>
      </div>
    )

    return (
      <SettingsForm
        labels={{ unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }}
        state={{ available: snapshot.status !== 'unavailable', writable: snapshot.writable, dirty, invalid, saving, failed }}
        onSave={save}
        onDiscard={() => { setDrafts({}); setToken('') }}
      >
        {toggle('enabled')}
        <SettingsSecretField
          id="plugin-config-telegram-token"
          label={t('botToken')}
          hint={t('botTokenHint')}
          disabled={disabled}
          text={token}
          configured={configured}
          stateLabel={configured ? t('botTokenSet') : t('botTokenUnset')}
          onEdit={(text) => { setFailed(false); setToken(text) }}
        />
        {valueField('allowedUsers', 'allowed-users', { placeholder: '123456789, @alice' })}
        {valueField('workspacePath', 'workspace', { placeholder: '/Users/me/projects/app' })}
        {valueField('agentPreset', 'agent-preset')}
        {valueField('permissionPreset', 'permission-preset')}
        {toggle('approvalViaTelegram')}
        {valueField('approvalTimeoutSec', 'approval-timeout', { numeric: true })}
        {toggle('notifyToolCalls')}
        {valueField('maxDownloadMb', 'max-download', { numeric: true })}
        {toggle('sendDeliverables')}
        {toggle('englishReplies')}
        {valueField('apiBaseUrl', 'api-base-url')}
      </SettingsForm>
    )
  }
}
