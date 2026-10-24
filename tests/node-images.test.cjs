const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../ui-prototype/images/format.js');
const Ops = require('../ui-prototype/instructions/operations.js');
const { verify } = require('../ui-prototype/images/store.js');
const id = 'sha256:' + 'a'.repeat(64);
const ref = {assetId:id,alt:'画像',width:1,height:1};
const map = () => ({version:2,title:'map',root:'root',seq:0,nodes:{root:{id:'root',text:'中心',parent:null,x:0,y:0,order:0}}});
const png = new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')], {type:'image/png'});
test('v1 migrates without mutating its source; unknown versions and v1 image refs are rejected', () => {
  const old=map(); old.version=1;
  assert.equal(F.migrate(old).version,2); assert.equal(old.version,1);
  old.nodes.root.image=ref; assert.equal(Ops.valid(old),false);
  for(const version of [0,3,'2']) assert.equal(Ops.valid({...map(),version}),false);
});
test('references reject invalid IDs, alt, dimensions, and embedded image bytes', () => {
  for(const change of [{assetId:'https://example.test/x.png'},{assetId:'sha256:a'},{alt:4},{alt:'x'.repeat(4001)},{width:0},{height:4097},{width:1.1},{data:'x'}]) {
    const m=map();m.nodes.root.image={...ref,...change};assert.equal(Ops.valid(m),false,JSON.stringify(change));
  }
});
test('ordinary operations preserve references without sending image bytes and account for image size in placement', () => {
  const m=map();m.nodes.root.image=ref;
  const p=Ops.prepare(m,{status:'ok',message:'',operations:[{type:'update_node',nodeId:'root',text:'新しい文字'},{type:'add_node',clientId:'new',parentId:'root',text:'子'}]});
  assert.deepEqual(p.map.nodes.root.image,ref); assert.equal(Object.values(p.map.nodes).find(n=>n.parent).image,undefined);
  assert.equal(JSON.stringify(Ops.serialize(p.map)).includes('base64'),false);
});
test('bundles deduplicate referenced assets, and import verifies all images before writing', async () => {
  const m=map();m.nodes.root.image=ref;m.seq=1;m.nodes.child={...m.nodes.root,id:'child',parent:'root',order:1};
  const calls=[];
  const store={get:async()=>({blob:png,mime:'image/png'}),verify:async(blob,expected)=>{calls.push(expected);return {...expected,blob};},putMany:async a=>calls.push(a)};
  const bundle=await F.exportBundle(m,store);assert.equal(Object.keys(bundle.assets).length,1);
  const restored=await F.importBundle(bundle,store);assert.deepEqual(restored,m);assert.equal(calls.at(-1).length,1);
  await assert.rejects(F.exportBundle(m,{get:async()=>null}),/読み込めません/);
  await assert.rejects(F.importBundle(m,store),/bundle/);
});
test('malformed bundles, missing/extra assets and mismatched metadata never write', async () => {
  const m=map();m.nodes.root.image=ref;
  const good={format:'mindmap-bundle',version:1,map:m,assets:{[id]:{mime:'image/png',width:1,height:1,data:'AAAA'}}};
  let writes=0;const store={verify:async()=>{throw Error('bad hash');},putMany:async()=>writes++};
  for(const modify of [b=>b.version=2,b=>delete b.assets[id],b=>b.assets.extra={},b=>b.assets[id].mime='image/svg+xml',b=>b.assets[id].width=2,b=>b.assets[id].data='!!!!',b=>{}]) {
    const b=structuredClone(good);modify(b);await assert.rejects(F.importBundle(b,store));assert.equal(writes,0);
  }
});
test('raster validation rejects fake MIME, invalid bytes and oversized PNG before decoding', async () => {
  await assert.rejects(verify(new Blob(['<svg/>'],{type:'image/png'})),/PNG/);
  await assert.rejects(verify(new Blob([png],{type:'image/jpeg'})),/MIME/);
  const bytes=new Uint8Array(await png.arrayBuffer());new DataView(bytes.buffer).setUint32(16,4097);
  await assert.rejects(verify(new Blob([bytes],{type:'image/png'})),/4096/);
  await assert.rejects(verify(new Blob([new Uint8Array(F.MAX_IMAGE+1)],{type:'image/png'})),/10MiB/);
});

test('maximum-size base64 imports without overflowing the JS regexp stack', async () => {
  const m=map();m.nodes.root.image=ref;
  const data=Buffer.alloc(F.MAX_IMAGE).toString('base64');let bytes=0;
  const store={verify:async(blob,ref)=>{bytes=blob.size;return {...ref,blob};},putMany:async()=>{}};
  await F.importBundle({format:'mindmap-bundle',version:1,map:m,assets:{[id]:{mime:'image/png',width:1,height:1,data}}},store);
  assert.equal(bytes,F.MAX_IMAGE);
});
test('browser decoder result and actual SHA-256, not supplied metadata, determine stored identity', async t => {
  const old=global.createImageBitmap;global.createImageBitmap=async()=>({width:1,height:1,close(){}});t.after(()=>{global.createImageBitmap=old;});
  const a=await verify(png);assert.match(a.assetId,/^sha256:[a-f0-9]{64}$/);
  await assert.rejects(verify(png,{assetId:id}),/ハッシュ/);
  await assert.rejects(verify(png,{width:2}),/寸法/);
  global.createImageBitmap=async()=>({width:4097,height:1,close(){}});
  await assert.rejects(verify(png),/4096/);
  global.createImageBitmap=async()=>{throw Error('corrupt');};await assert.rejects(verify(png),/デコード/);
});
test('URL cache shares one URL and revokes it after the last DOM reference, including pending loads', async t => {
  const {Store}=require('../ui-prototype/images/store.js');
  const old=global.createImageBitmap;global.createImageBitmap=async()=>({width:1,height:1,close(){}});t.after(()=>{global.createImageBitmap=old;});
  const a=await verify(png),store=new Store();store.get=async()=>a;
  const [one,two]=await Promise.all([store.acquire(a.assetId),store.acquire(a.assetId)]);
  assert.equal(one,two);store.release(a.assetId);assert.equal(store.urls.size,1);store.release(a.assetId);assert.equal(store.urls.size,0);
  const pending=store.acquire(a.assetId);store.release(a.assetId);await pending;assert.equal(store.urls.size,0);
  store.get=async()=>null;await assert.rejects(store.acquire(a.assetId),/読み込めません/);store.release(a.assetId);
});
