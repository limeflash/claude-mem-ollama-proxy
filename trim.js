'use strict';

// claude-mem's OpenAI-compatible generator resends its ENTIRE session history
// on every call -- each past tool input/output verbatim -- and never trims it.
// A long session reached ~190k input tokens per call for a ~1k-token answer,
// which is what actually drained the usage quota.
//
// Keep the first message (it carries the output-format instructions) and the
// newest messages that fit in the budget. Older observations are already saved;
// the model only needs recent ones to avoid repeating itself.

const BUDGET = Number(process.env.CMP_MAX_HISTORY_CHARS || 80000); // ~20k tokens; 0 = off

const len = (m) => (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length);

function trimHistory(body, budget = BUDGET) {
  const msgs = body.messages;
  if (!budget || !Array.isArray(msgs) || msgs.length < 3) return 0;

  let used = len(msgs[0]) + len(msgs[msgs.length - 1]);
  let start = msgs.length - 1; // the newest message is always kept
  while (start > 1 && used + len(msgs[start - 1]) <= budget) used += len(msgs[--start]);
  // Do not open the kept tail with an orphaned assistant reply.
  if (start > 1 && msgs[start].role === 'assistant' && start < msgs.length - 1) start++;

  const dropped = start - 1;
  if (dropped > 0) body.messages = [msgs[0], ...msgs.slice(start)];
  return dropped;
}

module.exports = { trimHistory };

if (require.main === module) {
  const assert = require('node:assert');
  const m = (role, n) => ({ role, content: 'x'.repeat(n) });
  const body = { messages: [m('user', 100), m('user', 500), m('assistant', 500), m('user', 500), m('assistant', 500), m('user', 500)] };
  // 100 + newest 500 + two more 500s = 1600 <= 1700; the third would overflow.
  assert.strictEqual(trimHistory(body, 1700), 2);
  assert.deepStrictEqual(body.messages.map((x) => x.role), ['user', 'user', 'assistant', 'user']);
  assert.strictEqual(body.messages[0].content.length, 100);
  // Budget that would start the tail on an assistant reply skips past it.
  const b2 = { messages: [m('user', 100), m('user', 500), m('assistant', 500), m('user', 500)] };
  assert.strictEqual(trimHistory(b2, 1200), 2);
  assert.deepStrictEqual(b2.messages.map((x) => x.role), ['user', 'user']);
  const small = { messages: [m('user', 10), m('assistant', 10), m('user', 10)] };
  assert.strictEqual(trimHistory(small, 1000), 0);
  assert.strictEqual(small.messages.length, 3);
  console.log('trim OK');
}
