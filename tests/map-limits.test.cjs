require('../ui-prototype/i18n.js').use('ja');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const F=require('../ui-prototype/images/format.js');
function fixture(count=1, chain=false) {
  const m={version:2,title:'map',root:'n0',seq:count,nodes:{}};
  for(let i=0;i<count;i++) m.nodes['n'+i]={id:'n'+i,text:'node',parent:i?(chain?'n'+(i-1):'n0'):null,x:0,y:0,order:i};
  return m;
}
test('import accepts exactly 2048 nodes and rejects excess before writing any assets',async()=>{
  assert.equal(F.MAX_NODES,2048);
  const m=fixture(2048);assert.equal(Object.keys((await F.importBundle(m,{})).nodes).length,2048);
  let writes=0;const store={putMany:async()=>writes++};
  await assert.rejects(F.importBundle(fixture(2049),store),/2,048/);assert.equal(writes,0);
  const over=fixture(2049);
  await assert.rejects(F.importBundle({format:'mindmap-bundle',version:1,map:over,assets:{}},store),/2,048/);
  assert.equal(writes,0);
});
test('depth limit is independent of node insertion order and cycles remain invalid',()=>{
  const m=fixture(65,true);assert.equal(F.validMap(m),true);
  m.nodes=Object.fromEntries(Object.entries(m.nodes).reverse());assert.equal(F.validMap(m),true);
  assert.match(F.mapError(fixture(66,true)),/64/);
  m.nodes.n1.parent='n64';assert.equal(F.validMap(m),false);
});
test('node, title and total text limits include image alt text',()=>{
  const m=fixture();m.nodes.n0.text='x'.repeat(4000);assert.equal(F.validMap(m),true);
  m.nodes.n0.text+='x';assert.match(F.mapError(m),/4,000/);
  m.nodes.n0.text='node';m.title='x'.repeat(1000);assert.equal(F.validMap(m),true);
  m.title+='x';assert.match(F.mapError(m),/1,000/);
  const many=fixture(66);many.title='';for(const n of Object.values(many.nodes))n.text='x'.repeat(4000);
  assert.match(F.mapError(many),/262,144/);
  many.nodes.n65.text='x'.repeat(2144);assert.equal(F.validMap(many),true);
  many.nodes.n0.image={assetId:'sha256:'+'a'.repeat(64),alt:'x',width:1,height:1};
  assert.match(F.mapError(many),/262,144/);
});
