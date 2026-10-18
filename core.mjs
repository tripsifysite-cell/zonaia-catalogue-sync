import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'

export const tables = {
  ias: { table: 'ias', max: 50000, fields: 'id,name,slug,primary_category,price,license,short_description,long_description,url,screenshot_imgbb_url,logo_imgbb_url,screenshot_url,logo_url,created_at,updated_at' },
  prompts: { table: 'prompts', max: 30000, fields: 'id,title,slug,prompt,ai_model,category,image_url,source_url,license,type,created_at,updated_at' },
  blog: { table: 'blog_posts', max: 500, fields: 'id,title,slug,category,excerpt,article_html,image_imgbb_url,image_url,source_url,created_at,updated_at' },
}
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export const metadataFields={ias:['price','license'],prompts:['license']}
export function mergeMetadata(rows,extra,fields){const map=new Map(extra.map(r=>[id(r.id),r]));if(map.size!==rows.length||extra.length!==rows.length)throw Error('METADATA_COVERAGE');return rows.map(row=>{const r=map.get(id(row.id));if(!r||r.slug!==row.slug||r.updated_at!==row.updated_at)throw Error('METADATA_IDENTITY');const next={...row};for(const field of fields){if(!Object.hasOwn(r,field)||(r[field]!==null&&typeof r[field]!=='string'))throw Error('METADATA_FIELD');next[field]=r[field]}return next})}
export function id(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('Unsafe numeric identifier')
  const result = String(value)
  if (!/^[1-9][0-9]*$/.test(result)) throw Error('Invalid identifier')
  return result
}
export function validateInventory(rows, max) {
  if (!Array.isArray(rows) || !rows.length || rows.length >= max) throw Error('Empty/oversized inventory')
  let last = 0n
  for (const row of rows) {
    const next = BigInt(id(row.id))
    if (next <= last || (row.updated_at != null && !Number.isFinite(Date.parse(row.updated_at)))) throw Error('Invalid inventory ordering/date')
    last = next
  }
  return rows
}
export const fingerprint = inventory => digest(JSON.stringify(inventory))
export function mergeRows(oldRows, inventory, changes, config) {
  validateInventory(inventory, config.max)
  const wanted = new Map(inventory.map(row => [id(row.id), row.updated_at]))
  const merged = new Map()
  for (const row of oldRows) {
    const key = id(row.id)
    if (merged.has(key)) throw Error('Duplicate baseline row')
    if (wanted.has(key)) merged.set(key, row)
  }
  const seen = new Set()
  for (const row of changes) {
    const key = id(row.id)
    if (seen.has(key) || !wanted.has(key) || wanted.get(key) !== row.updated_at) throw Error('Changed row inconsistent with inventory')
    if (Object.keys(row).some(field => !config.fields.split(',').includes(field))) throw Error('Unexpected/non-public field')
    seen.add(key); merged.set(key, row)
  }
  const slugs = new Set()
  for (const [key, timestamp] of wanted) {
    const row = merged.get(key)
    if (!row || row.updated_at !== timestamp || typeof row.slug !== 'string' || !row.slug.trim() || slugs.has(row.slug)) throw Error('Missing/stale/duplicate result')
    slugs.add(row.slug)
  }
  return [...merged.values()].sort((a,b) => {
    const ta = a.created_at == null ? -Infinity : Date.parse(a.created_at)
    const tb = b.created_at == null ? -Infinity : Date.parse(b.created_at)
    if (Number.isNaN(ta) || Number.isNaN(tb)) throw Error('Invalid publication date')
    return ta !== tb ? (ta > tb ? -1 : 1) : BigInt(id(a.id)) > BigInt(id(b.id)) ? -1 : 1
  })
}
export function encodeSnapshot(data, now) {
  const snapshot = { version: 1, exportedAt: now, counts: {}, ...data }
  for (const [name, config] of Object.entries(tables)) {
    const rows = data[name]
    const inventory = rows.map(r => ({id:r.id,updated_at:r.updated_at})).sort((a,b)=>BigInt(id(a.id)) < BigInt(id(b.id)) ? -1:1)
    mergeRows([], inventory, rows, config)
    snapshot.counts[name] = rows.length
  }
  const bytes = gzipSync(JSON.stringify(snapshot))
  if (bytes.length > 100*1024*1024) throw Error('Snapshot compressed budget exceeded')
  return {snapshot,bytes}
}
export function decodeSnapshot(bytes, expected) {
  if (bytes.length > 100*1024*1024 || digest(bytes) !== expected) throw Error('Snapshot integrity failure')
  const data = JSON.parse(gunzipSync(bytes,{maxOutputLength:400*1024*1024}).toString('utf8'))
  if (data.version !== 1 || !Number.isFinite(Date.parse(data.exportedAt))) throw Error('Invalid snapshot metadata')
  for (const [name,config] of Object.entries(tables)) {
    if (!Array.isArray(data[name]) || !data[name].length || data[name].length>=config.max || data.counts?.[name]!==data[name].length) throw Error('Incomplete snapshot')
  }
  return data
}
export function validatePin(state) {
  if (state.version !== 1 || !/^v1\/[0-9]{8}-[a-f0-9]{16}\/manifest[.]json$/.test(state.manifestPath || '') || !/^[a-f0-9]{64}$/.test(state.manifestSha256 || '')) throw Error('Invalid publication pin')
  return state
}
export function checkBudget(state, now, bootstrap=false) {
  validatePin(state)
  if (state.baseline !== true && !bootstrap) throw Error('Initial baseline requires explicit manual bootstrap')
  if (state.baseline === true && bootstrap) throw Error('Bootstrap already completed; full fallback forbidden')
  const recent = (state.history || []).filter(entry => Date.parse(entry.at) > now-31*86400000)
  if (recent.length >= 5 || recent.some(e=>!Number.isFinite(e.egressBytes)) || recent.reduce((n,e)=>n+e.egressBytes,0)>1800000000) throw Error('Monthly publication budget reached')
  if (recent.some(e=>Date.parse(e.at)>now-6*86400000)) throw Error('Minimum six days between publications')
  return recent
}
