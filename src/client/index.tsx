/**
 * Telegram bridge browser half: a "Telegram" sidebar panel showing chat
 * history (see TelegramPanel.tsx), and the settings page.
 *
 * Settings page: Registers the bundle's own
 * configuration into the Plugins page's `plugins.bundle.config` slot while
 * the Host serves the `telegram-bridge` entry, and edits that entry's
 * volatile Config through the shared configuration form, so a save is one
 * revision-fenced, Host-validated profile patch write that the running
 * bridge picks up without a restart.
 *
 * The bot token goes to the Host credentials store under `botTokenRef`
 * (default `TELEGRAM_BOT_TOKEN`), never into the profile file; a legacy
 * literal `botToken` is cleared once the store accepts the token. The page
 * only learns whether a token is set, and a blank draft keeps it.
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
// Type-only: the sidebar entry and main panel slots.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the conversation.view slot the Session tab registers into.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  SettingsForm, SettingsSecretField, SettingsValueField, Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { en, zh, type TelegramBridgeLocaleKey } from './locales.ts'
import panelCss from './panel.css'
import { PlaneIcon, createTelegramPanel } from './TelegramPanel.tsx'
import { remotes, trackRemotes } from './remotes.ts'
import { SessionTab } from './SessionTab.tsx'
import { useUpdateCheck } from './update.ts'
import { VersionSection } from './VersionSection.tsx'

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
/** Main panel id the sidebar entry selects. */
const PANEL_ID = 'telegram-bridge' as MainPanelId

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
  historyLimit?: number
  modelProvider?: string
  model?: string
  reasoningEffort?: string
  botTokenRef?: string
  allowedChats?: string[]
  groupMentionOnly?: boolean
  channelPrompt?: boolean
  channelPromptText?: string
  streamReplies?: boolean
  turnSummary?: 'off' | 'long' | 'always'
  turnSummaryMinSec?: number
  scheduleChats?: string[]
  transcribeVoice?: boolean
  ffmpegPath?: string
  showPanel?: boolean
  showSessionTab?: boolean
  questionsViaTelegram?: boolean
}

/** The Host model catalog as the models route returns it. */
interface Catalog {
  default: { provider: string; model: string; reasoningEffort?: string }
  groups: { id: string; name: string; models: { id: string; name: string; reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string } }[] }[]
}

/** A staged model choice; `undefined` provider follows the Web default. */
interface ModelDraft { provider?: string; model?: string; effort?: string }

type TextField = 'allowedUsers' | 'allowedChats' | 'workspacePath' | 'agentPreset' | 'permissionPreset' | 'approvalTimeoutSec'
  | 'maxDownloadMb' | 'historyLimit' | 'apiBaseUrl' | 'botTokenRef' | 'channelPromptText' | 'turnSummary' | 'turnSummaryMinSec'
  | 'scheduleChats' | 'ffmpegPath'
type ToggleField = 'enabled' | 'approvalViaTelegram' | 'notifyToolCalls' | 'sendDeliverables' | 'englishReplies'
  | 'groupMentionOnly' | 'channelPrompt' | 'streamReplies' | 'transcribeVoice' | 'showPanel' | 'showSessionTab' | 'questionsViaTelegram'

/** A comma- or space-separated list field. */
const listField = (read: (v: BridgeValues) => string[] | undefined) => ({
  format: (v: BridgeValues) => (read(v) ?? []).join(', '),
  parse: (text: string) => text.split(/[,\s]+/u).map(s => s.trim()).filter(s => s !== ''),
})

/** An integer field within bounds. */
const intField = (read: (v: BridgeValues) => number | undefined, min: number, max: number) => ({
  format: (v: BridgeValues) => { const n = read(v); return n === undefined ? '' : String(n) },
  parse: (text: string) => { const n = Number(text.trim()); return Number.isInteger(n) && n >= min && n <= max ? n : undefined },
})

