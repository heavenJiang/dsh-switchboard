/**
 * The settings page's version section, for installs the Plugins page cannot
 * update. An updatable install gets the page's own Versions section and update
 * dialog instead, so this one stays out of the way.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { useEffect, useState, type ReactNode } from 'react'
import type { TelegramBridgeLocaleKey } from './locales.ts'
import { checkForUpdate, useUpdateCheck, type UpdateCheck } from './update.ts'

type T = (key: TelegramBridgeLocaleKey) => string

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
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

  // Nothing shows until the check answers, so an updatable install never flashes this section.
  if (check === undefined || check.hostUpdates) return null

  const recheck = (): void => {
    setPhase({ kind: 'checking' })
    checkForUpdate(ctx, name, true).then((value) => {
      setCheck(value)
      setPhase({ kind: 'idle' })
    }, (error: unknown) => { setPhase({ kind: 'failed', message: String(error) }) })
  }

  const { source, latest } = check
  const sourceLabel = source.kind === 'github' ? `GitHub · ${source.owner}/${source.repo}`
    : source.kind === 'npm' ? `npm · ${source.name}` : source.kind === 'local' ? t('sourceLocal') : t('sourceUnknown')
  const repoUrl = source.kind === 'github' ? `https://github.com/${source.owner}/${source.repo}` : undefined
  const newer = check.newer && latest !== undefined ? latest : undefined

  let status: ReactNode
  if (phase.kind === 'checking') status = <span>{t('checking')}</span>
  else if (phase.kind === 'failed') status = <span className="tgb-version-error">{t('checkFailed')}: {phase.message}</span>
  else if (check.error !== undefined) status = <span className="tgb-version-error">{t('checkFailed')}: {check.error}</span>
  else if (source.kind === 'local') status = <span>{t('localNoUpdate')}</span>
  else if (source.kind === 'unknown') status = <span>{t('unknownNoUpdate')}</span>
  else if (newer !== undefined) {
    status = (
      <span className="tgb-version-new">
        {t('newVersion')} v{newer.version}
        {newer.summary === undefined ? '' : ` · ${newer.summary}`}
        {newer.date === undefined ? '' : ` · ${new Date(newer.date).toLocaleDateString()}`}
      </span>
    )
  } else status = <span className="tgb-version-ok">{t('upToDate')} · {t('checkedAt')} {new Date(check.checkedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>

  return (
    <section className="tgb-version" aria-label={t('versionTitle')}>
      <div className="tgb-version-head">
        <div className="tgb-version-main">
          <strong>{t('versionTitle')}</strong>
          <span className="tgb-version-current">v{check.installed} · {sourceLabel}</span>
        </div>
        <div className="tgb-version-actions">
          {newer !== undefined && <a className="tgb-button" href={newer.url} target="_blank" rel="noreferrer">{t('releaseNotes')}</a>}
          {repoUrl !== undefined && newer === undefined && <a className="tgb-button" href={repoUrl} target="_blank" rel="noreferrer">GitHub</a>}
          <button type="button" className="tgb-button" disabled={phase.kind === 'checking'} onClick={recheck}>{t('checkUpdate')}</button>
        </div>
      </div>
      <div className="tgb-version-status" role="status">{status}</div>
      {newer !== undefined && source.kind === 'github' && <p className="tgb-version-hint">{t('githubUpdateHint')}</p>}
      {newer !== undefined && source.kind === 'npm' && <p className="tgb-version-hint">{t('hostUpdateHint')}</p>}
    </section>
  )
}
