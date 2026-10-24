const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const tick = () => new Promise(resolve => setImmediate(resolve));
const input = (id = 'req_1', client = 'tab_1') => ({requestId:id,clientSessionId:client,mapSessionId:'map_1',baseRevision:0,prompt:'本',selectedNodeId:null,map:{version:1,title:'map',root:'root',seq:0,nodes:{root:{id:'root',text:'中心',parent:null,x:0,y:0,order:0}}}});
const plan = {status:'ok',message:'',operations:[{type:'add_node',clientId:'new_1',parentId:'root',text:'本'}]};
class Fake extends EventEmitter {
  constructor() { super(); this.calls=[]; this.cwd='/tmp/map'; this.threadConfig={}; this.n=0; }
  async status() { return {available:true}; }
  async rpc(method, params) {
    this.calls.push({method,params});
    if (this.override) { const value = this.override(method, params); if (value !== undefined) return value; }
    if (method==='model/list') return {data:[{model:'available-model',isDefault:true}]};
    if (method==='thread/start') return {thread:{id:'thread_'+(++this.n)}};
    if (method==='turn/start') return {turn:{id:'turn_'+this.calls.filter(c=>c.method==='turn/start').length}};
    if (method==='turn/interrupt') queueMicrotask(()=>this.emit('notification','turn/completed',{threadId:params.threadId,turn:{id:params.turnId,status:'interrupted'}}));
    return {};
  }
  result(run, status = 'completed', text = JSON.stringify(plan)) {
    this.emit('notification','item/completed',{threadId:run.threadId,turnId:run.turnId,item:{id:'message',type:'agentMessage',phase:'final_answer',text}});
    this.emit('notification','turn/completed',{threadId:run.threadId,turn:{id:run.turnId,status}});
  }
}
async function setup(t, options = {}) {
  const { InstructionService } = await import('../server/instruction-service.mjs'); const client = new Fake(); const service = new InstructionService(client,options); t.after(()=>service.close()); return {client,service};
}
test('every request starts a new isolated thread with exact current snapshot and outputSchema; only turn completion releases a result', async t => {
  const {client,service}=await setup(t); const first=service.submit(input()); await tick();
  assert.equal(first.state,'thinking'); assert.throws(()=>service.submit(input('req_other')),/既に実行中/);
  const turn=client.calls.find(c=>c.method==='turn/start');
  assert.deepEqual(JSON.parse(turn.params.input[0].text),{prompt:'本',selectedNodeId:null,map:input().map}); assert.ok(turn.params.outputSchema);
  const thread=client.calls.find(c=>c.method==='thread/start').params;
  assert.equal(thread.approvalPolicy,'never'); assert.equal(thread.sandbox,'read-only'); assert.equal(thread.ephemeral,true);
  client.emit('notification','item/completed',{threadId:first.threadId,turnId:first.turnId,item:{id:'x',type:'agentMessage',text:JSON.stringify(plan)}});
  assert.equal(first.state,'thinking');
  client.result(first); await tick(); assert.equal(first.state,'result'); assert.deepEqual(first.payload.proposal,plan);
  const second=service.submit(input('req_2')); await tick(); assert.notEqual(second.threadId,first.threadId);
  assert.equal(client.calls.filter(c=>/resume|fork|steer/.test(c.method)).length,0);
  assert.ok(client.calls.find(c=>c.method==='thread/unsubscribe'&&c.params.threadId===first.threadId));
});
test('duplicate POST is idempotent; other clients are independent; ownership is checked', async t=>{
  const {client,service}=await setup(t); const run=service.submit(input()); assert.equal(service.submit(input()),run);
  assert.throws(()=>service.submit({...input(),prompt:'変更'}),/重複/); assert.throws(()=>service.get('req_1','tab_2'),/見つかりません/);
  service.submit(input('req_2','tab_2')); await tick(); assert.equal(client.calls.filter(c=>c.method==='turn/start').length,2);
});
const question = {status:'needs_input',message:'どちらのノードですか？',operations:[]};
function answer(run, overrides = {}) {
  return {questionId:run.payload.questionId,answerId:'answer_1',answer:'図書館の方',mapSessionId:run.input.mapSessionId,baseRevision:run.input.baseRevision,...overrides};
}
test('questions retain the thread, replay over SSE, and accept multiple answer turns exactly once', async t=>{
  const {client,service}=await setup(t); const run=service.submit(input()); await tick();
  const threadId=run.threadId, oldTurnId=run.turnId;
  client.result(run,'completed',JSON.stringify(question));
  assert.equal(run.state,'awaiting_input'); assert.equal(run.done,false); assert.equal(service.clients.get('tab_1'),run);
  const questionId=run.payload.questionId;
  client.result(run,'completed',JSON.stringify(question)); assert.equal(run.payload.questionId,questionId);
  assert.equal(client.calls.filter(c=>c.method==='thread/unsubscribe').length,0);
  const events=[]; const off=service.subscribe(run,e=>events.push(e)); assert.equal(events[0].message,question.message);
  const first=answer(run); service.answer(run,first); service.answer(run,first); await tick();
  assert.equal(client.calls.filter(c=>c.method==='turn/start').length,2); assert.notEqual(run.turnId,oldTurnId);
  const secondTurn=client.calls.filter(c=>c.method==='turn/start')[1];
  assert.equal(secondTurn.params.threadId,threadId); assert.ok(secondTurn.params.outputSchema);
  assert.deepEqual(JSON.parse(secondTurn.params.input[0].text),{questionId:first.questionId,answerId:'answer_1',answer:'図書館の方'});
  client.emit('notification','turn/completed',{threadId,turn:{id:oldTurnId,status:'completed',items:[{id:'late',type:'agentMessage',text:JSON.stringify(plan)}]}});
  assert.equal(run.state,'thinking');
  client.result(run,'completed',JSON.stringify({...question,message:'削除範囲は？'}));
  assert.notEqual(run.payload.questionId,first.questionId);
  assert.throws(()=>service.answer(run,{...first,answerId:'stale'}),/回答できません/);
  service.answer(run,first); assert.equal(run.state,'awaiting_input');
  assert.throws(()=>service.answer(run,{...first,answer:'変更'}),/重複/);
  assert.throws(()=>service.answer(run,answer(run,{baseRevision:1})),/マップが変わって/);
  assert.throws(()=>service.answer(run,answer(run,{answer:' '})),/形式/);
  service.answer(run,answer(run,{answerId:'answer_2',answer:'子孫も含めて'})); await tick();
  client.result(run); await tick();
  assert.equal(run.state,'result'); assert.equal(client.calls.filter(c=>c.method==='thread/start').length,1);
  assert.equal(client.calls.filter(c=>c.method==='thread/unsubscribe').length,1); off();
});
test('answer wait has a separate timeout and cancellation releases an idle thread without interrupt', async t=>{
  const {client,service}=await setup(t,{executionTimeout:30,inputTimeout:150,grace:1000}); const run=service.submit(input()); await tick();
  client.result(run,'completed',JSON.stringify(question));
  await new Promise(r=>setTimeout(r,50)); assert.equal(run.state,'awaiting_input');
  const lateAnswer=answer(run); service.cancel(run); await tick(); assert.equal(run.state,'cancelled');
  assert.equal(client.calls.filter(c=>c.method==='turn/interrupt').length,0);
  assert.equal(client.calls.filter(c=>c.method==='thread/unsubscribe').length,1);
  assert.throws(()=>service.answer(run,lateAnswer),/回答できません/);
  const timed=await setup(t,{inputTimeout:15,grace:1000}); const expired=timed.service.submit(input()); await tick();
  timed.client.result(expired,'completed',JSON.stringify(question));
  await new Promise(r=>setTimeout(r,30)); assert.equal(expired.state,'failed'); assert.match(expired.payload.message,/回答待ち/);
});
test('cancel while thread or turn IDs are pending interrupts late turns and releases subscriptions', async t=>{
  for (const stage of ['thread/start','turn/start']) {
    const {client,service}=await setup(t); let release; client.override = method => method===stage ? new Promise(resolve=>{release=resolve;}) : undefined;
    const run=service.submit(input()); await tick(); service.cancel(run);
    release(stage==='thread/start'?{thread:{id:'late_thread'}}:{turn:{id:'late_turn'}}); await tick(); await tick();
    assert.equal(run.state,'cancelled');
    if(stage==='turn/start') assert.ok(client.calls.find(c=>c.method==='turn/interrupt'&&c.params.turnId==='late_turn'));
    else assert.equal(client.calls.filter(c=>c.method==='turn/start').length,0);
    assert.ok(client.calls.find(c=>c.method==='thread/unsubscribe'));
    client.result(run); assert.equal(run.state,'cancelled');
  }
});
test('early notifications before turn/start response are correlated by turn ID', async t=>{
  const {client,service}=await setup(t);
  client.override = (method,params)=>{
    if(method==='turn/start') {
      client.emit('notification','item/completed',{threadId:params.threadId,turnId:'early',item:{id:'m',type:'agentMessage',text:JSON.stringify(plan)}});
      client.emit('notification','turn/completed',{threadId:params.threadId,turn:{id:'wrong',status:'completed'}});
      client.emit('notification','turn/completed',{threadId:params.threadId,turn:{id:'early',status:'completed'}});
      return {turn:{id:'early'}};
    }
  };
  const run=service.submit(input()); await tick(); assert.equal(run.state,'result');
});
test('failed completion and invalid JSON never produce an operation result', async t=>{
  for (const [status,text] of [['failed',JSON.stringify(plan)],['completed','bad JSON'],['completed',JSON.stringify({...plan,operations:[{type:'shell'}]})]]) {
    const {client,service}=await setup(t); const run=service.submit(input()); await tick(); client.result(run,status,text); assert.equal(run.state,'failed');
  }
});
test('SSE subscriptions replay latest result and reconnect inside grace; no subscribers and execution timeouts cancel', async t=>{
  const {client,service}=await setup(t,{grace:30,executionTimeout:1000}); const run=service.submit(input()); const events=[];
  const off=service.subscribe(run,e=>events.push(e)); await tick(); off(); const off2=service.subscribe(run,e=>events.push(e));
  client.result(run); off2(); const replay=[]; service.subscribe(run,e=>replay.push(e)); assert.equal(replay[0].state,'result'); await tick();
  const abandoned=service.submit(input('req_2')); await new Promise(r=>setTimeout(r,50)); assert.equal(abandoned.state,'cancelled');
  const timed=await setup(t,{grace:1000,executionTimeout:20}); const timeoutRun=timed.service.submit(input()); await new Promise(r=>setTimeout(r,40)); assert.equal(timeoutRun.state,'failed');
});
test('process failure fails active runs and frees client slots', async t=>{
  const {client,service}=await setup(t); const run=service.submit(input()); await tick(); client.emit('failure',new Error('stopped')); assert.equal(run.state,'failed'); assert.equal(service.clients.size,0);
});
test('stdio client waits for initialization and rejects server-initiated requests', async t=>{
  const {CodexClient}=await import('../server/codex-client.mjs'); const proc=new EventEmitter(); proc.stdin=new PassThrough(); proc.stdout=new PassThrough(); proc.stderr=new PassThrough(); proc.kill=()=>{proc.killed=true;};
  const sent=[]; let buffer=''; proc.stdin.on('data', chunk=>{ buffer+=chunk; let i; while((i=buffer.indexOf('\n'))>=0){const msg=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);sent.push(msg);
    if(msg.id && msg.method) {const result=msg.method==='config/read'?{config:{mcp_servers:{external:{}}}}:msg.method==='skills/list'?{data:[{skills:[{path:'/tmp/skill'}]}]}:{}; queueMicrotask(()=>proc.stdout.write(JSON.stringify({id:msg.id,result})+'\n'));}
  }});
  const c=new CodexClient({spawnProcess:()=>proc,checkVersion:false}); t.after(()=>c.close()); await c.start();
  assert.equal(sent[0].method,'initialize'); assert.equal(sent[1].method,'initialized'); assert.equal(c.threadConfig['mcp_servers.external.enabled'],false); assert.equal(c.threadConfig['skills.config'][0].enabled,false);
  c.receive({id:999,method:'item/commandExecution/requestApproval',params:{}}); assert.equal(proc.killed,true); assert.equal(c.available,false); assert.equal(sent.at(-1).error.code,-32601);
});
test('HTTP relay serves only the UI and validates bodies and client ownership', async t=>{
  const {client,service}=await setup(t); const {createRelay}=await import('../server/index.mjs'); const {server}=createRelay(client,service);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>{server.closeAllConnections();server.close();}); const base='http://127.0.0.1:'+server.address().port;
  const ui=await fetch(base+'/'); assert.equal(ui.status,200); assert.match(await ui.text(),/promptInput/);
  assert.equal((await fetch(base+'/server/codex-client.mjs')).status,404);
  assert.equal((await fetch(base+'/api/instructions',{method:'POST',body:'{'})).status,400);
  assert.equal((await fetch(base+'/api/instructions',{method:'POST',body:JSON.stringify({...input(),selectedNodeId:'missing'})})).status,400);
  assert.equal((await fetch(base+'/api/instructions',{method:'POST',body:'x'.repeat(1024*1024+1)})).status,413);
  const post=await fetch(base+'/api/instructions',{method:'POST',body:JSON.stringify(input())}); assert.equal(post.status,202);
  const run=service.get('req_1','tab_1'); client.result(run,'completed',JSON.stringify(question));
  const reply=answer(run);
  assert.equal((await fetch(base+'/api/instructions/req_1/answer?clientSessionId=wrong',{method:'POST',body:JSON.stringify(reply)})).status,404);
  assert.equal((await fetch(base+'/api/instructions/req_1/answer?clientSessionId=tab_1',{method:'POST',body:JSON.stringify(reply)})).status,202);
  assert.equal((await fetch(base+'/api/instructions/req_1/answer?clientSessionId=tab_1',{method:'POST',body:JSON.stringify(reply)})).status,202);
  assert.equal(client.calls.filter(c=>c.method==='turn/start').length,2);
  assert.equal((await fetch(base+'/api/instructions/req_1/cancel?clientSessionId=wrong',{method:'POST'})).status,404);
  assert.equal((await fetch(base+'/api/instructions/req_1/cancel?clientSessionId=tab_1',{method:'POST'})).status,200);
});
