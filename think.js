'use strict';

// Routing for models that think out loud.
//
// Ollama's OpenAI-compatible endpoint cannot turn thinking off or separate it:
// the `think` parameter is not accepted there (ollama/ollama#15288, #15293), so
// a reasoning model either narrates into `content` — poisoning whatever stores
// it — or, with `reasoning.enabled:false`, leaves `content` empty and puts
// everything in `reasoning`. Neither is usable for a memory summariser.
//
// The native /api/chat endpoint does support it. Counter-intuitively the useful
// setting is `think: true`, not false: true puts the deliberation in its own
// `thinking` field and leaves `content` for the answer, while false merely
// inlines the same narration back into `content`.
//
// Measured on glm-5.3-flash: think=false -> 853 chars of narration in content;
// think=true -> 1204 chars of thinking, 286 chars of clean "TITLE:/FACT:".

const DEFAULT_PATTERNS = 'glm-*';

// A caller's max_tokens budgets the ANSWER. The model also has to spend tokens
// thinking before it gets there, and that spend is invisible to the caller — a
// 200-token request died mid-deliberation every time. Give the hidden half its
// own headroom rather than making every caller inflate max_tokens.
const HEADROOM = Number(process.env.CMP_THINK_HEADROOM || 1200);

const patterns = (process.env.CMP_THINK_MODELS ?? DEFAULT_PATTERNS)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((glob) => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'));

function isThinkModel(model) {
  return typeof model === 'string' && patterns.some((rx) => rx.test(model));
}

// OpenAI chat/completions body -> native /api/chat body.
function toNative(body) {
  const options = {};
  if (typeof body.temperature === 'number') options.temperature = body.temperature;
  if (typeof body.top_p === 'number') options.top_p = body.top_p;
  const asked = Number(body.max_tokens || body.max_completion_tokens || 0);
  if (asked > 0) options.num_predict = asked + HEADROOM;

  return {
    model: body.model,
    messages: body.messages,
    stream: false,
    think: true,
    ...(Object.keys(options).length ? { options } : {}),
  };
}

// Native /api/chat response -> OpenAI chat/completions shape. The `thinking`
// field is deliberately dropped: it is the part the caller must never store.
function fromNative(native, model) {
  const msg = native.message || {};
  const prompt = native.prompt_eval_count || 0;
  const completion = native.eval_count || 0;

  return {
    body: {
      id: 'chatcmpl-cmp-' + (native.created_at || ''),
      object: 'chat.completion',
      created: Math.floor(Date.parse(native.created_at || '') / 1000) || 0,
      model: native.model || model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: msg.content || '' },
          finish_reason: native.done_reason === 'length' ? 'length' : 'stop',
        },
      ],
      usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
    },
    thoughtChars: (msg.thinking || '').length,
  };
}

module.exports = { isThinkModel, toNative, fromNative, HEADROOM };
