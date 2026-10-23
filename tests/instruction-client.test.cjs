const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('../ui-prototype/instructions/client.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const proposal = {status:'no_change',message:'変更はありません',operations:[]};
function setup(options = {}) {
  const calls = [], sources = [];
  class Events {
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.closed = true; }
    message(data) { this.onmessage({data:JSON.stringify(data)}); }
  }
  const client = new Client({EventSource:Events,fetch:async (url,init) => {
    calls.push({url,init});
    if(options.fetch) return options.fetch(url,init);
    return {ok:true,json:async()=>({requestId:'req_1'})};
  }, ...options});
  return {client,calls,sources};
}
test('submits once, ignores duplicate late events, and closes SSE on result', async()=>{
  const {client,calls,sources}=setup(); const pending=client.run({requestId:'req_1',prompt:'本'}); await tick();
  assert.equal(calls.length,1); assert.equal(JSON.parse(calls[0].init.body).clientSessionId,client.clientSessionId);
  await assert.rejects(client.run({requestId:'req_2'}),/既に実行中/);
  sources[0].message({requestId:'req_1',state:'thinking'});
  sources[0].message({requestId:'req_1',state:'result',proposal});
  sources[0].message({requestId:'req_1',state:'result',proposal:{wrong:true}});
  assert.deepEqual(await pending,proposal); assert.equal(sources[0].closed,true); assert.equal(client.active,null);
});
test('cancellation before POST response rejects locally and cancels again after late registration',async()=>{
  let release; const {client,calls}=setup({fetch:async(url,init)=>{
    calls.push({url,init});
    if(url==='/api/instructions') return new Promise(resolve=>{release=resolve;});
    return {ok:true};
  }});
  // Override records explicitly for this delayed transport.
  const pending=client.run({requestId:'req_1'}); const rejected=assert.rejects(pending,/中止/);
  client.cancel(); await rejected;
  release({ok:true,json:async()=>({requestId:'req_1'})}); await tick();
  assert.equal(client.active,null); assert.equal(calls.filter(c=>c.url.includes('/cancel')).length,2);
});
test('reconnect inside grace continues the same request and failed reconnection cancels',async()=>{
  const {client,calls,sources}=setup({reconnect:30}); const pending=client.run({requestId:'req_1'}); await tick();
  sources[0].onerror(); sources[0].onopen(); sources[0].message({requestId:'req_1',state:'result',proposal}); await pending;
  assert.equal(calls.filter(c=>c.url==='/api/instructions').length,1);
  const second=setup({reconnect:10}); const p=second.client.run({requestId:'req_1'}); const rejected=assert.rejects(p,/接続が切れ/); await tick(); second.sources[0].onerror(); await rejected;
  assert.equal(second.sources[0].closed,true); assert.ok(second.calls.some(c=>c.url.includes('/cancel')));
});
test('mismatched request ID and execution timeout cannot return proposals',async()=>{
  const a=setup(); const pending=a.client.run({requestId:'req_1'}); const rejected=assert.rejects(pending,/一致しません/); await tick();
  a.sources[0].message({requestId:'old_request',state:'result',proposal}); await rejected;
  const b=setup({timeout:10}); await assert.rejects(b.client.run({requestId:'req_1'}),/タイムアウト/); assert.equal(b.client.active,null);
});
