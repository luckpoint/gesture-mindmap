require('../ui-prototype/i18n.js').use('ja');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('../ui-prototype/instructions/client.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const proposal = { status: 'no_change', message: '変更はありません', operations: [] };
function setup(options = {}) {
  const calls = [],
    sources = [];
  class Events {
    constructor(url) {
      this.url = url;
      sources.push(this);
    }
    close() {
      this.closed = true;
    }
    message(data) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }
  const client = new Client({
    EventSource: Events,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (options.fetch) return options.fetch(url, init);
      return { ok: true, json: async () => ({ requestId: 'req_1' }) };
    },
    ...options,
  });
  return { client, calls, sources };
}
test('submits once, ignores duplicate late events, and closes SSE on result', async () => {
  const { client, calls, sources } = setup();
  const pending = client.run({ requestId: 'req_1', prompt: '本' });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).clientSessionId, client.clientSessionId);
  await assert.rejects(client.run({ requestId: 'req_2' }), /既に実行中/);
  sources[0].message({ requestId: 'req_1', state: 'thinking' });
  sources[0].message({ requestId: 'req_1', state: 'result', proposal });
  sources[0].message({ requestId: 'req_1', state: 'result', proposal: { wrong: true } });
  assert.deepEqual(await pending, proposal);
  assert.equal(sources[0].closed, true);
  assert.equal(client.active, null);
});
test('cancellation before POST response rejects locally and cancels again after late registration', async () => {
  let release;
  const { client, calls } = setup({
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url === '/api/instructions')
        return new Promise(resolve => {
          release = resolve;
        });
      return { ok: true };
    },
  });
  // Override records explicitly for this delayed transport.
  const pending = client.run({ requestId: 'req_1' });
  const rejected = assert.rejects(pending, /中止/);
  client.cancel();
  await rejected;
  release({ ok: true, json: async () => ({ requestId: 'req_1' }) });
  await tick();
  assert.equal(client.active, null);
  assert.equal(calls.filter(c => c.url.includes('/cancel')).length, 2);
});
test('reconnect inside grace continues the same request and failed reconnection cancels', async () => {
  const { client, calls, sources } = setup({ reconnect: 30 });
  const pending = client.run({ requestId: 'req_1' });
  await tick();
  sources[0].onerror();
  sources[0].onopen();
  sources[0].message({ requestId: 'req_1', state: 'result', proposal });
  await pending;
  assert.equal(calls.filter(c => c.url === '/api/instructions').length, 1);
  const second = setup({ reconnect: 10 });
  const p = second.client.run({ requestId: 'req_1' });
  const rejected = assert.rejects(p, /接続が切れ/);
  await tick();
  second.sources[0].onerror();
  await rejected;
  assert.equal(second.sources[0].closed, true);
  assert.ok(second.calls.some(c => c.url.includes('/cancel')));
});
test('mismatched request ID and execution timeout cannot return proposals', async () => {
  const a = setup();
  const pending = a.client.run({ requestId: 'req_1' });
  const rejected = assert.rejects(pending, /一致しません/);
  await tick();
  a.sources[0].message({ requestId: 'old_request', state: 'result', proposal });
  await rejected;
  const b = setup({ timeout: 10 });
  await assert.rejects(b.client.run({ requestId: 'req_1' }), /タイムアウト/);
  assert.equal(b.client.active, null);
});

test('question waits beyond generation timeout, replays without clearing drafts, and answers on the same run', async () => {
  const { client, calls, sources } = setup({ timeout: 25 });
  const states = [];
  const pending = client.run({ requestId: 'req_1', mapSessionId: 'map_1', baseRevision: 0 }, (state, data) =>
    states.push({ state, data }),
  );
  await tick();
  const q = { requestId: 'req_1', state: 'awaiting_input', questionId: 'question_1', message: 'どちら？' };
  sources[0].message(q);
  sources[0].message(q);
  await new Promise(r => setTimeout(r, 40));
  assert.equal(client.active.state, 'awaiting_input');
  assert.equal(states.filter(s => s.state === 'awaiting_input').length, 1);
  await client.answer('図書館');
  const sent = JSON.parse(calls.find(c => c.url.includes('/answer')).init.body);
  assert.equal(sent.questionId, 'question_1');
  assert.equal(sent.answer, '図書館');
  assert.equal(sent.baseRevision, 0);
  sources[0].message({ ...q, questionId: 'question_2', message: '範囲は？' });
  await client.answer('全部');
  assert.equal(calls.filter(c => c.url === '/api/instructions').length, 1);
  sources[0].message({ requestId: 'req_1', state: 'result', proposal });
  assert.deepEqual(await pending, proposal);
});
test('lost answer response reuses the answer ID and rejects a changed retry', async () => {
  const calls = [];
  let fail = true;
  const { client, sources } = setup({
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/answer') && fail) {
        fail = false;
        throw new Error('network');
      }
      return { ok: true, json: async () => ({ requestId: 'req_1' }) };
    },
  });
  const pending = client.run({ requestId: 'req_1' });
  await tick();
  sources[0].message({ requestId: 'req_1', state: 'awaiting_input', questionId: 'question_1', message: 'どちら？' });
  await assert.rejects(client.answer('A'), /network/);
  await assert.rejects(client.answer('B'), /同じ回答/);
  await client.answer('A');
  const answers = calls.filter(c => c.url.includes('/answer'));
  assert.equal(answers.length, 2);
  assert.equal(answers[0].init.body, answers[1].init.body);
  sources[0].message({ requestId: 'req_1', state: 'result', proposal });
  await pending;
});
test('next question arriving before answer acknowledgement stays answerable', async () => {
  let release;
  const { client, sources } = setup({
    fetch: async url =>
      url.includes('/answer')
        ? new Promise(r => {
            release = r;
          })
        : { ok: true, json: async () => ({ requestId: 'req_1' }) },
  });
  const pending = client.run({ requestId: 'req_1' });
  await tick();
  sources[0].message({ requestId: 'req_1', state: 'awaiting_input', questionId: 'question_1', message: 'どちら？' });
  const answering = client.answer('A');
  await assert.rejects(client.answer('A'), /回答待ち/);
  sources[0].message({ requestId: 'req_1', state: 'thinking' });
  sources[0].message({ requestId: 'req_1', state: 'awaiting_input', questionId: 'question_2', message: '範囲は？' });
  release({ ok: true, json: async () => ({ requestId: 'req_1' }) });
  await answering;
  assert.equal(client.active.state, 'awaiting_input');
  assert.equal(client.active.questionId, 'question_2');
  assert.equal(client.active.submission, null);
  const rejected = assert.rejects(pending, /中止/);
  client.cancel();
  await rejected;
  assert.equal(sources[0].closed, true);
});
