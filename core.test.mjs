import {test} from 'node:test'
import assert from 'node:assert/strict'
import {tables,id,mergeRows,encodeSnapshot,decodeSnapshot,digest,checkBudget} from './core.mjs'
const row=(id,updated_at='2026-10-16T00:00:00Z')=>({id,slug:'item-'+id,created_at:null,updated_at})
test('merge adds, edits, deletes and preserves publication order',()=>{
  const a=row(1),b=row(2),c=row(3)
  const result=mergeRows([a,b],[{id:2,updated_at:b.updated_at},{id:3,updated_at:c.updated_at}],[c],tables.ias)
  assert.deepEqual(result.map(r=>r.id),[3,2])
  const edited={...b,updated_at:'2026-10-17T00:00:00Z'}
  assert.equal(mergeRows([b],[{id:2,updated_at:edited.updated_at}],[edited],tables.ias)[0].updated_at,edited.updated_at)
})
test('stale, duplicate, unexpected data and unsafe identifiers fail closed',()=>{
  assert.throws(()=>id(9007199254740992),/Unsafe/)
  for(const rows of [[row(2)], [{...row(1),private_field:'never'}]]) assert.throws(()=>mergeRows([],[row(1)],rows,tables.ias))
  assert.throws(()=>mergeRows([row(1)],[{...row(1),updated_at:'2026-10-17T00:00:00Z'}],[],tables.ias),/stale/)
  assert.throws(()=>mergeRows([],[row(1),row(1)],[row(1)],tables.ias),/ordering/)
})
test('snapshot validates all tables and rejects corruption',()=>{
  const {bytes}=encodeSnapshot({ias:[row(1)],prompts:[row(2)],blog:[row(3)]},'2026-10-16T00:00:00Z')
  assert.equal(decodeSnapshot(bytes,digest(bytes)).counts.ias,1)
  assert.throws(()=>decodeSnapshot(bytes,'0'.repeat(64)),/integrity/)
  assert.throws(()=>encodeSnapshot({ias:[],prompts:[row(2)],blog:[row(3)]},new Date().toISOString()))
})
test('manual-only bootstrap and conservative publication budgets',()=>{
  const state={version:1,manifestPath:'v1/20261015-1234567890abcdef/manifest.json',manifestSha256:'0'.repeat(64),baseline:false,history:[]}
  assert.throws(()=>checkBudget(state,Date.now()),/bootstrap/)
  assert.deepEqual(checkBudget(state,Date.now(),true),[])
  assert.throws(()=>checkBudget({...state,baseline:true},Date.now(),true),/already/)
  assert.throws(()=>checkBudget({...state,baseline:true,history:[{at:new Date().toISOString(),egressBytes:1}]},Date.now()),/six days/)
  assert.throws(()=>checkBudget({...state,manifestPath:'../../secret'},Date.now(),true),/pin/)
})
