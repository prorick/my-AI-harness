// Words for the "Thought for…" row above a reply (ADR-0002). The row shows a
// duration and a one-line gist; expanding it shows the model's reasoning in
// full. Both the gist and the full text are the model's own words — nothing
// here writes an explanation on the model's behalf.

export function thinkingLabel(ms) {
  if (!Number.isFinite(ms)) return 'Thinking';
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return 'Thought briefly';
  if (seconds < 60) return `Thought for ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `Thought for ${minutes}m ${rest}s` : `Thought for ${minutes}m`;
}

// One line of the reasoning, cleaned of markdown marks, to show while the row
// is collapsed. `from: 'start'` gives the opening line (a finished reply);
// `from: 'end'` gives the latest line (while the model is still thinking).
export function gist(reasoning, { from = 'start', max = 90 } = {}) {
  const lines = String(reasoning ?? '').split('\n');
  if (from === 'end') lines.reverse();
  for (const raw of lines) {
    const line = raw
      .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d{1,9}[.)]\s+|>\s?)/, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line || line === '[REDACTED]') continue;
    if (line.length <= max) return line;
    // Prefer a whole first sentence; otherwise cut at a word.
    const sentence = line.match(/^(.{12,}?[.!?])\s/);
    if (sentence && sentence[1].length <= max) return sentence[1];
    const cut = line.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }
  return '';
}
