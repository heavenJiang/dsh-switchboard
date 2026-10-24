/**
 * Markdown → Telegram HTML. Agent replies are Markdown; Telegram renders a
 * small HTML subset (b, i, s, code, pre, a, blockquote). Anything outside it
 * is escaped text, so the output always parses; the caller still falls back
 * to plain text if Telegram rejects a message.
 */

/** Telegram's message limit; chunks leave headroom for the tags conversion adds. */
const CHUNK_LIMIT = 3500

/** Escape text for Telegram HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

/** One fenced code block or a run of ordinary Markdown. */
type Block = { kind: 'code'; lang: string; body: string } | { kind: 'text'; body: string }

const FENCE = /^ {0,3}(`{3,}|~{3,})([^`\n]*)$/u

/** Split Markdown into fenced code blocks and text runs. An unclosed fence runs to the end. */
function blocks(markdown: string): Block[] {
  const out: Block[] = []
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  let text: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]!)
    if (open === null) {
      text.push(lines[i]!)
      continue
    }
    if (text.length > 0) out.push({ kind: 'text', body: text.join('\n') })
    text = []
    const marker = open[1]!
    const body: string[] = []
    i++
    while (i < lines.length && !(lines[i]!.trim().startsWith(marker[0]!.repeat(marker.length)) && lines[i]!.trim().replace(/[`~]/gu, '') === '')) {
      body.push(lines[i]!)
      i++
    }
    out.push({ kind: 'code', lang: open[2]!.trim().split(/\s+/u)[0] ?? '', body: body.join('\n') })
  }
  if (text.length > 0) out.push({ kind: 'text', body: text.join('\n') })
  return out
}

/** Inline Markdown on one already-unescaped line. */
function inline(line: string): string {
  // Protect inline code and links before emphasis rules can touch them.
  const slots: string[] = []
  const hold = (html: string): string => `\u0000${slots.push(html) - 1}\u0000`
  let s = line.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/gu, (_m, _t, code: string) => hold(`<code>${escapeHtml(code.trim())}</code>`))
  s = s.replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/gu, (_m, label: string, url: string) =>
    hold(`<a href="${escapeHtml(url).replace(/"/gu, '&quot;')}">${escapeHtml(label)}</a>`))
  s = escapeHtml(s)
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/gu, '<b>$1</b>')
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/gu, '$1<b>$2</b>')
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/gu, '<s>$1</s>')
  s = s.replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/gu, '$1<i>$2</i>')
  s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/gu, '$1<i>$2</i>')
  return s.replace(/\u0000(\d+)\u0000/gu, (_m, index: string) => slots[Number(index)] ?? '')
}

/** Convert one text run (no fences) line by line. */
function textBlock(body: string): string {
  const lines = body.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // Tables do not fit a phone's width as text; keep their alignment in a monospace block.
    if (/^\s*\|.*\|\s*$/u.test(line)) {
      const table: string[] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/u.test(lines[i]!)) {
        if (!/^\s*\|[\s:|-]+\|\s*$/u.test(lines[i]!)) table.push(lines[i]!.trim())
        i++
      }
      i--
      out.push(`<pre>${escapeHtml(table.join('\n'))}</pre>`)
      continue
    }
    if (/^\s*>/u.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>/u.test(lines[i]!)) {
        quote.push(inline(lines[i]!.replace(/^\s*>\s?/u, '')))
        i++
      }
      i--
      out.push(`<blockquote>${quote.join('\n')}</blockquote>`)
      continue
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/u.exec(line)
    if (heading !== null) {
      out.push(`<b>${inline(heading[1]!)}</b>`)
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/u.test(line)) {
      out.push('──────────')
      continue
    }
    const bullet = /^(\s*)[-*+]\s+(\[[ xX]\]\s+)?(.*)$/u.exec(line)
    if (bullet !== null) {
      const indent = '  '.repeat(Math.floor(bullet[1]!.length / 2))
      const box = bullet[2] === undefined ? '•' : /\[[xX]\]/u.test(bullet[2]) ? '☑' : '☐'
      out.push(`${indent}${box} ${inline(bullet[3]!)}`)
      continue
    }
    out.push(inline(line))
  }
  return out.join('\n')
}

/**
 * Render Markdown as Telegram HTML.
 * @param markdown - Agent reply text.
 * @returns HTML using only tags Telegram accepts.
 */
export function markdownToTelegramHtml(markdown: string): string {
  return blocks(markdown).map(block => block.kind === 'code'
    ? `<pre><code${block.lang === '' ? '' : ` class="language-${escapeHtml(block.lang)}"`}>${escapeHtml(block.body)}</code></pre>`
    : textBlock(block.body)).join('\n').replace(/\n{3,}/gu, '\n\n').trim()
}

/**
 * Split Markdown into pieces that each render under Telegram's limit,
 * cutting between blocks and paragraphs and re-fencing long code blocks.
 * @param markdown - source text.
 * @param limit - maximum source length per piece.
 */
export function chunkMarkdown(markdown: string, limit: number = CHUNK_LIMIT): string[] {
  const pieces: string[] = []
  let current = ''
  const push = (part: string): void => {
    if (current !== '' && current.length + part.length + 2 > limit) {
      pieces.push(current)
      current = ''
    }
    current = current === '' ? part : `${current}\n\n${part}`
  }
  for (const block of blocks(markdown.trim())) {
    if (block.kind === 'code') {
      const fence = (body: string): string => `\`\`\`${block.lang}\n${body}\n\`\`\``
      if (block.body.length + 8 + block.lang.length <= limit) {
        push(fence(block.body))
        continue
      }
      let part: string[] = []
      let size = 0
      for (const line of block.body.split('\n')) {
        if (size + line.length + 1 > limit - 16 && part.length > 0) {
          push(fence(part.join('\n')))
          part = []
          size = 0
        }
        part.push(line.length > limit - 16 ? line.slice(0, limit - 17) : line)
        size += line.length + 1
      }
      if (part.length > 0) push(fence(part.join('\n')))
      continue
    }
    for (const paragraph of block.body.split(/\n{2,}/u)) {
      if (paragraph.trim() === '') continue
      if (paragraph.length <= limit) {
        push(paragraph)
        continue
      }
      // A single huge paragraph: cut at line, then word boundaries.
      let rest = paragraph
      while (rest.length > limit) {
        const window = rest.slice(0, limit)
        let cut = window.lastIndexOf('\n')
        if (cut < limit / 2) cut = window.lastIndexOf(' ')
        if (cut <= 0) cut = limit
        push(rest.slice(0, cut).trimEnd())
        rest = rest.slice(cut).trimStart()
      }
      if (rest !== '') push(rest)
    }
  }
  if (current !== '') pieces.push(current)
  return pieces
}
