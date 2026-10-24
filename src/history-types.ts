/**
 * Chat history shapes shared by the Host log and the browser viewer. This
 * file must stay free of Node imports: the browser half imports it.
 */

/** Who sent an incoming message. */
export interface ChatSender {
  readonly id: number
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
   * `file`, and `approval` are what the bot sent; `denied` is a message from
   * a user outside the allow-list.
   */
  readonly kind: 'text' | 'command' | 'media' | 'assistant' | 'tool' | 'notice' | 'file' | 'approval' | 'denied'
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
  readonly chatId: number
  title: string
  type: string
  username?: string
  sessionId?: string
  lastAt: number
  lastText: string
  count: number
  /** True while every message so far came from users outside the allow-list. */
  deniedOnly: boolean
}

/** Facts about a chat known when a message arrives. */
export interface ChatInfo {
  readonly chatId: number
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
