/**
 * Feishu app creation by QR, in the settings page: the Host starts the
 * Open Platform's registration and keeps the secret; this panel shows the QR
 * (drawn locally, the link never leaves the page) and polls until the
 * scanner confirms, fails, or the code expires.
 */

import qrcode from 'qrcode-generator'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { TelegramBridgeLocaleKey } from './locales.ts'

type T = (key: TelegramBridgeLocaleKey) => string

type Status =
  | { state: 'waiting'; url: string; expiresAt: number }
  | { state: 'done'; appId: string; domain: 'feishu' | 'lark'; ownerOpenId?: string }
  | { state: 'failed'; error: string }
  | { state: 'expired' }
  | { state: 'cancelled' }

export interface ScanResult {
  appId: string
  domain: 'feishu' | 'lark'
  ownerOpenId?: string
}

const POLL_MS = 2000

async function call(body: object): Promise<{ id?: string; status?: Status; error?: string }> {
  const response = await fetch('api/switchboard/feishu/register', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const value = await response.json() as { id?: string; status?: Status; error?: string }
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
  return value
}

/**
 * Run one registration while mounted.
 * @param props.appId - extend this app instead of creating one.
 */
export function FeishuScan(props: {
  t: T
  domain: 'feishu' | 'lark'
  secretRef: string
  appId?: string
  onDone: (result: ScanResult) => void
  onClose: () => void
}): ReactNode {
  const { t } = props
  const [id, setId] = useState<string | undefined>(undefined)
  const [status, setStatus] = useState<Status | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    let runId: string | undefined
    setStatus(undefined)
    setError(undefined)
    void call({
      action: 'start', domain: props.domain, secretRef: props.secretRef,
      ...(props.appId === undefined ? { appName: t('scanAppName'), appDescription: t('scanAppDescription') } : { appId: props.appId }),
    }).then((answer) => {
      runId = answer.id
      if (!live) {
        if (runId !== undefined) void call({ action: 'cancel', id: runId }).catch(() => {})
        return
      }
      setId(answer.id)
      setStatus(answer.status)
    }, (failure: unknown) => { if (live) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => {
      live = false
      if (runId !== undefined) void call({ action: 'cancel', id: runId }).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  useEffect(() => {
    if (id === undefined || status?.state !== 'waiting') return
    const timer = setTimeout(() => {
      void call({ action: 'status', id }).then((answer) => {
        if (answer.status === undefined) return
        setStatus(answer.status)
        if (answer.status.state === 'done') {
          props.onDone({
            appId: answer.status.appId, domain: answer.status.domain,
            ...(answer.status.ownerOpenId === undefined ? {} : { ownerOpenId: answer.status.ownerOpenId }),
          })
        }
      }, () => {})
    }, POLL_MS)
    return () => { clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, status])

  const failure = error ?? (status?.state === 'failed' ? (status.error === 'access_denied' ? t('scanDenied') : status.error) : undefined)
  return (
    <div className="tgb-scan" role="region" aria-label={props.appId === undefined ? t('feishuScan') : t('feishuRepair')}>
      <div className="tgb-scan-head">
        <strong>{props.appId === undefined ? t('feishuScan') : t('feishuRepair')}</strong>
        <button type="button" className="tgb-button" onClick={props.onClose}>{t('scanClose')}</button>
      </div>
      {status === undefined && failure === undefined && <p className="tgb-muted">{t('loading')}</p>}
      {status?.state === 'waiting' && status.url !== '' && (
        <div className="tgb-scan-body">
          <QrCode text={status.url} />
          <div className="tgb-scan-text">
            <p>{props.appId === undefined ? t('scanWaiting') : t('scanRepairWaiting')}</p>
            <p className="tgb-muted tgb-small">{t('scanHint')}</p>
            <a className="tgb-button" href={status.url} target="_blank" rel="noreferrer">{t('scanOpen')} ↗</a>
          </div>
        </div>
      )}
      {status?.state === 'done' && <p className="tgb-scan-ok">{t('scanDone').replace('{appId}', status.appId)}</p>}
      {(status?.state === 'expired' || failure !== undefined) && (
        <div className="tgb-scan-body">
          <p className="tgb-line-error">{failure ?? t('scanExpired')}</p>
          <button type="button" className="tgb-button" onClick={() => { setId(undefined); setAttempt(n => n + 1) }}>{t('scanRetry')}</button>
        </div>
      )}
    </div>
  )
}

/** A QR code as SVG squares. */
function QrCode({ text }: { text: string }): ReactNode {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'L')
    qr.addData(text)
    qr.make()
    const count = qr.getModuleCount()
    const dark: [number, number][] = []
    for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (qr.isDark(row, col)) dark.push([col, row])
    return { count, dark }
  }, [text])
  const margin = 2
  const size = cells.count + margin * 2
  return (
    <svg className="tgb-qr" viewBox={`0 0 ${size} ${size}`} width={240} height={240} role="img" aria-label="QR code" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path fill="#000" d={cells.dark.map(([x, y]) => `M${x + margin} ${y + margin}h1v1h-1z`).join('')} />
    </svg>
  )
}
