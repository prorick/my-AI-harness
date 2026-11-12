// Turns the tree from markdown.js into DOM nodes. Every piece of model text
// goes in through createTextNode / textContent — never innerHTML — so a reply
// cannot inject markup or script.

import { parseBlocks } from './markdown.js';

export function renderMarkdown(src, doc = document) {
  const fragment = doc.createDocumentFragment();
  for (const block of parseBlocks(src)) fragment.append(renderBlock(block, doc));
  return fragment;
}

function renderInline(nodes, doc, parent) {
  for (const node of nodes) {
    if (node.type === 'text') {
      parent.append(doc.createTextNode(node.text));
    } else if (node.type === 'code') {
      const code = doc.createElement('code');
      code.textContent = node.text;
      parent.append(code);
    } else if (node.type === 'link') {
      const a = doc.createElement('a');
      a.href = node.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      renderInline(node.children, doc, a);
      parent.append(a);
    } else {
      const el = doc.createElement(node.type === 'strong' ? 'strong' : 'em');
      renderInline(node.children, doc, el);
      parent.append(el);
    }
  }
  return parent;
}

function renderBlock(block, doc) {
  switch (block.type) {
    case 'heading':
      // The page's own h1 is the conversation title; reply headings sit below it.
      return renderInline(block.children, doc, doc.createElement(`h${Math.min(block.level + 1, 6)}`));
    case 'code': {
      const figure = doc.createElement('figure');
      figure.className = 'code';
      const head = doc.createElement('div');
      head.className = 'code-head';
      const lang = doc.createElement('span');
      lang.textContent = block.lang || 'text';
      const copy = doc.createElement('button');
      copy.type = 'button';
      copy.className = 'link-btn';
      copy.dataset.action = 'copy-code';
      copy.textContent = 'Copy';
      head.append(lang, copy);
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = block.text;
      pre.append(code);
      figure.append(head, pre);
      return figure;
    }
    case 'list': {
      const list = doc.createElement(block.ordered ? 'ol' : 'ul');
      if (block.ordered && block.start !== 1) list.start = block.start;
      for (const item of block.items) {
        const li = doc.createElement('li');
        // A one-paragraph item reads as a plain line, not a spaced paragraph.
        if (item.length === 1 && item[0].type === 'paragraph') renderInline(item[0].children, doc, li);
        else for (const child of item) li.append(renderBlock(child, doc));
        list.append(li);
      }
      return list;
    }
    case 'quote': {
      const quote = doc.createElement('blockquote');
      for (const child of block.children) quote.append(renderBlock(child, doc));
      return quote;
    }
    case 'rule':
      return doc.createElement('hr');
    default:
      return renderInline(block.children, doc, doc.createElement('p'));
  }
}
