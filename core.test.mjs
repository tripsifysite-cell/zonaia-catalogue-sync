import {test} from 'node:test'
import assert from 'node:assert/strict'
import {tables,id,mergeRows,encodeSnapshot,decodeSnapshot,digest,checkBudget} from './core.mjs'
import {legacyPublishedSlugs} from './editorial-legacy.mjs'
const row=(id,updated_at='2026-10-16T00:00:00Z')=>({id,slug:'item-'+id,created_at:null,updated_at})
test('authorized draft stays out of serialized snapshots without removing legacy news',()=>{
  const slug='como-usar-labs-y-warn-para-automatizar-trabajo-real-con-ia'
  const legacySlug=[...legacyPublishedSlugs][0]
  const data={ias:[row(1)],prompts:[row(2)],blog:[{...row(3),slug:legacySlug},{...row(4),slug,status:'Publicado',article_html:'EDITORIAL_HOLD_TEST'}]}
  const {snapshot,bytes}=encodeSnapshot(data,'2026-10-18T21:50:00Z')
  assert.equal(snapshot.counts.blog,1)
  assert.deepEqual(snapshot.blog.map(r=>r.slug),[legacySlug])
  assert.equal(data.blog.length,2)
  const restored=decodeSnapshot(bytes,digest(bytes))
  assert.equal(JSON.stringify(restored).includes('EDITORIAL_HOLD_TEST'),false)
  assert.equal(JSON.stringify(restored).includes(slug),false)
})
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
  const {bytes}=encodeSnapshot({ias:[row(1)],prompts:[row(2)],blog:[{...row(3),status:'Publicado'}]},'2026-10-16T00:00:00Z')
  assert.equal(decodeSnapshot(bytes,digest(bytes)).counts.ias,1)
  assert.throws(()=>decodeSnapshot(bytes,'0'.repeat(64)),/integrity/)
  assert.throws(()=>encodeSnapshot({ias:[],prompts:[row(2)],blog:[row(3)]},new Date().toISOString()))
})

test('189 historical news remain while all new drafts fail closed',()=>{
  assert.equal(legacyPublishedSlugs.size,189)
  const legacy=[...legacyPublishedSlugs].map((slug,index)=>({...row(index+10),slug,status:'Borrador'}))
  const drafts=['Borrador','Revision',null,undefined,'published','Publicado ',''].map((status,index)=>({...row(index+300),status}))
  const approved={...row(400),status:'Publicado'}
  const input={ias:[row(1)],prompts:[row(2)],blog:[...legacy,...drafts,approved]}
  const {snapshot}=encodeSnapshot(input,'2026-10-19T00:00:00Z')
  assert.equal(snapshot.counts.blog,190)
  assert.ok(snapshot.blog.some(r=>r.id===400))
  assert.ok(!snapshot.blog.some(r=>r.id>=300&&r.id<400))
  assert.equal(input.blog.length,197)
})
test('manual-only bootstrap and conservative publication budgets',()=>{
  const state={version:1,manifestPath:'v1/20261015-1234567890abcdef/manifest.json',manifestSha256:'0'.repeat(64),baseline:false,history:[]}
  assert.throws(()=>checkBudget(state,Date.now()),/bootstrap/)
  assert.deepEqual(checkBudget(state,Date.now(),true),[])
  assert.throws(()=>checkBudget({...state,baseline:true},Date.now(),true),/already/)
  assert.throws(()=>checkBudget({...state,baseline:true,history:[{at:new Date().toISOString(),egressBytes:1}]},Date.now()),/six days/)
  assert.throws(()=>checkBudget({...state,manifestPath:'../../secret'},Date.now(),true),/pin/)
})
