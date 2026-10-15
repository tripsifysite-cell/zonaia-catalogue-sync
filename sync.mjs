import {tables,id,fingerprint,validateInventory,mergeRows,encodeSnapshot,decodeSnapshot,digest,checkBudget,validatePin} from './core.mjs'

const repository='tripsifysite-cell/zonaia-catalogue-sync'
const bucket='zonaia-build-snapshots'
let stage='configuration',requests=0,received=0,sourceBytes=0
const bootstrap=process.env.BOOTSTRAP==='true'
const now=new Date(),at=now.toISOString()
async function read(response,limit) {
  if(!response.ok) throw Error(`HTTP_${response.status}`)
  if(Number(response.headers.get('content-length'))>limit) throw Error('RESPONSE_LIMIT')
  const parts=[]; let size=0
  for await(const chunk of response.body){size+=chunk.length;received+=chunk.length;if(size>limit||received>650000000)throw Error('BYTE_BUDGET');parts.push(Buffer.from(chunk))}
  return Buffer.concat(parts)
}
async function request(url,options={},limit=1000000){
  if(++requests>(bootstrap?1800:500))throw Error('REQUEST_BUDGET')
  return read(await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(60000)}),limit)
}
const json=async(url,options,limit)=>JSON.parse((await request(url,options,limit)).toString('utf8'))
const ghHeaders={Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github+json','Content-Type':'application/json'}
const gh=`https://api.github.com/repos/${repository}`
const ghOptions=(method='GET',body)=>({method,headers:ghHeaders,...(body?{body:JSON.stringify(body)}:{})})
try {
  if(process.env.GITHUB_REPOSITORY!==repository||process.env.GITHUB_REF!=='refs/heads/main'||!['schedule','workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME))throw Error('UNREVIEWED_CONTEXT')
  const base=process.env.SUPABASE_URL?.replace(/\/$/,'')
  if(!/^https:\/\/[a-z]{20}[.]supabase[.]co$/.test(base||''))throw Error('SOURCE_CONFIGURATION')
  const anon=process.env.SUPABASE_ANON_KEY,email=process.env.CATALOGUE_PUBLISHER_EMAIL,password=process.env.CATALOGUE_PUBLISHER_PASSWORD
  if(!anon||!email||!password||!process.env.GH_TOKEN)throw Error('MISSING_CREDENTIALS')
  const hook=new URL(process.env.PAGES_DEPLOY_HOOK||'')
  if(hook.origin!=='https://api.cloudflare.com'||!/^\/client\/v4\/pages\/webhooks\/deploy_hooks\/[a-f0-9-]+$/.test(hook.pathname)||hook.search)throw Error('HOOK_CONFIGURATION')
  stage='state'
  const stateFile=await json(`${gh}/contents/state.json?ref=state`,ghOptions())
  const state=validatePin(JSON.parse(Buffer.from(stateFile.content,'base64').toString('utf8')))
  const history=checkBudget(state,now.getTime(),bootstrap)
  stage='authenticate'
  const session=await json(base+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:anon,'Content-Type':'application/json'},body:JSON.stringify({email,password})})
  if(!session.access_token||session.user?.app_metadata?.purpose!=='zonaia_snapshot_publisher')throw Error('PUBLISHER_IDENTITY')
  const headers={apikey:anon,Authorization:`Bearer ${session.access_token}`}
  const inventory=async()=>{
    const all={}
    for(const [name,config] of Object.entries(tables)){
      const rows=[];let after='0'
      while(true){
        const params=new URLSearchParams({select:'id,updated_at',order:'id.asc',limit:'1000',id:`gt.${after}`})
        const bytes=await request(`${base}/rest/v1/${config.table}?${params}`,{headers},1000000)
        sourceBytes+=bytes.length
        if(sourceBytes>(bootstrap?380000000:60000000))throw Error('SOURCE_BUDGET')
        const page=JSON.parse(bytes)
        if(!Array.isArray(page)||page.length>1000)throw Error('INVENTORY_RESPONSE')
        if(!page.length)break
        for(const r of page){if(BigInt(id(r.id))<=BigInt(after))throw Error('INVENTORY_PROGRESS');after=id(r.id);rows.push(r)}
        if(rows.length>=config.max)throw Error('ROW_BUDGET')
      }
      all[name]=validateInventory(rows,config.max)
    }
    return all
  }
  stage='inventory'
  const before=await inventory(),sourceFingerprint=fingerprint(before)
  if(!bootstrap&&sourceFingerprint===state.sourceFingerprint){
    const marker=await json('https://www.zonaia.com.ar/catalogue-version.json',{},10000)
    if(marker.manifestSha256!==state.manifestSha256)throw Error('PREVIOUS_DEPLOYMENT_PENDING')
    console.log(JSON.stringify({stage:'unchanged',requests,receivedBytes:received,publication:false}));process.exit(0)
  }
  stage='storage-budget'
  const objects=await json(`${base}/storage/v1/object/list/${bucket}`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({prefix:'v1',limit:1000,offset:0})})
  // Root listing contains version directories. Enumerate each, without deleting anything.
  if(!Array.isArray(objects)||objects.length>=1000)throw Error('STORAGE_INVENTORY')
  let stored=0
  for(const object of objects){
    if(object.id){if(!Number.isFinite(object.metadata?.size))throw Error('STORAGE_SIZE_UNKNOWN');stored+=object.metadata.size;continue}
    if(!/^[0-9]{8}-[a-f0-9]{16}$/.test(object.name))throw Error('STORAGE_PREFIX_UNKNOWN')
    const files=await json(`${base}/storage/v1/object/list/${bucket}`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({prefix:`v1/${object.name}`,limit:100,offset:0})})
    if(!Array.isArray(files)||files.length>=100)throw Error('STORAGE_INVENTORY')
    for(const f of files){if(!Number.isFinite(f.metadata?.size))throw Error('STORAGE_SIZE_UNKNOWN');stored+=f.metadata.size}
  }
  const download=async(pin)=>{
    validatePin(pin)
    const get=path=>request(`${base}/storage/v1/object/authenticated/${bucket}/${path}`,{headers},40000000)
    const mb=await get(pin.manifestPath)
    if(mb.length>1000000||digest(mb)!==pin.manifestSha256)throw Error('MANIFEST_INTEGRITY')
    const m=JSON.parse(mb),prefix=pin.manifestPath.slice(0,-'manifest.json'.length)
    if(m.version!==1||!Array.isArray(m.chunks)||!m.chunks.length||m.chunks.length>8||m.compressedBytes>100*1024*1024)throw Error('MANIFEST_SCHEMA')
    const parts=[],paths=new Set();let total=0
    for(const c of m.chunks){
      if(!new RegExp('^'+prefix.replaceAll('/','\\/')+'part-[0-9]+[.]bin[.]gz$').test(c.path)||paths.has(c.path)||!Number.isSafeInteger(c.bytes)||c.bytes<=0||c.bytes>40000000)throw Error('MANIFEST_PATH')
      paths.add(c.path);total+=c.bytes;if(total>100*1024*1024)throw Error('COPY_BUDGET')
      const bytes=await get(c.path)
      if(bytes.length!==c.bytes||digest(bytes)!==c.sha256)throw Error('CHUNK_INTEGRITY')
      parts.push(bytes)
    }
    if(total!==m.compressedBytes)throw Error('MANIFEST_LENGTH')
    return decodeSnapshot(Buffer.concat(parts),m.sha256)
  }
  stage='baseline'
  const previous=bootstrap?{}:await download(state)
  const data={}
  for(const [name,config] of Object.entries(tables)){
    stage=`changes-${name}`
    const old=previous[name]||[],map=new Map(old.map(r=>[id(r.id),r]))
    const changed=before[name].filter(r=>!map.has(id(r.id))||map.get(id(r.id)).updated_at!==r.updated_at)
    const changes=[]
    for(let offset=0;offset<changed.length;offset+=50){
      const batch=changed.slice(offset,offset+50)
      const params=new URLSearchParams({select:config.fields,id:`in.(${batch.map(r=>id(r.id)).join(',')})`,order:'id.asc',limit:'50'})
      const bytes=await request(`${base}/rest/v1/${config.table}?${params}`,{headers},10000000)
      sourceBytes+=bytes.length
      if(sourceBytes>(bootstrap?380000000:60000000))throw Error('SOURCE_BUDGET')
      const rows=JSON.parse(bytes)
      if(!Array.isArray(rows)||rows.length!==batch.length)throw Error('CHANGES_INCOMPLETE')
      changes.push(...rows)
    }
    data[name]=mergeRows(old,before[name],changes,config)
  }
  stage='consistency'
  if(fingerprint(await inventory())!==sourceFingerprint)throw Error('SOURCE_CHANGED_DURING_READ')
  stage='encode'
  const {snapshot,bytes}=encodeSnapshot(data,at)
  if(stored+bytes.length+1000000>500000000)throw Error('STORAGE_MAINTENANCE_REQUIRED')
  // Includes conservative allowance for the subsequent Pages download, not other builds.
  const estimated=received+bytes.length*2+1000000
  if(history.reduce((n,e)=>n+e.egressBytes,0)+estimated>2200000000)throw Error('MONTHLY_EGRESS_BUDGET')
  const prefix=`v1/${at.slice(0,10).replaceAll('-','')}-${digest(bytes).slice(0,16)}`
  const manifest={version:1,exportedAt:at,counts:snapshot.counts,compressedBytes:bytes.length,sha256:digest(bytes),chunks:[]}
  const upload=async(path,body,type)=>request(`${base}/storage/v1/object/${bucket}/${path}`,{method:'POST',headers:{...headers,'Content-Type':type},body},1000000)
  stage='immutable-upload'
  for(let offset=0,index=0;offset<bytes.length;offset+=32000000,index++){
    const part=bytes.subarray(offset,offset+32000000),path=`${prefix}/part-${index}.bin.gz`
    await upload(path,part,'application/gzip')
    manifest.chunks.push({path,bytes:part.length,sha256:digest(part)})
  }
  const mb=Buffer.from(JSON.stringify(manifest)),manifestPath=`${prefix}/manifest.json`,manifestSha256=digest(mb)
  await upload(manifestPath,mb,'application/json')
  stage='roundtrip'
  const verified=await download({version:1,manifestPath,manifestSha256})
  for(const name of Object.keys(tables))if(verified.counts[name]!==snapshot.counts[name])throw Error('ROUNDTRIP_MISMATCH')
  const next={version:1,baseline:true,manifestPath,manifestSha256,sourceFingerprint,lastPublication:at,history:[...history,{at,egressBytes:estimated}]}
  stage='publish-pin'
  const latest=await json(`${gh}/contents/state.json?ref=state`,ghOptions())
  if(latest.sha!==stateFile.sha)throw Error('PUBLICATION_STATE_CHANGED')
  await json(`${gh}/contents/state.json`,ghOptions('PUT',{branch:'state',sha:stateFile.sha,message:'Update validated catalogue publication pin',content:Buffer.from(JSON.stringify(next,null,2)+'\n').toString('base64')}))
  stage='trigger-pages'
  await request(hook.href,{method:'POST'},1000000)
  console.log(JSON.stringify({stage:'snapshot-published-build-requested',counts:snapshot.counts,requests,receivedBytes:received,compressedBytes:bytes.length,manifestSha256}))
} catch(error){
  // Provider response bodies, URLs and arbitrary exception strings may contain secrets.
  const code=/^[A-Z0-9_]+$/.test(error.message)?error.message:'VALIDATION_OR_NETWORK_FAILURE'
  console.error(JSON.stringify({stage,code,requests,receivedBytes:received,publicationVerified:false}))
  process.exitCode=1
}
