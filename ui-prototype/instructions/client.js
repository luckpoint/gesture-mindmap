(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InstructionTransport = api;
})(globalThis, () => {
  'use strict';
  const id = prefix => prefix + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
  class Client {
    constructor({ fetch: fetcher = globalThis.fetch?.bind(globalThis), EventSource: Events = globalThis.EventSource, timeout = 120000, reconnect = 5000 } = {}) {
      Object.assign(this, { fetcher, Events, timeout, reconnect }); this.clientSessionId = id('tab_'); this.applied = new Set();
    }
    async status() {
      const r = await this.fetcher('/api/codex/status', { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('Codexに接続できませんでした'); return r.json();
    }
    path(input, action) { return `/api/instructions/${encodeURIComponent(input.requestId)}/${action}?clientSessionId=${encodeURIComponent(this.clientSessionId)}`; }
    stopRemote(input, keepalive = false) { return this.fetcher(this.path(input, 'cancel'), { method: 'POST', keepalive }).catch(() => {}); }
    cancel() { if (this.active) this.active.finish(new Error('中止しました'), true); }
    run(input, onState = () => {}) {
      if (this.active) return Promise.reject(new Error('既に実行中です'));
      input = { ...input, clientSessionId: this.clientSessionId };
      return new Promise((resolve, reject) => {
        const run = { input, source: null, done: false };
        const finish = (error, stop = false, proposal) => {
          if (run.done) return; run.done = true;
          clearTimeout(run.timer); clearTimeout(run.reconnectTimer); run.source?.close();
          if (this.active === run) this.active = null;
          if (stop) void this.stopRemote(input, true);
          error ? reject(error) : resolve(proposal);
        };
        run.finish = finish; this.active = run;
        run.timer = setTimeout(() => finish(new Error('Codexの応答がタイムアウトしました'), true), this.timeout);
        onState('submitting');
        (async () => {
          try {
            const response = await this.fetcher('/api/instructions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(15000) });
            if (run.done) { void this.stopRemote(input, true); return; }
            const accepted = await response.json();
            if (!response.ok) throw new Error(accepted.message || 'Codexに接続できませんでした');
            if (accepted.requestId !== input.requestId) throw new Error('実行IDが一致しません');
            if (run.done) { void this.stopRemote(input, true); return; }
            onState('thinking');
            const source = run.source = new this.Events(this.path(input, 'events'));
            source.onopen = () => { clearTimeout(run.reconnectTimer); run.reconnectTimer = null; };
            source.onerror = () => {
              if (run.done || run.reconnectTimer) return;
              run.reconnectTimer = setTimeout(() => finish(new Error('Codexとの接続が切れました。もう一度送信してください'), true), this.reconnect);
            };
            source.onmessage = event => {
              if (run.done) return;
              try {
                const data = JSON.parse(event.data);
                if (data.requestId !== input.requestId) throw new Error('実行IDが一致しません');
                // Receiving the latest event proves the reconnect has succeeded.
                clearTimeout(run.reconnectTimer); run.reconnectTimer = null;
                if (data.state === 'result') finish(null, false, data.proposal);
                else if (data.state === 'failed') finish(new Error(data.message || 'Codexの指示処理に失敗しました'));
                else if (data.state === 'cancelled') finish(new Error('中止しました'));
                else if (data.state !== 'thinking') throw new Error('実行状態の形式が正しくありません');
              } catch (error) { finish(error, true); }
            };
          } catch (error) { if (!run.done) finish(new Error(error.name === 'TimeoutError' ? 'Codexへの接続がタイムアウトしました' : error.message), true); }
        })();
      });
    }
  }
  return { Client, id };
});
