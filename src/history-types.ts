/**
 * Chat history shapes shared by the Host log and the browser viewer. This
 * file must stay free of Node imports: the browser half imports it.
 */

/** Who sent an incoming message. */
export interface ChatSender {
  /** Numbers in entries written before lines existed. */
  readonly id: string | number
  readonly name: string
  readonly username?: string
}

/** One attachment shown in the viewer. */
export interface ChatAttachment {
  readonly name: string
  readonly kind: 'image' | 'file'
  readonly size?: number
  /** Stored copy under the chat's media directory, for images the viewer can display. */
  readonly media?: string
  /** Host path of a file the Agent presented. */
  readonly path?: string
}

/** One history line. */
export interface ChatEntry {
  readonly id: string
  readonly at: number
  readonly dir: 'in' | 'out'
  /**
   * `text`/`command`/`media` come from people; `assistant`, `tool`, `notice`,
   * `file`, and `approval` are what the bot sent; `web` was typed in the Web UI and sent as the bot; `denied` is a message from
   * a user outside the allow-list.
   */
  readonly kind: 'text' | 'command' | 'media' | 'assistant' | 'tool' | 'notice' | 'file' | 'approval' | 'denied' | 'web'
  readonly from?: ChatSender
  readonly text?: string
  readonly attachments?: readonly ChatAttachment[]
  readonly sessionId?: string
  readonly approval?: {
    readonly tool: string
    readonly detail?: string
    readonly outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'timeout'
    readonly by?: string
  }
}

/** What the chat list shows per chat. */
export interface ChatSummary {
  /** Chat key: `<line>:<chat id>`, or a bare Telegram id on the legacy line. */
  readonly chatId: string
  title: string
  type: string
  username?: string
  sessionId?: string
  lastAt: number
  lastText: string
  count: number
  /** True while every message so far came from users outside the allow-list. */
  deniedOnly: boolean
  /** The bound Session's model (`provider/model`), when known; added by the overview route, never stored. */
  model?: string
  /** The chat's line and its platform; added by the overview route, never stored. */
  line?: string
  channel?: string
}

/** Facts about a chat known when a message arrives. */
export interface ChatInfo {
  readonly chatId: string
  readonly title?: string
  readonly type?: string
  readonly username?: string
}

/** A page of history, oldest first. */
export interface ChatPage {
  readonly entries: ChatEntry[]
  /** Whether older entries exist before the first returned one. */
  readonly more: boolean
}

/** Dashboard figures for the panel. */
export interface ChatStats {
  readonly today: { readonly in: number; readonly out: number }
  readonly week: {
    readonly messages: number
    readonly activeChats: number
    readonly allowed: number
    readonly rejected: number
    readonly denied: number
  }
  /** The last 14 days, oldest first. */
  readonly series: readonly { readonly day: string; readonly in: number; readonly out: number }[]
}
