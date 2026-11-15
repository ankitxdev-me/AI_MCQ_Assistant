/**
 * Knowledge-base evaluation against the running backend (real Gemini, key from the backend's config).
 *
 * The facts below are invented, so the model cannot know them. A correct answer can only come from
 * the custom-knowledge note. The run checks three things:
 *   1. Without the note, accuracy is low (guessing).
 *   2. With the note, accuracy is (near) perfect, and the stale no-note answers are NOT served
 *      from cache.
 *   3. Ordinary questions are still answered correctly while the note is active.
 *
 * Run:  node e2e/kb-eval.mjs        (backend must be running on 127.0.0.1:3000)
 */

const BASE = 'http://127.0.0.1:3000';
const HEADERS = {
  'Content-Type': 'application/json',
  'x-pairing-token': process.env.API_PAIRING_TOKEN || 'ai_mcq_assistant_secret_token_change_in_production',
};

const NOTE = `Course notes: Project Nimbus internal handbook
- The Nimbus build tool is called "Zephyrctl".
- Nimbus services always run on port 7421.
- The Nimbus on-call rotation changes every 9 days.
- The Nimbus config file is named "nimbus.halo".
- Nimbus logs are retained for 37 days.
- The Nimbus mascot is a red panda named Quillo.
- In Nimbus, a "glint" is a request that took longer than 800 ms.
- The Nimbus deploy freeze starts every Thursday at 16:00.`;

const FICTIONAL = [
  { q: 'What is the name of the Nimbus build tool?', o: ['Nimbusctl', 'Zephyrctl', 'Halo CLI', 'Quillo'], a: 'Zephyrctl' },
  { q: 'On which port do Nimbus services always run?', o: ['8080', '3000', '7421', '7241'], a: '7421' },
  { q: 'How often does the Nimbus on-call rotation change?', o: ['Every 7 days', 'Every 9 days', 'Every 14 days', 'Every 30 days'], a: 'Every 9 days' },
  { q: 'What is the Nimbus config file called?', o: ['nimbus.yaml', 'nimbus.conf', 'halo.nimbus', 'nimbus.halo'], a: 'nimbus.halo' },
  { q: 'For how many days are Nimbus logs retained?', o: ['30', '37', '73', '90'], a: '37' },
  { q: 'What kind of animal is the Nimbus mascot?', o: ['Fox', 'Owl', 'Red panda', 'Otter'], a: 'Red panda' },
  { q: 'In Nimbus terminology, what is a "glint"?', o: ['A failed deploy', 'A request slower than 800 ms', 'A config typo', 'A cache miss'], a: 'A request slower than 800 ms' },
  { q: 'When does the Nimbus deploy freeze start?', o: ['Friday 17:00', 'Thursday 16:00', 'Monday 09:00', 'Wednesday 12:00'], a: 'Thursday 16:00' },
];

const GENERAL = [
  { q: 'Which HTTP status code means "Not Found"?', o: ['200', '301', '404', '500'], a: '404' },
  { q: 'Which data structure is First-In, First-Out?', o: ['Stack', 'Queue', 'Tree', 'Graph'], a: 'Queue' },
];

const ids = ['A', 'B', 'C', 'D'];
const fp = (prefix, i) => `kb_eval_${prefix}_${i}`;

async function api(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: HEADERS });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
  return json;
}

async function ask(item, fingerprint, forceFresh) {
  const options = item.o.map((text, i) => ({ id: ids[i], text }));
  const res = await api('/api/questions/solve', {
    method: 'POST',
    body: JSON.stringify({ question: item.q, options, questionFingerprint: fingerprint, forceFresh, pageTitle: 'KB eval' }),
  });
  const picked = options.find((o) => o.id === String(res.answer.selected_option_id).trim());
  return { correct: picked?.text === item.a, picked: picked?.text, cached: res.cached, confidence: res.answer.confidence };
}

async function run(label, items, prefix, forceFresh) {
  let correct = 0;
  let cached = 0;
  const rows = [];
  for (let i = 0; i < items.length; i++) {
    const r = await ask(items[i], fp(prefix, i), forceFresh);
    if (r.correct) correct++;
    if (r.cached) cached++;
    rows.push(`  ${r.correct ? 'OK  ' : 'MISS'} ${items[i].q}  ->  ${r.picked}${r.cached ? '  (cached)' : ''}`);
  }
  console.log(`\n${label}: ${correct}/${items.length} correct, ${cached} served from cache`);
  console.log(rows.join('\n'));
  return { correct, cached };
}

const status = await api('/api/config/status');
if (!status.configured) {
  console.error('Backend has no Gemini key. Save one in the extension settings first.');
  process.exit(1);
}
console.log(`Model: ${status.model}`);

// Start clean: remove notes left by an earlier run
for (const n of await api('/api/questions/custom-knowledge')) {
  if (n.topic === 'KB eval') await api(`/api/questions/custom-knowledge/${n.id}`, { method: 'DELETE' });
}

const before = await run('1) Fictional facts, NO notes', FICTIONAL, 'fict', true);

const note = await api('/api/questions/custom-knowledge', {
  method: 'POST',
  body: JSON.stringify({ topic: 'KB eval', content: NOTE }),
});

// Not forceFresh: the step-1 answers are in the cache. They must NOT be reused now.
const withNote = await run('2) Same questions WITH notes (cache must not serve stale answers)', FICTIONAL, 'fict', false);
const general = await run('3) General questions while notes are active', GENERAL, 'gen', true);

await api(`/api/questions/custom-knowledge/${note.id}`, { method: 'DELETE' });
const after = await run('4) Notes deleted again (cache must not serve note-based answers)', FICTIONAL.slice(0, 4), 'fict', false);

const pass =
  withNote.correct === FICTIONAL.length &&
  withNote.cached === 0 &&
  general.correct === GENERAL.length &&
  after.cached === 0;

console.log(`\nWithout notes: ${before.correct}/${FICTIONAL.length}  |  With notes: ${withNote.correct}/${FICTIONAL.length}  |  General: ${general.correct}/${GENERAL.length}`);
console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(pass ? 0 : 1);