/** How a text field renders and parses; `undefined` from parse marks the draft invalid. */
const TEXT_FIELDS: Record<TextField, { format: (v: BridgeValues) => string; parse: (text: string) => string | string[] | number | undefined }> = {
  allowedUsers: listField(v => v.allowedUsers),
  allowedChats: listField(v => v.allowedChats),
  scheduleChats: listField(v => v.scheduleChats),
  turnSummaryMinSec: intField(v => v.turnSummaryMinSec, 0, 86400),
  turnSummary: { format: v => v.turnSummary ?? 'long', parse: text => ['off', 'long', 'always'].includes(text) ? text : undefined },
  botTokenRef: {
    format: v => v.botTokenRef ?? '',
    parse: text => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(text.trim()) ? text.trim() : undefined,
  },
  channelPromptText: { format: v => v.channelPromptText ?? '', parse: text => text.trim() },
  ffmpegPath: { format: v => v.ffmpegPath ?? '', parse: text => text.trim() === '' ? undefined : text.trim() },
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
  historyLimit: {
    format: v => v.historyLimit === undefined ? '' : String(v.historyLimit),
    parse: (text) => {
      const n = Number(text.trim())
      return Number.isInteger(n) && n >= 100 && n <= 100000 ? n : undefined
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
  groupMentionOnly: { field: 'groupMentionOnly', read: v => v.groupMentionOnly ?? true, write: on => on },
  channelPrompt: { field: 'channelPrompt', read: v => v.channelPrompt ?? true, write: on => on },
  streamReplies: { field: 'streamReplies', read: v => v.streamReplies ?? true, write: on => on },
  transcribeVoice: { field: 'transcribeVoice', read: v => v.transcribeVoice ?? true, write: on => on },
  showPanel: { field: 'showPanel', read: v => v.showPanel ?? true, write: on => on },
  showSessionTab: { field: 'showSessionTab', read: v => v.showSessionTab ?? true, write: on => on },
  questionsViaTelegram: { field: 'questionsViaTelegram', read: v => v.questionsViaTelegram ?? true, write: on => on },
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
  feature: { display: 'grid', gap: 6, padding: '4px 0' },
  section: {
    margin: '18px 0 2px', paddingTop: 14, borderTop: '1px solid var(--dsw-alias-border-l2)',
    fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
  },
  firstSection: { margin: '0 0 2px', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
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
  const Page = createPage(form, describe, ctx)
  ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: PACKAGE, locale: NS,
  }, Page))), 'telegram-bridge: page')

  trackRemotes(ctx)

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['pluginCss'] = 'dsh-telegram-bridge/panel.css'
    style.textContent = panelCss
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'telegram-bridge: panel styles')
  // Navigation services belong to other plugins; read them when used so the
  // panel still renders in a composition without them.
  const Panel = createTelegramPanel({
    openSession(sessionId) {
      const workspace = ctx.get('uiWorkspace') as { openSession(id: string): void } | undefined
      if (workspace === undefined) return false
      workspace.openSession(sessionId)
      return true
    },
    openSettings() {
      const navigation = ctx.get('pluginNavigation') as { openBundle(name: string): void } | undefined
      navigation?.openBundle(PACKAGE)
    },
    useUpdate: () => useUpdateCheck(ctx, PACKAGE),
  })
  // The panel and the Session tab appear only while the Host serves the
  // bridge, and each follows its own switch on the settings page.
  ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => whileOn(form, 'showPanel', () => {
    const offMain = ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Panel))
    const offEntry = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: PANEL_ID, order: 15, label: () => ctx.locale.bind(NS)('panel'), locale: NS,
    }, ({ size }: { size?: number }) => <PlaneIcon size={size ?? 16} />))
    return () => {
      offEntry()
      offMain()
    }
  })), 'telegram-bridge: history panel')
  ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => whileOn(form, 'showSessionTab', () => ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: 'telegram-bridge', order: 40, locale: NS, label: () => ctx.locale.bind(NS)('tabTitle'),
  }, (props: { sessionId: string; t: (key: TelegramBridgeLocaleKey) => string }) => <SessionTab sessionId={props.sessionId} t={props.t} />)))),
  'telegram-bridge: session tab')
}

