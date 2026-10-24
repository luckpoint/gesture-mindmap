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

// OPFS /images directory and the Worker writer, kept in one Map of File-like values.
function opfs(files = new Map(), now = () => Date.now()) {
  const handle = name => ({ kind: 'file', name, getFile: async () => files.get(name) });
  const directory = async () => ({
    async *values() { for (const name of [...files.keys()]) yield handle(name); },
    async getFileHandle(name) { if (!files.has(name)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' }); return handle(name); },
  });
  let writes = 0;
  const send = async ({ op, name, bytes }) => {
    if (op === 'write') { writes++; files.set(name, new File([bytes], name, { lastModified: now() })); }
    else files.delete(name);
  };
  return { files, directory, send, writes: () => writes };
}
const hex = id => id.slice(7);

test('verified writes repair corrupt existing bytes, deduplicate IDs and count replacement capacity', async t => {
  const {Store}=require('../ui-prototype/images/store.js');
  const old=global.createImageBitmap;global.createImageBitmap=async()=>({width:1,height:1,close(){}});t.after(()=>{global.createImageBitmap=old;});
  const a=await verify(png), fs=opfs(), store=new Store(fs);
  fs.files.set(hex(a.assetId), new File(['corrupt local bytes'], hex(a.assetId)));
  await assert.rejects(store.acquire(a.assetId)); store.release(a.assetId);
  await store.putMany([a,a]);
  assert.equal(fs.writes(),1);assert.equal(fs.files.size,1);
  const stored=await store.get(a.assetId);
  assert.equal(stored.blob.type,'image/png');assert.equal(stored.mime,'image/png');
  const m=map();m.nodes.root.image={assetId:a.assetId,alt:'画像',width:1,height:1};
  assert.equal((await F.exportBundle(m,store)).assets[a.assetId].mime,'image/png');assert.equal(await stored.blob.text(),await png.text());
  // Replacing oversized corruption with the verified original fits the limit.
  fs.files.set(hex(a.assetId),{size:F.MAX_TOTAL+1,lastModified:0});
  await store.putMany([a]);assert.equal(fs.writes(),2);
  // A genuinely full store still rejects the write.
  fs.files.set('b'.repeat(64),{size:F.MAX_TOTAL,lastModified:0});
  await assert.rejects(store.putMany([a]),/50MiB/);
  assert.equal(fs.writes(),2);
  assert.equal(await store.get('sha256:'+'c'.repeat(64)),undefined);
});

test('a failed Worker write is reported and adds no reference', async t => {
  const {Store}=require('../ui-prototype/images/store.js');
  const old=global.createImageBitmap;global.createImageBitmap=async()=>({width:1,height:1,close(){}});t.after(()=>{global.createImageBitmap=old;});
  const fs=opfs(), store=new Store({...fs, send:async()=>{throw new Error('quota');}});
  await assert.rejects(store.put(png),/空き容量/);
  assert.equal(fs.files.size,0);
});

test('migration from IndexedDB moves verified images and drops the old store only after every write', async t => {
  const {Store}=require('../ui-prototype/images/store.js');
  const old=global.createImageBitmap;global.createImageBitmap=async()=>({width:1,height:1,close(){}});t.after(()=>{global.createImageBitmap=old;});
  const a=await verify(png); let dropped=0;
  const legacy={records:async()=>[{...a},{assetId:id,blob:new Blob(['broken'],{type:'image/png'}),width:1,height:1}],drop:async()=>{dropped++;}};
  const failing=opfs(), failStore=new Store({...failing,send:async()=>{throw new Error('quota');}});
  await assert.rejects(failStore.migrate(legacy));
  assert.equal(dropped,0);
  const fs=opfs(), store=new Store(fs);
  assert.deepEqual(await store.migrate(legacy),{moved:1,broken:1});
  assert.equal(dropped,1);assert.deepEqual([...fs.files.keys()],[hex(a.assetId)]);
  assert.equal(await store.migrate({records:async()=>null,drop:async()=>{dropped++;}}),null);
  assert.equal(dropped,1);
});

test('GC removes only unreferenced files older than 24 hours', async () => {
  const {Store,DAY}=require('../ui-prototype/images/store.js');
  const now=10*DAY, fs=opfs(), store=new Store(fs);
  const file=age=>({size:1,lastModified:now-age});
  fs.files.set('a'.repeat(64),file(2*DAY));   // referenced
  fs.files.set('b'.repeat(64),file(DAY-1));   // recent
  fs.files.set('c'.repeat(64),file(DAY));     // orphan
  assert.equal(await store.gc(new Set(['sha256:'+'a'.repeat(64)]),now),1);
  assert.deepEqual([...fs.files.keys()].sort(),['a'.repeat(64),'b'.repeat(64)]);
});

test('uploads keep small supported files, shrink large or unsupported ones to JPEG, and name nodes from files', async t => {
  const U=require('../ui-prototype/images/upload.js');
  const old={bitmap:global.createImageBitmap,canvas:global.OffscreenCanvas};
  t.after(()=>{global.createImageBitmap=old.bitmap;global.OffscreenCanvas=old.canvas;});
  let size=[100,50],drawn;
  global.createImageBitmap=async b=>{if(b.type==='broken')throw Error();return {width:size[0],height:size[1],close(){}};};
  global.OffscreenCanvas=class{constructor(w,h){this.width=w;this.height=h;}
    getContext(){return {fillRect(){},drawImage:(b,x,y,w,h)=>{drawn=[w,h];}};}
    async convertToBlob(o){return new Blob(['j'],{type:o.type});}};
  assert.equal(await U.prepare(png),png);
  size=[4000,3000];const big=await U.prepare(png);
  assert.equal(big.type,'image/jpeg');assert.deepEqual(drawn,[2048,1536]);
  size=[10,10];assert.equal((await U.prepare(new Blob(['h'],{type:'image/heic'}))).type,'image/jpeg');assert.deepEqual(drawn,[10,10]);
  size=[10,10];assert.equal((await U.prepare(new Blob([new Uint8Array(U.KEEP_BYTES+1)],{type:'image/png'}))).type,'image/jpeg');
  await assert.rejects(U.prepare(new Blob(['x'],{type:'broken'})),/デコード/);
  await assert.rejects(U.prepare(new Blob([])),/50MiB/);
  assert.equal(U.name({name:'旅行 写真.JPG'}),'旅行 写真');assert.equal(U.name({name:'.png'}),'画像');assert.equal(U.name(new Blob([])),'画像');
});
