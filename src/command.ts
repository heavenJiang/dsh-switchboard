/**
 * `/telegram` in the Web composer: link the open Session to a Telegram chat
 * without leaving the conversation. The command runs on the Host against the
 * exact Agent the UI addressed and never reaches the model.
 *
 *   /telegram                  where this Session is linked, and the known chats
 *   /telegram bind <chat>      the chat talks to this Session
 *   /telegram watch <chat>     the chat follows this Session's completions and approvals
 *   /telegram unbind [chat]    remove links (all chats when omitted)
 *   /telegram send <text>      send text to the bound chats as the bot
 *
 * `<chat>` matches a chat id, `@username`, or a title fragment from the history.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type { TelegramBridge } from './bridge.ts'
import type { ChatLog, ChatSummary } from './chatlog.ts'
import type { BotLanguage } from './messages.ts'

type Result = { kind: 'success'; text: string } | { kind: 'error'; text: string }

const COPY = {
  zh: {
    description: '把当前会话关联到 Telegram 聊天',
    hint: 'bind <聊天> | watch <聊天> | unbind [聊天] | send <文字>',
    none: '还没有任何 Telegram 聊天记录。先在 Telegram 中给机器人发送 /start。',
    links: (lines: string[]) => lines.length === 0 ? '当前会话没有关联 Telegram 聊天。' : `当前会话关联的聊天：\n${lines.join('\n')}`,
    known: (lines: string[]) => `可用的聊天：\n${lines.join('\n')}\n\n用法：/telegram bind <聊天>、/telegram watch <聊天>、/telegram unbind、/telegram send <文字>`,
    active: '对话', watch: '订阅',
    notFound: (q: string) => `找不到聊天「${q}」。发送 /telegram 查看可用聊天。`,
    ambiguous: (names: string[]) => `匹配到多个聊天，请写得更具体：${names.join('、')}`,
    bound: (title: string) => `已把当前会话绑定到 Telegram 聊天「${title}」，那里发送的消息会交给这个会话。`,
    watched: (title: string) => `Telegram 聊天「${title}」已订阅当前会话的完成与审批通知。`,
    unbound: (n: number) => `已解除 ${n} 个聊天的关联。`,
    sent: (n: number) => `已发送到 ${n} 个聊天。`,
    noBound: '当前会话没有绑定的聊天，先用 /telegram bind <聊天>。',
    usage: '用法：/telegram [bind|watch|unbind|send] …',
  },
  en: {
    description: 'Link this Session to a Telegram chat',
    hint: 'bind <chat> | watch <chat> | unbind [chat] | send <text>',
    none: 'No Telegram chats yet. Send /start to the bot in Telegram first.',
    links: (lines: string[]) => lines.length === 0 ? 'This Session is not linked to any Telegram chat.' : `Linked chats:\n${lines.join('\n')}`,
    known: (lines: string[]) => `Known chats:\n${lines.join('\n')}\n\nUsage: /telegram bind <chat>, /telegram watch <chat>, /telegram unbind, /telegram send <text>`,
    active: 'talks', watch: 'follows',
    notFound: (q: string) => `No chat matches "${q}". Send /telegram for the list.`,
    ambiguous: (names: string[]) => `Several chats match; be more specific: ${names.join(', ')}`,
    bound: (title: string) => `Bound this Session to Telegram chat "${title}"; messages there now come here.`,
    watched: (title: string) => `Telegram chat "${title}" now follows this Session's completions and approvals.`,
    unbound: (n: number) => `Unlinked ${n} chat(s).`,
    sent: (n: number) => `Sent to ${n} chat(s).`,
    noBound: 'No chat is bound to this Session; use /telegram bind <chat> first.',
    usage: 'Usage: /telegram [bind|watch|unbind|send] …',
  },
}

/** Find one chat by id, @username, or title fragment. */
function match(chats: readonly ChatSummary[], query: string): ChatSummary | ChatSummary[] | undefined {
  const q = query.trim().replace(/^@/u, '').toLowerCase()
  const exact = chats.filter(chat => String(chat.chatId) === q || chat.username?.toLowerCase() === q || chat.title.toLowerCase() === q)
  if (exact.length === 1) return exact[0]
  const loose = chats.filter(chat => chat.title.toLowerCase().includes(q) || chat.username?.toLowerCase().includes(q) === true)
  return loose.length === 1 ? loose[0] : loose.length === 0 ? undefined : loose
}

/**
 * Register `/telegram` while the command registry exists.
 * @param ctx - a context with `commands` injected.
 * @param bridge - the running bridge.
 * @param log - chat history, for chat titles.
 * @param language - reply language.
 */
export function registerWebCommand(ctx: Context, bridge: TelegramBridge, log: ChatLog, language: () => BotLanguage): void {
  ctx.effect(() => ctx.commands.register({
    name: 'telegram',
    description: COPY[language()].description,
    input: { hint: COPY[language()].hint },
    handler: async ({ agent, rawInput }): Promise<Result> => {
      const t = COPY[language()]
      const sessionId = agent.session.header.id
      const chats = (await log.chats()).filter(chat => !chat.deniedOnly)
      const title = (chatId: number): string => chats.find(chat => chat.chatId === chatId)?.title ?? String(chatId)
      const [verb = '', ...rest] = rawInput.trim().split(/\s+/u)
      const arg = rawInput.trim().slice(verb.length).trim()
      const pick = (): ChatSummary | Result => {
        const found = match(chats, arg)
        if (found === undefined) return { kind: 'error', text: t.notFound(arg) }
        if (Array.isArray(found)) return { kind: 'error', text: t.ambiguous(found.map(chat => chat.title)) }
        return found
      }
      switch (verb.toLowerCase()) {
        case '': {
          if (chats.length === 0) return { kind: 'success', text: t.none }
          const links = bridge.linksOf(sessionId).map(link => `· ${title(link.chatId)} (${link.mode === 'active' ? t.active : t.watch})`)
          const known = chats.slice(0, 15).map(chat => `· ${chat.title}${chat.username === undefined ? '' : ` @${chat.username}`} — ${chat.chatId}`)
          return { kind: 'success', text: `${t.links(links)}\n\n${t.known(known)}` }
        }
        case 'bind':
        case 'watch': {
          if (rest.length === 0) return { kind: 'error', text: t.usage }
          const chat = pick()
          if ('kind' in chat) return chat
          await bridge.linkChat(chat.chatId, sessionId, verb.toLowerCase() === 'bind' ? 'active' : 'watch')
          return { kind: 'success', text: verb.toLowerCase() === 'bind' ? t.bound(chat.title) : t.watched(chat.title) }
        }
        case 'unbind': {
          const targets = rest.length === 0
            ? bridge.linksOf(sessionId).map(link => link.chatId)
            : (() => { const chat = pick(); return 'kind' in chat ? [] : [chat.chatId] })()
          for (const chatId of targets) await bridge.linkChat(chatId, sessionId, 'none')
          return { kind: 'success', text: t.unbound(targets.length) }
        }
        case 'send': {
          const bound = bridge.linksOf(sessionId).filter(link => link.mode === 'active').map(link => link.chatId)
          if (bound.length === 0) return { kind: 'error', text: t.noBound }
          if (arg === '') return { kind: 'error', text: t.usage }
          for (const chatId of bound) await bridge.sendFromWeb(chatId, arg)
          return { kind: 'success', text: t.sent(bound.length) }
        }
        default:
          return { kind: 'error', text: t.usage }
      }
    },
  }), 'switchboard: /telegram command')
}
