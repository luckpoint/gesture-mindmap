require('../ui-prototype/i18n.js').use('ja');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const tick = () => new Promise(resolve => setImmediate(resolve));
const input = (id = 'req_1', client = 'tab_1') => ({
  requestId: id,
  clientSessionId: client,
  mapSessionId: 'map_1',
  baseRevision: 0,
  prompt: '本',
  selectedNodeId: null,
  map: {
    version: 1,
    title: 'map',
    root: 'root',
    seq: 0,
    nodes: { root: { id: 'root', text: '中心', parent: null, x: 0, y: 0, order: 0 } },
  },
});
const plan = {
  status: 'ok',
  message: '',
  operations: [{ type: 'add_node', clientId: 'new_1', parentId: 'root', text: '本' }],
};
class Fake extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.cwd = '/tmp/map';
    this.threadConfig = {};
    this.n = 0;
  }
  async status() {
    return { available: true };
  }
  async rpc(method, params) {
    this.calls.push({ method, params });
    if (this.override) {
      const value = this.override(method, params);
      if (value !== undefined) return value;
    }
    if (method === 'model/list') return { data: [{ model: 'available-model', isDefault: true }] };
    if (method === 'thread/start') return { thread: { id: 'thread_' + ++this.n } };
    if (method === 'turn/start')
      return { turn: { id: 'turn_' + this.calls.filter(c => c.method === 'turn/start').length } };
    if (method === 'turn/interrupt')
      queueMicrotask(() =>
        this.emit('notification', 'turn/completed', {
          threadId: params.threadId,
          turn: { id: params.turnId, status: 'interrupted' },
        }),
      );
    return {};
  }
  result(run, status = 'completed', text = JSON.stringify(plan)) {
    this.emit('notification', 'item/completed', {
      threadId: run.threadId,
      turnId: run.turnId,
      item: { id: 'message', type: 'agentMessage', phase: 'final_answer', text },
    });
    this.emit('notification', 'turn/completed', { threadId: run.threadId, turn: { id: run.turnId, status } });
  }
}
async function setup(t, options = {}) {
  const { InstructionService } = await import('../server/instruction-service.mjs');
  const client = new Fake();
  const service = new InstructionService(client, options);
  t.after(() => service.close());
  return { client, service };
}
test('every request starts a new isolated thread with exact current snapshot and outputSchema; only turn completion releases a result', async t => {
  const { client, service } = await setup(t);
  const first = service.submit(input());
  await tick();
  assert.equal(first.state, 'thinking');
  assert.throws(() => service.submit(input('req_other')), /既に実行中/);
  const turn = client.calls.find(c => c.method === 'turn/start');
  assert.deepEqual(JSON.parse(turn.params.input[0].text), { prompt: '本', selectedNodeId: null, map: input().map });
  assert.ok(turn.params.outputSchema);
  const thread = client.calls.find(c => c.method === 'thread/start').params;
  assert.equal(thread.approvalPolicy, 'never');
  assert.equal(thread.sandbox, 'read-only');
  assert.equal(thread.ephemeral, true);
  client.emit('notification', 'item/completed', {
    threadId: first.threadId,
    turnId: first.turnId,
    item: { id: 'x', type: 'agentMessage', text: JSON.stringify(plan) },
  });
  assert.equal(first.state, 'thinking');
  client.result(first);
  await tick();
  assert.equal(first.state, 'result');
  assert.deepEqual(first.payload.proposal, plan);
  const second = service.submit(input('req_2'));
  await tick();
  assert.notEqual(second.threadId, first.threadId);
  assert.equal(client.calls.filter(c => /resume|fork|steer/.test(c.method)).length, 0);
  assert.ok(client.calls.find(c => c.method === 'thread/unsubscribe' && c.params.threadId === first.threadId));
});
test('duplicate POST is idempotent; other clients are independent; ownership is checked', async t => {
  const { client, service } = await setup(t);
  const run = service.submit(input());
  assert.equal(service.submit(input()), run);
  assert.throws(() => service.submit({ ...input(), prompt: '変更' }), /重複/);
  assert.throws(() => service.get('req_1', 'tab_2'), /見つかりません/);
  service.submit(input('req_2', 'tab_2'));
  await tick();
  assert.equal(client.calls.filter(c => c.method === 'turn/start').length, 2);
});
const question = { status: 'needs_input', message: 'どちらのノードですか？', operations: [] };
function answer(run, overrides = {}) {
  return {
    questionId: run.payload.questionId,
    answerId: 'answer_1',
    answer: '図書館の方',
    mapSessionId: run.input.mapSessionId,
    baseRevision: run.input.baseRevision,
    ...overrides,
  };
}
test('questions retain the thread, replay over SSE, and accept multiple answer turns exactly once', async t => {
  const { client, service } = await setup(t);
  const run = service.submit(input());
  await tick();
  const threadId = run.threadId,
    oldTurnId = run.turnId;
  client.result(run, 'completed', JSON.stringify(question));
  assert.equal(run.state, 'awaiting_input');
  assert.equal(run.done, false);
  assert.equal(service.clients.get('tab_1'), run);
  const questionId = run.payload.questionId;
  client.result(run, 'completed', JSON.stringify(question));
  assert.equal(run.payload.questionId, questionId);
  assert.equal(client.calls.filter(c => c.method === 'thread/unsubscribe').length, 0);
  const events = [];
  const off = service.subscribe(run, e => events.push(e));
  assert.equal(events[0].message, question.message);
  const first = answer(run);
  service.answer(run, first);
  service.answer(run, first);
  await tick();
  assert.equal(client.calls.filter(c => c.method === 'turn/start').length, 2);
  assert.notEqual(run.turnId, oldTurnId);
  const secondTurn = client.calls.filter(c => c.method === 'turn/start')[1];
  assert.equal(secondTurn.params.threadId, threadId);
  assert.ok(secondTurn.params.outputSchema);
  assert.deepEqual(JSON.parse(secondTurn.params.input[0].text), {
    questionId: first.questionId,
    answerId: 'answer_1',
    answer: '図書館の方',
  });
  client.emit('notification', 'turn/completed', {
    threadId,
    turn: {
      id: oldTurnId,
      status: 'completed',
      items: [{ id: 'late', type: 'agentMessage', text: JSON.stringify(plan) }],
    },
  });
  assert.equal(run.state, 'thinking');
  client.result(run, 'completed', JSON.stringify({ ...question, message: '削除範囲は？' }));
  assert.notEqual(run.payload.questionId, first.questionId);
  assert.throws(() => service.answer(run, { ...first, answerId: 'stale' }), /回答できません/);
  service.answer(run, first);
  assert.equal(run.state, 'awaiting_input');
  assert.throws(() => service.answer(run, { ...first, answer: '変更' }), /重複/);
  assert.throws(() => service.answer(run, answer(run, { baseRevision: 1 })), /マップが変わって/);
  assert.throws(() => service.answer(run, answer(run, { answer: ' ' })), /形式/);
  service.answer(run, answer(run, { answerId: 'answer_2', answer: '子孫も含めて' }));
  await tick();
  client.result(run);
  await tick();
  assert.equal(run.state, 'result');
  assert.equal(client.calls.filter(c => c.method === 'thread/start').length, 1);
  assert.equal(client.calls.filter(c => c.method === 'thread/unsubscribe').length, 1);
  off();
});
test('answer wait has a separate timeout and cancellation releases an idle thread without interrupt', async t => {
  const { client, service } = await setup(t, { executionTimeout: 30, inputTimeout: 150, grace: 1000 });
  const run = service.submit(input());
  await tick();
  client.result(run, 'completed', JSON.stringify(question));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(run.state, 'awaiting_input');
  const lateAnswer = answer(run);
  service.cancel(run);
  await tick();
  assert.equal(run.state, 'cancelled');
  assert.equal(client.calls.filter(c => c.method === 'turn/interrupt').length, 0);
  assert.equal(client.calls.filter(c => c.method === 'thread/unsubscribe').length, 1);
  assert.throws(() => service.answer(run, lateAnswer), /回答できません/);
  const timed = await setup(t, { inputTimeout: 15, grace: 1000 });
  const expired = timed.service.submit(input());
  await tick();
  timed.client.result(expired, 'completed', JSON.stringify(question));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(expired.state, 'failed');
  assert.match(expired.payload.message, /回答待ち/);
});
test('cancel while thread or turn IDs are pending interrupts late turns and releases subscriptions', async t => {
  for (const stage of ['thread/start', 'turn/start']) {
    const { client, service } = await setup(t);
    let release;
    client.override = method =>
      method === stage
        ? new Promise(resolve => {
            release = resolve;
          })
        : undefined;
    const run = service.submit(input());
    await tick();
    service.cancel(run);
    release(stage === 'thread/start' ? { thread: { id: 'late_thread' } } : { turn: { id: 'late_turn' } });
    await tick();
    await tick();
    assert.equal(run.state, 'cancelled');
    if (stage === 'turn/start')
      assert.ok(client.calls.find(c => c.method === 'turn/interrupt' && c.params.turnId === 'late_turn'));
    else assert.equal(client.calls.filter(c => c.method === 'turn/start').length, 0);
    assert.ok(client.calls.find(c => c.method === 'thread/unsubscribe'));
    client.result(run);
    assert.equal(run.state, 'cancelled');
  }
});
test('early notifications before turn/start response are correlated by turn ID', async t => {
  const { client, service } = await setup(t);
  client.override = (method, params) => {
    if (method === 'turn/start') {
      client.emit('notification', 'item/completed', {
        threadId: params.threadId,
        turnId: 'early',
        item: { id: 'm', type: 'agentMessage', text: JSON.stringify(plan) },
      });
      client.emit('notification', 'turn/completed', {
        threadId: params.threadId,
        turn: { id: 'wrong', status: 'completed' },
      });
      client.emit('notification', 'turn/completed', {
        threadId: params.threadId,
        turn: { id: 'early', status: 'completed' },
      });
      return { turn: { id: 'early' } };
    }
  };
  const run = service.submit(input());
  await tick();
  assert.equal(run.state, 'result');
});
test('failed completion and invalid JSON never produce an operation result', async t => {
  for (const [status, text] of [
    ['failed', JSON.stringify(plan)],
    ['completed', 'bad JSON'],
    ['completed', JSON.stringify({ ...plan, operations: [{ type: 'shell' }] })],
  ]) {
    const { client, service } = await setup(t);
    const run = service.submit(input());
    await tick();
    client.result(run, status, text);
    assert.equal(run.state, 'failed');
  }
});
test('SSE subscriptions replay latest result and reconnect inside grace; no subscribers and execution timeouts cancel', async t => {
  const { client, service } = await setup(t, { grace: 30, executionTimeout: 1000 });
  const run = service.submit(input());
  const events = [];
  const off = service.subscribe(run, e => events.push(e));
  await tick();
  off();
  const off2 = service.subscribe(run, e => events.push(e));
  client.result(run);
  off2();
  const replay = [];
  service.subscribe(run, e => replay.push(e));
  assert.equal(replay[0].state, 'result');
  await tick();
  const abandoned = service.submit(input('req_2'));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(abandoned.state, 'cancelled');
  const timed = await setup(t, { grace: 1000, executionTimeout: 20 });
  const timeoutRun = timed.service.submit(input());
  await new Promise(r => setTimeout(r, 40));
  assert.equal(timeoutRun.state, 'failed');
});
test('process failure fails active runs and frees client slots', async t => {
  const { client, service } = await setup(t);
  const run = service.submit(input());
  await tick();
  client.emit('failure', new Error('stopped'));
  assert.equal(run.state, 'failed');
  assert.equal(service.clients.size, 0);
});
function fakeCodexProcess() {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = () => {
    proc.killed = true;
  };
  const sent = [];
  let buffer = '';
  proc.stdin.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      sent.push(msg);
      if (msg.id && msg.method) {
        const result =
          msg.method === 'config/read'
            ? { config: { mcp_servers: { external: {} } } }
            : msg.method === 'skills/list'
              ? { data: [{ skills: [{ path: '/tmp/skill' }] }] }
              : {};
        queueMicrotask(() => proc.stdout.write(JSON.stringify({ id: msg.id, result }) + '\n'));
      }
    }
  });
  return { proc, sent };
}
test('stdio client waits for initialization and rejects server-initiated requests', async t => {
  const { CodexClient } = await import('../server/codex-client.mjs');
  const { proc, sent } = fakeCodexProcess();
  const c = new CodexClient({ spawnProcess: () => proc, checkVersion: false });
  t.after(() => c.close());
  await c.start();
  assert.equal(sent[0].method, 'initialize');
  assert.equal(sent[1].method, 'initialized');
  assert.equal(c.threadConfig['mcp_servers.external.enabled'], false);
  assert.equal(c.threadConfig['skills.config'][0].enabled, false);
  c.receive({ id: 999, method: 'item/commandExecution/requestApproval', params: {} });
  assert.equal(proc.killed, true);
  assert.equal(c.available, false);
  assert.equal(sent.at(-1).error.code, -32601);
});
test('notifications without a thread ID never reach runs still waiting for a thread', async t => {
  const { client, service } = await setup(t);
  client.override = method => (method === 'thread/start' ? new Promise(() => {}) : undefined);
  const run = service.submit(input());
  await tick();
  client.emit('notification', 'account/updated', undefined);
  client.emit('notification', 'account/updated', {});
  assert.equal(run.state, 'thinking');
});
test('stdio client survives notification listener errors but stops on invalid JSON', async t => {
  const { CodexClient } = await import('../server/codex-client.mjs');
  const { proc } = fakeCodexProcess();
  const c = new CodexClient({ spawnProcess: () => proc, checkVersion: false });
  t.after(() => c.close());
  await c.start();
  c.on('notification', () => {
    throw new Error('listener bug');
  });
  t.mock.method(console, 'error', () => {});
  proc.stdout.write(JSON.stringify({ method: 'account/updated' }) + '\n');
  await tick();
  assert.equal(c.available, true);
  assert.equal(proc.killed, undefined);
  proc.stdout.write('not json\n');
  await tick();
  assert.equal(c.available, false);
  assert.equal(proc.killed, true);
});
test('HTTP relay serves only the UI and validates bodies and client ownership', async t => {
  const { client, service } = await setup(t);
  const { createRelay } = await import('../server/index.mjs');
  const { server } = createRelay(client, service, { instructions: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const bootstrap = await fetch(base + '/features.js');
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const relayFetch = (url, init = {}) =>
    fetch(url, {
      ...init,
      headers: { Cookie: cookie, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
  const config = await relayFetch(base + '/features.js');
  assert.match(await config.text(), /instructions: true/);
  assert.equal((await relayFetch(base + '/api/codex/status')).status, 200);
  const ui = await relayFetch(base + '/');
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /promptInput/);
  assert.equal((await relayFetch(base + '/server/codex-client.mjs')).status, 404);
  assert.equal((await relayFetch(base + '/api/instructions', { method: 'POST', body: '{' })).status, 400);
  assert.equal(
    (
      await relayFetch(base + '/api/instructions', {
        method: 'POST',
        body: JSON.stringify({ ...input(), selectedNodeId: 'missing' }),
      })
    ).status,
    400,
  );
  assert.equal(
    (await relayFetch(base + '/api/instructions', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })).status,
    413,
  );
  const post = await relayFetch(base + '/api/instructions', { method: 'POST', body: JSON.stringify(input()) });
  assert.equal(post.status, 202);
  const run = service.get('req_1', 'tab_1');
  client.result(run, 'completed', JSON.stringify(question));
  const reply = answer(run);
  assert.equal(
    (
      await relayFetch(base + '/api/instructions/req_1/answer?clientSessionId=wrong', {
        method: 'POST',
        body: JSON.stringify(reply),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await relayFetch(base + '/api/instructions/req_1/answer?clientSessionId=tab_1', {
        method: 'POST',
        body: JSON.stringify(reply),
      })
    ).status,
    202,
  );
  assert.equal(
    (
      await relayFetch(base + '/api/instructions/req_1/answer?clientSessionId=tab_1', {
        method: 'POST',
        body: JSON.stringify(reply),
      })
    ).status,
    202,
  );
  assert.equal(client.calls.filter(c => c.method === 'turn/start').length, 2);
  assert.equal(
    (await relayFetch(base + '/api/instructions/req_1/cancel?clientSessionId=wrong', { method: 'POST' })).status,
    404,
  );
  assert.equal(
    (await relayFetch(base + '/api/instructions/req_1/cancel?clientSessionId=tab_1', { method: 'POST' })).status,
    200,
  );
});

test('image profile enables only image generation and RPC diagnostics never retain upstream secret text', async t => {
  const { CodexClient, restrictedConfig } = await import('../server/codex-client.mjs');
  assert.equal(restrictedConfig['features.image_generation'], false);
  const c = new CodexClient({ profile: 'images', checkVersion: false });
  t.after(() => c.close());
  const { 'features.image_generation': flag, ...rest } = c.config;
  assert.equal(flag, true);
  const { 'features.image_generation': unused, ...original } = restrictedConfig;
  assert.deepEqual(rest, original);
  c.proc = { stdin: { write() {} }, kill() {} };
  const pending = c.rpc('config/read', {});
  c.receive({ id: 1, error: { code: -32603, message: 'secret-value', data: { token: 'secret-value' } } });
  await assert.rejects(
    pending,
    error =>
      error.message === 'RPC_ERROR' &&
      error.method === 'config/read' &&
      error.rpcCode === -32603 &&
      !JSON.stringify(error).includes('secret'),
  );
  assert.throws(() => new CodexClient({ profile: 'unrestricted' }), /INVALID_PROFILE/);
});

test('disabled relay serves OFF configuration and rejects every instruction API without a client or service', async t => {
  const { createRelay } = await import('../server/index.mjs');
  const { server, service } = createRelay();
  assert.equal(service, null);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const config = await fetch(base + '/features.js');
  assert.equal(config.headers.get('cache-control'), 'no-store');
  assert.match(await config.text(), /instructions: false/);
  for (const [path, method] of [
    ['/api/codex/status', 'GET'],
    ['/api/instructions', 'POST'],
    ['/api/instructions/req_1/events', 'GET'],
    ['/api/instructions/req_1/cancel', 'POST'],
    ['/api/instructions/req_1/answer', 'POST'],
  ]) {
    assert.equal((await fetch(base + path, { method })).status, 404);
  }
  assert.equal((await fetch(base + '/')).status, 200);
});

test('relay serves the landing page at /landing with a CTA back to the app', async t => {
  const { createRelay } = await import('../server/index.mjs');
  const { server } = createRelay();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const page = await fetch(base + '/landing');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /<a class="cta" href="\/"/);
  const { messages } = require('../ui-prototype/i18n.js');
  const keys = [...html.matchAll(/data-i18n-src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(keys.length);
  for (const src of Object.values(messages).flatMap(m => keys.map(k => m[k]))) {
    const image = await fetch(base + '/' + src);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/webp');
  }
});

test('relay serves the legal pages linked from the landing footer', async t => {
  const { createRelay } = await import('../server/index.mjs');
  const { server } = createRelay();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const { messages } = require('../ui-prototype/i18n.js');
  for (const href of Object.values(messages).flatMap(m => [m['landing.termsHref'], m['landing.privacyHref']])) {
    const page = await fetch(base + href);
    assert.equal(page.status, 200, href);
    assert.match(await page.text(), /© 2026 Luckpoint Factory/);
  }
});

test('relay rejects foreign origins, rebinding hosts, missing/stale authentication and non-JSON requests before generation', async t => {
  const { client, service } = await setup(t);
  const { createRelay } = await import('../server/index.mjs');
  const { server } = createRelay(client, service, { instructions: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const boot = await fetch(base + '/features.js');
  const setCookie = boot.headers.get('set-cookie'),
    cookie = setCookie.split(';')[0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/api\//);
  assert.equal(boot.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(base + '/api/codex/status')).status, 401);
  const post = (headers = {}) => {
    const opts = { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers } };
    if (headers.Host)
      return new Promise((resolve, reject) => {
        const req = require('node:http').request(base + '/api/instructions', opts, res => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode }));
        });
        req.on('error', reject);
        req.end(JSON.stringify(input()));
      });
    return fetch(base + '/api/instructions', { ...opts, body: JSON.stringify(input()) });
  };
  for (const headers of [
    { Origin: 'https://attacker.invalid' },
    { Origin: 'null' },
    { Host: 'attacker.invalid' },
    { Host: 'localhost.attacker.invalid:' + server.address().port },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
  ])
    assert.equal((await post(headers)).status, 403, JSON.stringify(headers));
  assert.equal((await post({ Cookie: cookie.replace(/=.+/, '=wrong') })).status, 401);
  assert.equal((await post({ 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({ 'Content-Type': '' })).status, 415);
  assert.equal((await fetch(base + '/features.js', { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  const deniedSSE = await fetch(base + '/api/instructions/req_1/events?clientSessionId=tab_1');
  assert.equal(deniedSSE.status, 401);
  assert.equal(client.calls.length, 0);
  assert.equal((await post({ Origin: base, 'Sec-Fetch-Site': 'same-origin' })).status, 202);
  await tick();
  assert.equal(client.calls.filter(c => c.method === 'turn/start').length, 1);
  const run = service.get('req_1', 'tab_1');
  client.result(run);
  const stream = await fetch(base + '/api/instructions/req_1/events?clientSessionId=tab_1', {
    headers: { Cookie: cookie },
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"state":"result"/);
  await reader.cancel();
  // A separate relay must not accept the previous relay's startup token, even under its own cookie name.
  const other = createRelay(client, service, { instructions: true }).server;
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    other.closeAllConnections();
    other.close();
  });
  const otherBase = 'http://127.0.0.1:' + other.address().port;
  const otherBoot = await fetch(otherBase + '/features.js');
  const otherName = otherBoot.headers.get('set-cookie').split('=')[0];
  assert.equal(
    (await fetch(otherBase + '/api/codex/status', { headers: { Cookie: otherName + '=' + cookie.split('=')[1] } }))
      .status,
    401,
  );
});

test('global admission limits cannot be bypassed by inventing client IDs or replaying submissions', async t => {
  const { client, service } = await setup(t, { maxConcurrent: 2, startsPerMinute: 3, maxRuns: 10 });
  const first = service.submit(input());
  const second = service.submit(input('req_2', 'tab_2'));
  await tick();
  assert.equal(service.submit(input()), first);
  assert.throws(
    () => service.submit(input('req_3', 'tab_3')),
    e => e.status === 429,
  );
  client.result(first);
  await tick();
  const third = service.submit(input('req_3', 'tab_3'));
  await tick();
  client.result(second);
  client.result(third);
  await tick();
  assert.throws(
    () => service.submit(input('req_4', 'tab_4')),
    e => e.status === 429,
  );
  assert.equal(service.starts.length, 3);
  const retained = await setup(t, { maxRuns: 1 });
  const run = retained.service.submit(input());
  await tick();
  retained.client.result(run);
  await tick();
  assert.throws(
    () => retained.service.submit(input('req_2', 'tab_2')),
    e => e.status === 429,
  );
});
