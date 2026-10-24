import { describe, expect, it } from 'vitest'
import { chunkMarkdown, markdownToTelegramHtml } from '../src/markdown.ts'

const html = markdownToTelegramHtml

describe('markdownToTelegramHtml', () => {
  it('renders emphasis, code, strike, and links', () => {
    expect(html('**bold** and *it* and ~~gone~~ and `a<b>`')).toBe('<b>bold</b> and <i>it</i> and <s>gone</s> and <code>a&lt;b&gt;</code>')
    expect(html('see [docs](https://x.dev/a?b=1&c=2)')).toBe('see <a href="https://x.dev/a?b=1&amp;c=2">docs</a>')
  })

  it('leaves snake_case and arithmetic alone', () => {
    expect(html('use my_var_name and 2*3*4')).toBe('use my_var_name and 2*3*4')
  })

  it('does not format inside inline code', () => {
    expect(html('run `npm **test**`')).toBe('run <code>npm **test**</code>')
  })

  it('renders fenced code with language and escapes it', () => {
    expect(html('```ts\nconst a = 1 < 2\n```')).toBe('<pre><code class="language-ts">const a = 1 &lt; 2</code></pre>')
  })

  it('renders headings, quotes, lists, rules, and task boxes', () => {
    expect(html('# Title\n> quoted **x**\n- one\n  - nested\n- [x] done\n---')).toBe(
      '<b>Title</b>\n<blockquote>quoted <b>x</b></blockquote>\n• one\n  • nested\n☑ done\n──────────',
    )
  })

  it('keeps tables aligned in a monospace block', () => {
    expect(html('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('<pre>| a | b |\n| 1 | 2 |</pre>')
  })

  it('escapes raw HTML in text', () => {
    expect(html('<script>alert(1)</script> & co')).toBe('&lt;script&gt;alert(1)&lt;/script&gt; &amp; co')
  })

  it('tolerates an unclosed fence', () => {
    expect(html('```\nhalf')).toBe('<pre><code>half</code></pre>')
  })
})

describe('chunkMarkdown', () => {
  it('keeps short text whole', () => {
    expect(chunkMarkdown('hello')).toEqual(['hello'])
  })

  it('cuts between paragraphs', () => {
    const chunks = chunkMarkdown(`${'a'.repeat(60)}\n\n${'b'.repeat(60)}`, 100)
    expect(chunks).toEqual(['a'.repeat(60), 'b'.repeat(60)])
  })

  it('re-fences long code blocks so every piece stays valid', () => {
    const code = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const chunks = chunkMarkdown(`\`\`\`js\n${code}\n\`\`\``, 120)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.startsWith('```js\n')).toBe(true)
      expect(chunk.endsWith('\n```')).toBe(true)
      expect(chunk.length).toBeLessThanOrEqual(120)
    }
  })
})