/**
 * Keep a registration alive while a boolean Config field is on (default on).
 * @returns disposer ending the watch and any live registration.
 */
function whileOn(form: ConfigForm<BridgeValues>, field: 'showPanel' | 'showSessionTab', register: () => () => void): () => void {
  let off: (() => void) | undefined
  const sync = (): void => {
    const on = form.getSnapshot().value?.[field] ?? true
    if (on && off === undefined) off = register()
    else if (!on && off !== undefined) {
      off()
      off = undefined
    }
  }
  const unsubscribe = form.subscribe(sync)
  sync()
  return () => {
    unsubscribe()
    off?.()
    off = undefined
  }
}

/** Whether the Host reports a stored bot token. */
function tokenConfigured(describe: SettingsDescribeFace): boolean {
  const view = describe.getSnapshot().view?.namespaces.find(entry => entry.ns === ENTRY)
  return view?.secrets.some(secret => secret.path.length === 1 && secret.path[0] === 'botToken' && secret.set) ?? false
}

/** A small labelled select for enumerated fields. */
function ChoiceField(props: {
  label: string
  hint: string
  value: string
  options: [string, string][]
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <div style={styles.feature}>
      <label style={{ ...styles.toggle, fontWeight: 500 }}>{props.label}</label>
      <select className="tgb-select" value={props.value} disabled={props.disabled} aria-label={props.label}
        onChange={(event) => { props.onChange(event.target.value) }}>
        {props.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <p style={styles.hint}>{props.hint}</p>
    </div>
  )
}

/** The bot's default model: follow the Web default, or pin one catalog model and optional effort. */
function ModelPicker(props: {
  t: (key: TelegramBridgeLocaleKey) => string
  catalog: Catalog | undefined
  value: ModelDraft
  disabled: boolean
  onChange: (next: ModelDraft) => void
}) {
  const { t, catalog, value } = props
  const key = (provider: string, model: string): string => `${provider}\u0000${model}`
  const selected = value.provider !== undefined && value.model !== undefined ? key(value.provider, value.model) : ''
  const entry = catalog?.groups.find(g => g.id === value.provider)?.models.find(m => m.id === value.model)
  const listed = selected === '' || entry !== undefined
  const efforts = entry?.reasoning?.efforts ?? []
  const fallback = catalog === undefined ? '' : `${catalog.default.provider}/${catalog.default.model}`
  return (
    <div style={styles.feature}>
      <label style={{ ...styles.toggle, fontWeight: 500 }} htmlFor="plugin-config-telegram-model">{t('botModel')}</label>
      <select id="plugin-config-telegram-model" className="tgb-select" disabled={props.disabled || catalog === undefined} value={selected}
        onChange={(event) => {
          const [provider, model] = event.target.value.split('\u0000')
          props.onChange(provider === undefined || model === undefined || event.target.value === '' ? {} : { provider, model })
        }}>
        <option value="">{catalog === undefined ? t('loading') : `${t('followWebDefault')}${fallback === '' ? '' : ` (${fallback})`}`}</option>
        {!listed && <option value={selected}>{`${t('modelUnavailable')} ${value.provider}/${value.model}`}</option>}
        {catalog?.groups.map(group => (
          <optgroup key={group.id} label={group.name}>
            {group.models.map(model => <option key={model.id} value={key(group.id, model.id)}>{model.name}</option>)}
          </optgroup>
        ))}
      </select>
      {efforts.length > 0 && (
        <select className="tgb-select" aria-label={t('reasoningEffort')} disabled={props.disabled} value={value.effort ?? ''}
          onChange={(event) => {
            const { effort: _drop, ...rest } = value
            props.onChange(event.target.value === '' ? rest : { ...rest, effort: event.target.value })
          }}>
          <option value="">{t('effortDefault')}{entry?.reasoning?.defaultEffort === undefined ? '' : ` (${entry.reasoning.defaultEffort})`}</option>
          {efforts.map(effort => <option key={effort.id} value={effort.id}>{t('reasoningEffort')}: {effort.name}</option>)}
        </select>
      )}
      <p style={styles.hint}>{t('botModelHint')}</p>
    </div>
  )
}

function userHas(user: unknown, field: string): boolean {
  return user !== null && typeof user === 'object' && Object.hasOwn(user, field)
}

/**
 * Build the page component over one entry's shared form.
 * @param form - the bridge entry's configuration form.
 * @param describe - the settings mirror, read for the token's configured state.
 * @returns the slot component.
 */
function createPage(form: ConfigForm<BridgeValues>, describe: SettingsDescribeFace, ctx: ClientContext) {
  return function TelegramBridgePage(props: { t: (key: TelegramBridgeLocaleKey) => string; view: 'summary' | 'page' }) {
    const { t } = props
    const snapshot = useSyncExternalStore(form.subscribe.bind(form), form.getSnapshot.bind(form))
    const literalToken = useSyncExternalStore(describe.subscribe.bind(describe), () => tokenConfigured(describe))
    const tokenRef = (snapshot.value?.botTokenRef ?? 'TELEGRAM_BOT_TOKEN').trim() || 'TELEGRAM_BOT_TOKEN'
    const [credential, setCredential] = useState<{ ref: string; configured: boolean } | undefined>(undefined)
    const [credentialTick, setCredentialTick] = useState(0)
    useEffect(() => {
      if (props.view !== 'page') return
      let live = true
      void remotes.credentials?.describe([tokenRef]).then((answer) => {
        if (live && answer.ok) setCredential({ ref: tokenRef, configured: answer.value[tokenRef]?.configured ?? false })
      }, () => {})
      return () => { live = false }
    }, [props.view, tokenRef, credentialTick])
    const configured = literalToken || (credential?.ref === tokenRef && credential.configured)
    const [drafts, setDrafts] = useState<Partial<Record<TextField | ToggleField, Draft>>>({})
    const [token, setToken] = useState('')
    const [saving, setSaving] = useState(false)
    const [failed, setFailed] = useState(false)
    const [modelDraft, setModelDraft] = useState<ModelDraft | undefined>(undefined)
    const [catalog, setCatalog] = useState<Catalog | undefined>(undefined)
    useEffect(() => {
      if (props.view !== 'page') return
      let live = true
      void fetch('api/telegram-bridge/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then(async response => response.ok ? await response.json() as Catalog : undefined)
        .then((value) => { if (live && value?.groups !== undefined) setCatalog(value) }, () => {})
      return () => { live = false }
    }, [props.view])

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
    const dirty = Object.keys(drafts).length > 0 || token.trim() !== '' || modelDraft !== undefined
    const stored: ModelDraft = values.modelProvider && values.model
      ? { provider: values.modelProvider, model: values.model, ...(values.reasoningEffort ? { effort: values.reasoningEffort } : {}) }
      : {}
    const shownModel = modelDraft ?? stored
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
      // Prefer the credentials store; only a client without it falls back to the literal field.
      const storeToken = token.trim() !== '' && remotes.credentials !== undefined
      if (token.trim() !== '' && !storeToken) list.push({ op: 'set', path: ['botToken'], value: token.trim() })
      if (storeToken && literalToken) list.push({ op: 'unset', path: ['botToken'] })
      if (modelDraft !== undefined) {
        if (modelDraft.provider === undefined || modelDraft.model === undefined) {
          for (const field of ['modelProvider', 'model', 'reasoningEffort']) list.push({ op: 'unset', path: [field] })
        } else {
          list.push({ op: 'set', path: ['modelProvider'], value: modelDraft.provider })
          list.push({ op: 'set', path: ['model'], value: modelDraft.model })
          list.push(modelDraft.effort === undefined
            ? { op: 'unset', path: ['reasoningEffort'] }
            : { op: 'set', path: ['reasoningEffort'], value: modelDraft.effort })
        }
      }
      if (list.length === 0 && !storeToken) return
      setSaving(true)
      const credentialWrite = storeToken
        ? remotes.credentials!.set(tokenRef, token.trim()).then(answer => answer.ok)
        : Promise.resolve(true)
      // The literal field is cleared only after the store accepted the token.
      credentialWrite.then(stored => stored
        ? (list.length === 0 ? Promise.resolve(true) : form.mutate(list, snapshot.revision))
        : false).then((accepted) => {
        setCredentialTick(n => n + 1)
        if (accepted) {
          setDrafts({})
          setToken('')
          setModelDraft(undefined)
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
      <>
      <VersionSection ctx={ctx} name={PACKAGE} t={t} />
      <SettingsForm
        labels={{ unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }}
        state={{ available: snapshot.status !== 'unavailable', writable: snapshot.writable, dirty, invalid, saving, failed }}
        onSave={save}
        onDiscard={() => { setDrafts({}); setToken(''); setModelDraft(undefined) }}
      >
        <h3 style={styles.firstSection}>{t('groupConnection')}</h3>
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
        {valueField('botTokenRef', 'token-ref', { placeholder: 'TELEGRAM_BOT_TOKEN' })}
        {valueField('apiBaseUrl', 'api-base-url')}
        {toggle('englishReplies')}

        <h3 style={styles.section}>{t('groupAccess')}</h3>
        {valueField('allowedUsers', 'allowed-users', { placeholder: '123456789, @alice' })}
        {valueField('allowedChats', 'allowed-chats', { placeholder: '-1001234567890' })}
        {toggle('groupMentionOnly')}

        <h3 style={styles.section}>{t('groupSession')}</h3>
        {valueField('workspacePath', 'workspace', { placeholder: '/Users/me/projects/app' })}
        <ModelPicker t={t} catalog={catalog} value={shownModel} disabled={disabled}
          onChange={(next) => { setFailed(false); setModelDraft(next) }} />
        {valueField('agentPreset', 'agent-preset')}
        {valueField('permissionPreset', 'permission-preset')}
        {toggle('channelPrompt')}
        {valueField('channelPromptText', 'channel-prompt')}

        <h3 style={styles.section}>{t('groupMessages')}</h3>
        {toggle('streamReplies')}
        {toggle('notifyToolCalls')}
        <ChoiceField label={t('turnSummary')} hint={t('turnSummaryHint')} disabled={disabled}
          value={textState('turnSummary').text}
          options={[['off', t('turnSummaryOff')], ['long', t('turnSummaryLong')], ['always', t('turnSummaryAlways')]]}
          onChange={(value) => { stage('turnSummary', { kind: 'text', text: value }) }} />
        {valueField('turnSummaryMinSec', 'summary-min', { numeric: true })}
        {valueField('scheduleChats', 'schedule-chats', { placeholder: '123456789' })}

        <h3 style={styles.section}>{t('groupApproval')}</h3>
        {toggle('approvalViaTelegram')}
        {toggle('questionsViaTelegram')}
        {valueField('approvalTimeoutSec', 'approval-timeout', { numeric: true })}

        <h3 style={styles.section}>{t('groupMedia')}</h3>
        {toggle('sendDeliverables')}
        {valueField('maxDownloadMb', 'max-download', { numeric: true })}
        {toggle('transcribeVoice')}
        {valueField('ffmpegPath', 'ffmpeg', { placeholder: 'ffmpeg' })}

        <h3 style={styles.section}>{t('groupInterface')}</h3>
        {toggle('showPanel')}
        {toggle('showSessionTab')}
        {valueField('historyLimit', 'history-limit', { numeric: true })}
      </SettingsForm>
      </>
    )
  }
}
