/* One short utterance; targets own their drafts and persistence. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SpeechInput = api;
})(globalThis, () => {
  'use strict';
  class Controller {
    constructor({ Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition,
      change = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
      Object.assign(this, { Recognition, change, setTimer, clearTimer });
      this.state = 'idle'; this.session = null;
    }
    get supported() { return typeof this.Recognition === 'function'; }
    get active() { return !!this.session; }
    valid(s) {
      if (this.session !== s) return false;
      if (!s.target.valid()) { this.abort(); return false; }
      return true;
    }
    transition(state) { this.state = state; this.change(state); }
    deadline(s, ms, error) {
      this.clearTimer(this.timer);
      this.timer = this.setTimer(() => { if (this.valid(s)) this.close(s, error, true); }, ms);
    }
    start(target) {
      if (!this.supported || this.active || !target.valid()) return false;
      const s = { target, base: target.read(), results: [], error: null, recognition: null };
      this.session = s;
      this.transition('starting');
      try {
        const r = s.recognition = new this.Recognition();
        Object.assign(r, { lang: 'ja-JP', continuous: false, interimResults: true, maxAlternatives: 1 });
        r.onstart = () => { if (this.valid(s) && this.state === 'starting') { this.transition('listening'); this.deadline(s, 60000, 'timeout'); } };
        r.onresult = e => {
          if (!this.valid(s) || s.error) return;
          s.results.length = e.results.length;
          for (let i = e.resultIndex; i < e.results.length; i++) {
            s.results[i] = { text: e.results[i][0].transcript, final: e.results[i].isFinal };
          }
          const final = s.results.filter(r => r?.final).map(r => r.text).join('');
          const interim = s.results.filter(r => r && !r.final).map(r => r.text).join('');
          target.write(s.base + final, interim);
        };
        r.onerror = e => { if (this.valid(s)) this.close(s, e.error || 'unknown', true); };
        r.onnomatch = () => { if (this.valid(s)) this.close(s, 'no-speech', true); };
        r.onend = () => { if (this.valid(s)) this.close(s, s.results.some(r => r?.final && r.text.trim()) ? null : 'no-speech'); };
        this.deadline(s, 15000, 'timeout');
        r.start();
      } catch { if (this.session === s) this.close(s, 'start-failed', true); }
      return true;
    }
    stop() {
      const s = this.session;
      if (!s || this.state === 'stopping' || !this.valid(s)) return;
      this.transition('stopping'); this.deadline(s, 5000, 'timeout');
      try { s.recognition.stop(); } catch { this.close(s, 'unknown', true); }
    }
    close(s, error, abort = false) {
      if (this.session !== s) return;
      this.session = null; this.clearTimer(this.timer);
      if (abort) { try { s.recognition?.abort(); } catch {} }
      this.transition('idle');
      if (s.target.valid()) s.target.end(error);
    }
    abort() {
      const s = this.session;
      if (!s) return;
      this.session = null; this.clearTimer(this.timer);
      try { s.recognition?.abort(); } catch {}
      this.transition('idle');
    }
  }
  return { Controller };
});
