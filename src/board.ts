/**
 * The live board: one message listing what every Session is doing, kept up to
 * date in place so a chat can see at a glance what needs it. This module only
 * orders and renders rows; the bridge gathers them and owns the message.
 */

import type { Button, OutMessage } from './channels/types.ts'
import type { Messages } from './messages.ts'

/** What a Session asks of the person reading the board, most urgent first. */
export type BoardState = 'waiting' | 'failed' | 'running' | 'idle'

/** One Session on the board. */
export interface BoardRow {
  readonly sessionId: string
  readonly title: string
  readonly state: BoardState
  /** What it is doing, or why it stopped. */
  readonly detail?: string
}

const ORDER: Record<BoardState, number> = { waiting: 0, failed: 1, running: 2, idle: 3 }
const ICON: Record<BoardState, string> = { waiting: '❓', failed: '❌', running: '▶', idle: '·' }
/** Rows a board shows; idle Sessions past this are only counted. */
const BOARD_ROWS = 12
/** Sessions a board offers a button for. */
const BOARD_BUTTONS = 8
/** Telegram's limit on a button's data. */
const BUTTON_DATA_BYTES = 64
const TITLE_LENGTH = 40

/** A board's button that switches the chat to a Session; undefined when its id does not fit. */
function sessionButton(row: BoardRow): Button | undefined {
  const data = `bd:s:${row.sessionId}`
  if (Buffer.byteLength(data) > BUTTON_DATA_BYTES) return undefined
  return { text: `${ICON[row.state]} ${clip(row.title, 30)}`, data }
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** Render a board: urgent Sessions first, each with a button to switch to it. */
export function boardMessage(t: Messages, rows: readonly BoardRow[]): OutMessage {
  const sorted = [...rows].sort((a, b) => ORDER[a.state] - ORDER[b.state])
  const shown = sorted.slice(0, BOARD_ROWS)
  const count = (state: BoardState): number => rows.filter(row => row.state === state).length
  const tally = (['waiting', 'failed', 'running'] as const)
    .filter(state => count(state) > 0)
    .map(state => `${ICON[state]} ${count(state)}`)
  const lines = shown.map(row => `${ICON[row.state]} ${clip(row.title, TITLE_LENGTH)}${row.detail === undefined ? '' : ` · ${row.detail}`}`)
  const hidden = sorted.length - shown.length
  const text = rows.length === 0
    ? `${t.boardTitle([])}\n${t.boardEmpty}`
    : [t.boardTitle(tally), ...lines, ...(hidden > 0 ? [t.boardMore(hidden)] : [])].join('\n')
  const switches = sorted
    .filter(row => row.state !== 'idle')
    .slice(0, BOARD_BUTTONS)
    .flatMap((row) => {
      const button = sessionButton(row)
      return button === undefined ? [] : [[button]]
    })
  return { text, buttons: [...switches, [{ text: t.boardRefresh, data: 'bd:r' }, { text: t.boardClose, data: 'bd:x' }]], editable: true }
}
