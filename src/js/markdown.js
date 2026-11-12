// A small markdown reader for model replies. It turns text into a plain tree
// of blocks and inline nodes; render.js turns that tree into DOM nodes using
// text nodes only. There is deliberately no HTML node type: whatever a model
// writes, it can only ever become text. That matters here because the API key
// lives in localStorage, where injected script could read it (ADR-0001).
//
// Covered: paragraphs, headings, fenced code, lists (nested), block quotes,
// rules; inline code, bold, italic, links, bare URLs. Not covered: tables and
// raw HTML (both show as written), images (shown as a link, never loaded).

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;

const indentOf = (line) => line.length - line.trimStart().length;
const isOrdered = (marker) => /\d/.test(marker[0]);

// Can this line end a paragraph without a blank line before it? A numbered
// item only can when it starts at 1, so "…in\n2024. That year" stays prose.
function startsBlock(line) {
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  const item = line.match(ITEM);
  return Boolean(item) && (!isOrdered(item[2]) || parseInt(item[2], 10) === 1);
}

export function parseBlocks(src) {
  const lines = String(src)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length)));
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m;
    if ((m = line.match(FENCE))) {
      const closing = new RegExp(`^ {0,3}${m[1][0]}{${m[1].length},}[ \\t]*$`);
      const body = [];
      i++;
      while (i < lines.length && !closing.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence — or the end of the text, while a reply is still streaming
      blocks.push({ type: 'code', lang: m[2], text: body.join('\n') });
      continue;
    }
    if ((m = line.match(HEADING))) {
      blocks.push({ type: 'heading', level: m[1].length, children: parseInline(m[2]) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && (m = lines[i].match(QUOTE))) {
        inner.push(m[1]);
        i++;
      }
      blocks.push({ type: 'quote', children: parseBlocks(inner.join('\n')) });
      continue;
    }
    if (ITEM.test(line)) {
      const [list, next] = parseList(lines, i);
      blocks.push(list);
      i = next;
      continue;
    }
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++]);
    blocks.push({ type: 'paragraph', children: parseInline(para.join('\n')) });
  }
  return blocks;
}

// Reads one list starting at lines[start]; returns [listBlock, nextLineIndex].
// Lines indented under an item belong to it and are parsed as blocks in their
// own right, which is what makes nesting work.
function parseList(lines, start) {
  const first = lines[start].match(ITEM);
  const ordered = isOrdered(first[2]);
  const base = first[1].length;
  const list = { type: 'list', ordered, start: ordered ? parseInt(first[2], 10) : null, items: [] };
  const sibling = (line) => {
    const m = line.match(ITEM);
    return m && m[1].length === base && isOrdered(m[2]) === ordered ? m : null;
  };

  let i = start;
  for (;;) {
    const m = sibling(lines[i]);
    const contentIndent = base + m[2].length + 1;
    const body = [m[3]];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && indentOf(lines[j]) >= base + 2) {
          body.push('');
          i = j;
          continue;
        }
        break;
      }
      const indent = indentOf(line);
      if (indent >= base + 2) {
        body.push(line.slice(Math.min(indent, contentIndent)));
        i++;
        continue;
      }
      if (ITEM.test(line) || startsBlock(line)) break;
      body.push(line.trim()); // a wrapped line of the item's paragraph
      i++;
    }
    list.items.push(parseBlocks(body.join('\n')));

    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j < lines.length && sibling(lines[j])) i = j;
    else break;
  }
  return [list, i];
}

export const isSafeUrl = (url) => /^(https?:\/\/|mailto:)/i.test(url);

const CODE_SPAN = /^(`+)([\s\S]*?[^`])\1(?!`)/;
const BOLD = /^(\*\*|__)(\S(?:[\s\S]*?\S)?)\1/;
const ITALIC_STAR = /^\*([^\s*](?:[^*]*[^\s*])?)\*(?!\*)/;
const ITALIC_UNDERSCORE = /^_([^\s_](?:[^_]*[^\s_])?)_(?![A-Za-z0-9])/;
const LINK = /^!?\[((?:[^\[\]\\]|\\.)+)\]\(\s*<?([^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*)>?(?:\s+"[^"]*")?\s*\)/;
const BARE_URL = /^https?:\/\/[^\s<>]+/;
const ESCAPABLE = /[\\`*_{}\[\]()#+\-.!>~|]/;
const WORD_CHAR = /[A-Za-z0-9]/;

export function parseInline(text) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ type: 'text', text: buf });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);
    const prev = i > 0 ? text[i - 1] : '';
    let m;

    if (ch === '\\' && ESCAPABLE.test(text[i + 1] ?? '')) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`' && (m = rest.match(CODE_SPAN))) {
      flush();
      out.push({ type: 'code', text: m[2].replace(/^ (.*) $/s, '$1') });
      i += m[0].length;
      continue;
    }
    // `_` only opens emphasis at a word boundary, so snake_case stays intact.
    const underscoreOk = ch !== '_' || !WORD_CHAR.test(prev);
    if ((ch === '*' || ch === '_') && underscoreOk && (m = rest.match(BOLD)) && (ch !== '_' || !WORD_CHAR.test(text[i + m[0].length] ?? ''))) {
      flush();
      out.push({ type: 'strong', children: parseInline(m[2]) });
      i += m[0].length;
      continue;
    }
    if ((ch === '*' && (m = rest.match(ITALIC_STAR))) || (ch === '_' && underscoreOk && (m = rest.match(ITALIC_UNDERSCORE)))) {
      flush();
      out.push({ type: 'em', children: parseInline(m[1]) });
      i += m[0].length;
      continue;
    }
    // Links, and images as links: remote images are never loaded.
    if ((ch === '[' || (ch === '!' && text[i + 1] === '[')) && (m = rest.match(LINK)) && isSafeUrl(m[2])) {
      flush();
      out.push({ type: 'link', href: m[2], children: parseInline(m[1]) });
      i += m[0].length;
      continue;
    }
    if (ch === 'h' && !WORD_CHAR.test(prev) && (m = rest.match(BARE_URL))) {
      const url = m[0].replace(/[.,;:!?)\]'"*_]+$/, '');
      flush();
      out.push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
      i += url.length;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}
