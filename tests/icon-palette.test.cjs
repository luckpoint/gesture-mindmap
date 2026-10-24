const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../ui-prototype/icons/catalog.js');
const { matches, device, Application } = require('../ui-prototype/icons/palette.js');
const i18n = require('../ui-prototype/i18n.js');
test('144 original PNGs have ordered stable IDs, bilingual names and matching dimensions', () => {
  assert.equal(new Set(catalog.map(i => i.id)).size, 144);
  for (const category of ['people', 'daily']) {
    const icons = catalog.filter(i => i.category === category); assert.equal(icons.length, 72);
    icons.forEach((icon, i) => {
      const n = String(i + 1).padStart(2, '0'); assert.equal(icon.id, `${category}-${n}`);
      assert.equal(icon.path, `icons/${category}/${n}.png`);
      for (const lang of ['ja','en']) assert.ok(i18n.messages[lang][icon.nameKey]);
      const bytes = fs.readFileSync(path.join(__dirname, '../ui-prototype', icon.path));
      assert.equal(bytes.readUInt32BE(16), icon.width); assert.equal(bytes.readUInt32BE(20), icon.height);
    });
  }
  const rice = catalog.find(i => i.id === 'daily-07');
  assert.ok(matches(rice, 'ご飯', i18n.messages)); assert.ok(matches(rice, 'RICE', i18n.messages));
  assert.ok(!matches(rice, 'パン', i18n.messages));
});
test('Apple desktop iPad and screen orientation ignore keyboard viewport changes; portrait PCs remain available', () => {
  const env = { navigator: { userAgent:'Macintosh', platform:'MacIntel', maxTouchPoints:5 }, screen:{ width:768,height:1024,orientation:{type:'portrait-primary'}}, innerWidth:1000,innerHeight:400 };
  assert.equal(device(env).available, false);
  env.screen.orientation.type = 'landscape-primary'; assert.deepEqual(device(env), {available:true,phone:false});
  env.navigator={userAgent:'iPhone',maxTouchPoints:5}; env.screen={width:844,height:390};
  assert.deepEqual(device(env), {available:true,phone:true});
  env.navigator={userAgent:'Macintosh',maxTouchPoints:0};env.screen={width:600,height:900};
  assert.equal(device(env).available, true);
});
const deferred = () => { let resolve; return {promise:new Promise(r => {resolve=r;}), resolve:v=>resolve(v)}; };
function fixture() {
  let selection='a', revision=1, editable=true, committed=0, failures=[];
  const fetched=deferred(), saved=deferred();
  const io = {
    allowed:()=>editable, capture:child=>({selection,revision,child}), current:t=>t.selection===selection&&t.revision===revision,
    fetch:()=>fetched.promise, name:()=> '家', failure:()=> 'failed', update(){}, error:m=>failures.push(m),
    attach:async(blob,t,alt)=> {await saved.promise; if(t.valid()){committed++;assert.equal(alt,'家');}},
  };
  const runner=new Application(io);
  return {runner,io,fetched,saved,failures,committed:()=>committed, select:()=>selection='b', edit:()=>revision++, lock:()=>editable=false};
}
const response={ok:true,blob:async()=>new Blob(['png'],{type:'image/png'})};
test('a double tap commits only once and preserves original PNG bytes', async()=> {
  const f=fixture();let bytes;
  const attach=f.io.attach; f.io.attach=(blob,...args)=>{bytes=blob;return attach(blob,...args);};
  const first=f.runner.apply(catalog[0],true); assert.equal(await f.runner.apply(catalog[0],true),false);
  f.fetched.resolve(response);f.saved.resolve();assert.equal(await first,true);assert.equal(f.committed(),1);assert.equal(await bytes.text(),'png');assert.equal(f.runner.pending,false);
});
test('selection/revision/access changes and cancellation prevent late commits after fetch or storage',async()=> {
  for(const timing of ['fetch','storage']) for(const action of ['select','edit','lock','cancel']) {
    const f=fixture(), result=f.runner.apply(catalog[0],true);
    if(timing==='storage') {f.fetched.resolve(response);await new Promise(r=>setImmediate(r));}
    action==='cancel'?f.runner.cancel():f[action]();
    f.fetched.resolve(response);f.saved.resolve();await result;assert.equal(f.committed(),0,`${timing} ${action}`);assert.equal(f.runner.pending,false);
  }
});
test('fetch and storage failures reset busy state and permit retry without a commit',async()=> {
  for(const storage of [false,true]) {
    const f=fixture(); if(storage)f.io.attach=async()=>{throw Error('quota');};
    const result=f.runner.apply(catalog[0],false);f.fetched.resolve(storage?response:{ok:false});
    assert.equal(await result,false);assert.equal(f.committed(),0);assert.equal(f.runner.pending,false);assert.equal(f.failures.length,1);
  }
});
