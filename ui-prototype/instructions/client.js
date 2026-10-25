(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../i18n.js') : root.I18n);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InstructionTransport = api;
})(globalThis, I18n => {
  'use strict';
  const tr = I18n.t;
  const id = prefix =>
    prefix + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
  class Client {
    constructor({
      fetch: fetcher = globalThis.fetch?.bind(globalThis),
      EventSource: Events = globalThis.EventSource,
      timeout = 120000,
      reconnect = 5000,
    } = {}) {
      Object.assign(this, { fetcher, Events, timeout, reconnect });
      this.clientSessionId = id('tab_');
      this.applied = new Set();
    }
    async status() {
      const r = await this.fetcher('/api/codex/status', { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(tr('instruction.connectFailed'));
      return r.json();
    }
    path(input, action) {
      return `/api/instructions/${encodeURIComponent(input.requestId)}/${action}?clientSessionId=${encodeURIComponent(this.clientSessionId)}`;
    }
    stopRemote(input, keepalive = false) {
      return this.fetcher(this.path(input, 'cancel'), { method: 'POST', keepalive }).catch(() => {});
    }
    cancel() {
      if (this.active) this.active.finish(new Error(tr('instruction.cancelled')), true);
    }
    async answer(answer) {
      const run = this.active;
      if (!run || run.state !== 'awaiting_input' || run.answering) throw new Error(tr('instruction.noQuestion'));
      const questionId = run.questionId;
      const submission = run.submission || {
        questionId,
        answerId: id('answer_'),
        answer,
        mapSessionId: run.input.mapSessionId,
        baseRevision: run.input.baseRevision,
      };
      if (submission.answer !== answer) throw new Error(tr('instruction.unconfirmed'));
      run.submission = submission;
      run.answering = true;
      try {
        const response = await this.fetcher(this.path(run.input, 'answer'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(submission),
          signal: AbortSignal.timeout(15000),
        });
        const accepted = await response.json();
        if (!response.ok) {
          if (response.status < 500) run.submission = null;
          throw new Error(accepted.message || tr('instruction.answerFailed'));
        }
        if (accepted.requestId !== run.input.requestId) throw new Error(tr('instruction.idMismatch'));
        // SSE may already have delivered the next question or final result.
        if (!run.done && run.state === 'awaiting_input' && run.questionId === questionId) {
          run.state = 'thinking';
          run.armTimer();
          run.onState('thinking');
        }
      } finally {
        run.answering = false;
      }
    }
    run(input, onState = () => {}) {
      if (this.active) return Promise.reject(new Error(tr('instruction.busy')));
      input = { ...input, clientSessionId: this.clientSessionId };
      return new Promise((resolve, reject) => {
        const run = { input, source: null, done: false, state: 'thinking', onState };
        const finish = (error, stop = false, proposal) => {
          if (run.done) return;
          run.done = true;
          clearTimeout(run.timer);
          clearTimeout(run.reconnectTimer);
          run.source?.close();
          if (this.active === run) this.active = null;
          if (stop) void this.stopRemote(input, true);
          error ? reject(error) : resolve(proposal);
        };
        run.finish = finish;
        this.active = run;
        run.armTimer = () => {
          clearTimeout(run.timer);
          run.timer = setTimeout(() => finish(new Error(tr('instruction.timeout')), true), this.timeout);
        };
        run.armTimer();
        onState('submitting');
        (async () => {
          try {
            const response = await this.fetcher('/api/instructions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(input),
              signal: AbortSignal.timeout(15000),
            });
            if (run.done) {
              void this.stopRemote(input, true);
              return;
            }
            const accepted = await response.json();
            if (!response.ok) throw new Error(accepted.message || tr('instruction.connectFailed'));
            if (accepted.requestId !== input.requestId) throw new Error(tr('instruction.idMismatch'));
            if (run.done) {
              void this.stopRemote(input, true);
              return;
            }
            onState('thinking');
            const source = (run.source = new this.Events(this.path(input, 'events')));
            source.onopen = () => {
              clearTimeout(run.reconnectTimer);
              run.reconnectTimer = null;
            };
            source.onerror = () => {
              if (run.done || run.reconnectTimer) return;
              run.reconnectTimer = setTimeout(
                () => finish(new Error(tr('instruction.disconnected')), true),
                this.reconnect,
              );
            };
            source.onmessage = event => {
              if (run.done) return;
              try {
                const data = JSON.parse(event.data);
                if (data.requestId !== input.requestId) throw new Error(tr('instruction.idMismatch'));
                // Receiving the latest event proves the reconnect has succeeded.
                clearTimeout(run.reconnectTimer);
                run.reconnectTimer = null;
                if (data.state === 'result') finish(null, false, data.proposal);
                else if (data.state === 'failed') finish(new Error(data.message || tr('instruction.failed')));
                else if (data.state === 'cancelled') finish(new Error(tr('instruction.cancelled')));
                else if (data.state === 'awaiting_input') {
                  if (
                    typeof data.questionId !== 'string' ||
                    !data.questionId ||
                    typeof data.message !== 'string' ||
                    !data.message.trim()
                  )
                    throw new Error(tr('instruction.badQuestion'));
                  clearTimeout(run.timer);
                  const changed = run.questionId !== data.questionId;
                  run.state = 'awaiting_input';
                  run.questionId = data.questionId;
                  if (changed) {
                    run.submission = null;
                    onState('awaiting_input', data);
                  }
                } else if (data.state === 'thinking') {
                  if (run.state !== 'thinking') {
                    run.state = 'thinking';
                    run.armTimer();
                    onState('thinking');
                  }
                } else throw new Error(tr('instruction.badState'));
              } catch (error) {
                finish(error, true);
              }
            };
          } catch (error) {
            if (!run.done)
              finish(new Error(error.name === 'TimeoutError' ? tr('instruction.connectTimeout') : error.message), true);
          }
        })();
      });
    }
  }
  return { Client, id };
});
