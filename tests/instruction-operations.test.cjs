require('../ui-prototype/i18n.js').use('ja');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const O = require('../ui-prototype/instructions/operations.js');
const map = () => ({ version: 1, title: 'map', root: 'root', seq: 3, nodes: {
  root: {id:'root', text:'中心', parent:null, x:0,y:0,order:0},
  a: {id:'a',text:'枝',parent:'root',x:300,y:0,order:1},
  b: {id:'b',text:'子',parent:'a',x:500,y:0,order:2},
  c: {id:'c',text:'別の枝',parent:'root',x:-300,y:0,order:3},
} });
const proposal = operations => ({status:'ok',message:'',operations});
test('copy preparation maps temporary IDs in order and never mutates the original', () => {
  const m = map(), original = JSON.stringify(m);
  const result = O.prepare(m, proposal([{type:'add_node',clientId:'new_1',parentId:'a',text:'本'}, {type:'add_node',clientId:'new_2',parentId:'new_1',text:'借りる'}]));
  assert.equal(JSON.stringify(m), original); assert.equal(O.valid(result.map), true);
  const one = Object.values(result.map.nodes).find(n => n.text === '本');
  assert.equal(result.map.nodes[result.focusId].parent, one.id); assert.equal(result.counts.added, 2);
  assert.deepEqual(O.serialize(m), m);
});
test('rejects invalid later operations atomically, forward and duplicate refs, cycles, root operations and extra fields', () => {
  const invalid = [
    [{type:'reparent_node',nodeId:'a',parentId:'b'}], [{type:'reparent_node',nodeId:'root',parentId:'a'}],
    [{type:'delete_node',nodeId:'root',scope:'single'}], [{type:'update_node',nodeId:'missing',text:'本'}],
    [{type:'update_node',nodeId:'a',text:' '}], [{type:'update_node',nodeId:'a',text:'本',x:100}],
    [{type:'add_node',clientId:'new_1',parentId:'new_2',text:'本'}], [{type:'add_node',clientId:'a',parentId:'root',text:'本'}],
    [{type:'add_node',clientId:'new_1',parentId:'root',text:'本'}, {type:'add_node',clientId:'new_1',parentId:'root',text:'本'}],
    [{type:'delete_node',nodeId:'a',scope:'subtree'}, {type:'update_node',nodeId:'b',text:'本'}],
    [{type:'add_node',clientId:'__proto__',parentId:'a',text:'本'}],
  ];
  for (const ops of invalid) {
    const m = map(), original = JSON.stringify(m);
    assert.throws(() => O.prepare(m, proposal([{type:'update_node',nodeId:'c',text:'変更'}, ...ops])));
    assert.equal(JSON.stringify(m), original);
  }
});
test('single deletion preserves descendants and coordinates, subtree deletion counts actual changes', () => {
  const m = map(); const single = O.prepare(m, proposal([{type:'delete_node',nodeId:'a',scope:'single'}]));
  assert.equal(single.map.nodes.b.parent, 'root'); assert.equal(single.map.nodes.b.x, 500); assert.equal(single.counts.deleted, 1); assert.equal(single.deletions[0].count, 1);
  const branch = O.prepare(m, proposal([{type:'delete_node',nodeId:'a',scope:'subtree'}]));
  assert.equal(branch.counts.deleted, 2); assert.equal(branch.map.nodes.b, undefined);
});
test('zero differences have no history-worthy change and summaries derive from final maps', () => {
  const m = map(); const result = O.prepare(m, proposal([{type:'update_node',nodeId:'a',text:'仮'}, {type:'update_node',nodeId:'a',text:'枝'}]));
  assert.equal(result.changed, false); assert.deepEqual(result.map, m); assert.equal(O.summary(result.counts), '変更はありません');
  assert.throws(() => O.validateProposal({status:'needs_input',message:'選んでください',operations:[{type:'delete_node',nodeId:'a',scope:'single'}]}));
  assert.throws(() => O.validateProposal(proposal(Array(101).fill({type:'update_node',nodeId:'a',text:'枝'}))));
});
test('input rejects missing selection, oversized prompt and excessive map size without truncation', () => {
  const input = {requestId:'req_1',clientSessionId:'tab_1',mapSessionId:'map_1',baseRevision:0,prompt:'本',selectedNodeId:null,map:map()};
  assert.equal(O.validateInput(input), input);
  assert.throws(() => O.validateInput({...input, selectedNodeId:'absent'}));
  assert.throws(() => O.validateInput({...input, prompt:'a'.repeat(4001)}));
  assert.throws(() => O.validateInput({...input, baseRevision:-1}));
  for (let i=0; i<500; i++) input.map.nodes['x'+i]={id:'x'+i,text:'x',parent:'root',x:0,y:0,order:0};
  assert.throws(() => O.validateInput(input)); assert.equal(Object.keys(input.map.nodes).length, 504);
});
test('swap_nodes rotates sibling subtrees around their parent and keeps order', () => {
  const m = map(), result = O.prepare(m, proposal([{type:'swap_nodes',nodeId:'a',otherId:'c'}]));
  const at = id => [result.map.nodes[id].x, result.map.nodes[id].y].map(v => v + 0);
  assert.deepEqual([at('a'), at('b'), at('c')], [[-300, 0], [-500, 0], [300, 0]]);
  assert.deepEqual([result.map.nodes.a.order, result.map.nodes.c.order], [1, 3]);
  assert.equal(O.summary(result.counts), '3個移動しました');
  for (const ops of [[{type:'swap_nodes',nodeId:'a',otherId:'b'}], [{type:'swap_nodes',nodeId:'root',otherId:'a'}], [{type:'swap_nodes',nodeId:'a',otherId:'a'}]])
    assert.throws(() => O.prepare(m, proposal(ops)));
});
