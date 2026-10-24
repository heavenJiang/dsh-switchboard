/**
 * The settings page's version section: installed version and source, a
 * check for a newer release, and an in-place update through the plugin manager.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { useEffect, useState, type ReactNode } from 'react'
import type { TelegramBridgeLocaleKey } from './locales.ts'
import { applyUpdate, checkForUpdate, useUpdateCheck, type UpdateCheck } from './update.ts'

type T = (key: TelegramBridgeLocaleKey) => string

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'updating' }
  | { kind: 'approval'; builds: string[] }
  | { kind: 'done'; version: string }
  | { kind: 'restart'; version: string }
  | { kind: 'failed'; message: string }

/**
 * Render the version section.
 * @param props.ctx - browser plugin context (plugin manager remote).
 * @param props.name - this bundle's package name.
 */
export function VersionSection({ ctx, name, t }: { ctx: ClientContext; name: string; t: T }): ReactNode {
  const shared = useUpdateCheck(ctx, name)
  const [check, setCheck] = useState<UpdateCheck | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  useEffect(() => { if (shared !== undefined) setCheck(shared) }, [shared])

  // A successful in-place update replaced this page's code; reload to run it.
  useEffect(() => {
    if (phase.kind !== 'done') return
    const timer = setTimeout(() => { location.reload() }, 1800)
    return () => { clearTimeout(timer) }
  }, [phase.kind])

  const recheck = (): void => {
    setPhase({ kind: 'checking' })
    checkForUpdate(ctx, name, true).then((value) => {
      setCheck(value)
      setPhase({ kind: 'idle' })
    }, (error: unknown) => { setPhase({ kind: 'failed', message: String(error) }) })
  }

  const update = (approved?: string[]): void => {
    if (check === undefined) return
    setPhase({ kind: 'updating' })
    applyUpdate(ctx, check, approved).then((outcome) => {
      if (outcome.kind === 'applied') setPhase({ kind: 'done', version: outcome.version })
      else if (outcome.kind === 'restart') setPhase({ kind: 'restart', version: outcome.version })
      else if (outcome.kind === 'approval') setPhase({ kind: 'approval', builds: outcome.builds })
      else setPhase({ kind: 'failed', message: outcome.message })
    }, (error: unknown) => { setPhase({ kind: 'failed', message: String(error) }) })
  }

  const source = check?.source
  const sourceLabel = source === undefined ? ''
    : source.kind === 'github' ? `GitHub · ${source.owner}/${source.repo}`
      : source.kind === 'npm' ? `npm · ${source.name}` : source.kind === 'local' ? t('sourceLocal') : t('sourceUnknown')
  const repoUrl = source?.kind === 'github' ? `https://github.com/${source.owner}/${source.repo}` : undefined
  const busy = phase.kind === 'checking' || phase.kind === 'updating'
  const latest = check?.latest

  let status: ReactNode
  if (phase.kind === 'checking' || check === undefined) status = <span>{t('checking')}</span>
  else if (phase.kind === 'updating') status = <span>{t('updating')}</span>
  else if (phase.kind === 'done') status = <span className="tgb-version-ok">{t('updated')} v{phase.version} · {t('reloading')}</span>
  else if (phase.kind === 'restart') status = <span className="tgb-version-warn">{t('updatedRestart').replace('{version}', phase.version)}</span>
  else if (phase.kind === 'failed') status = <span className="tgb-version-error">{t('updateFailed')}: {phase.message}</span>
  else if (check.error !== undefined) status = <span className="tgb-version-error">{t('checkFailed')}: {check.error}</span>
  else if (source?.kind === 'local') status = <span>{t('localNoUpdate')}</span>
  else if (source?.kind === 'unknown') status = <span>{t('unknownNoUpdate')}</span>
  else if (check.newer && latest !== undefined) {
    status = (
      <span className="tgb-version-new">
        {t('newVersion')} v{latest.version}
        {latest.summary === undefined ? '' : ` · ${latest.summary}`}
        {latest.date === undefined ? '' : ` · ${new Date(latest.date).toLocaleDateString()}`}
      </span>
    )
  } else status = <span className="tgb-version-ok">{t('upToDate')} · {t('checkedAt')} {new Date(check.checkedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>

  return (
    <section className="tgb-version" aria-label={t('versionTitle')}>
      <div className="tgb-version-head">
        <div className="tgb-version-main">
          <strong>{t('versionTitle')}</strong>
          <span className="tgb-version-current">v{check?.installed ?? '…'}{sourceLabel === '' ? '' : ` · ${sourceLabel}`}</span>
        </div>
        <div className="tgb-version-actions">
          {check?.newer === true && latest !== undefined && phase.kind !== 'done' && phase.kind !== 'approval' && (
            <button type="button" className="tgb-button tgb-button-primary" disabled={busy} onClick={() => { update() }}>
              {t('updateTo')} v{latest.version}
            </button>
          )}
          {latest !== undefined && check?.newer === true && (
            <a className="tgb-button" href={latest.url} target="_blank" rel="noreferrer">{t('releaseNotes')}</a>
          )}
          {repoUrl !== undefined && check?.newer !== true && <a className="tgb-button" href={repoUrl} target="_blank" rel="noreferrer">GitHub</a>}
          <button type="button" className="tgb-button" disabled={busy} onClick={recheck}>{t('checkUpdate')}</button>
        </div>
      </div>
      <div className="tgb-version-status" role="status">{status}</div>
      {phase.kind === 'approval' && (
        <div className="tgb-version-approval">
          <p>{t('approveBuildsHint')}</p>
          <code>{phase.builds.join('\n')}</code>
          <div className="tgb-version-actions">
            <button type="button" className="tgb-button tgb-button-primary" onClick={() => { update(phase.builds) }}>{t('approveAndUpdate')}</button>
            <button type="button" className="tgb-button" onClick={() => { setPhase({ kind: 'idle' }) }}>{t('cancel')}</button>
          </div>
        </div>
      )}
    </section>
  )
}
