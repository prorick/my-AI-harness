import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gist, thinkingLabel } from '../src/js/thinking.js';

test('a provider summary shows its title as the gist, without the markdown marks', () => {
  // The shape OpenAI-style summaries arrive in: a bold title, then prose.
  const summary = '**Evaluating the arithmetic**\n\nThe user wants the sum of 5 and 5. That is 10.\n\n**Writing the answer**\n\nKeep it short.';
  assert.equal(gist(summary), 'Evaluating the arithmetic');
});

test('raw reasoning shows its first sentence, or is cut at a word when the sentence runs long', () => {
  const raw = 'The user is asking how TCP slow start works. I should cover the congestion window, the doubling per round trip, and what ends it.';
  assert.equal(gist(raw), 'The user is asking how TCP slow start works.');

  const rambling = 'Okay so the question here is about why the sky looks blue during the day and then turns red or orange near sunset and I need to recall the physics';
  const cut = gist(rambling);
  assert.ok(cut.length <= 91 && cut.endsWith('…'), cut);
  assert.ok(rambling.startsWith(cut.slice(0, -1)), 'the gist is the start of the reasoning, not a rewrite');
  assert.ok(!cut.slice(0, -1).endsWith(' '), 'cut at a word, not mid-space');
});

test('while the model is still thinking, the gist follows its latest line', () => {
  const soFar = '**Reading the question**\n\nIt is about TCP.\n\n- Recall slow start\n- Check `ssthresh` behaviour\n';
  assert.equal(gist(soFar, { from: 'end' }), 'Check ssthresh behaviour');
  assert.equal(gist(soFar), 'Reading the question');
});

test('there is no gist when there is nothing readable', () => {
  assert.equal(gist(''), '');
  assert.equal(gist('\n\n  \n'), '');
  assert.equal(gist('[REDACTED]'), '');
  assert.equal(gist(undefined), '');
});

test('the row says how long the model thought, in the units a person would use', () => {
  assert.equal(thinkingLabel(300), 'Thought briefly');
  assert.equal(thinkingLabel(4200), 'Thought for 4s');
  assert.equal(thinkingLabel(59600), 'Thought for 1m', 'rounds up to the minute, never "60s"');
  assert.equal(thinkingLabel(72000), 'Thought for 1m 12s');
  // A reply saved without a duration (stopped mid-thought in an older version, or hand-edited).
  assert.equal(thinkingLabel(undefined), 'Thinking');
});
