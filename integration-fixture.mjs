// Test-only fake network: no real credentials, private records or external calls.
import {tables,encodeSnapshot,digest,fingerprint} from './core.mjs'
import {writeFileSync} from 'node:fs'
const scenario=process.env.TEST_SCENARIO
if(!scenario)throw Error('Fixture requires TEST_SCENARIO')
const trace=[]
process.env.GITHUB_REPOSITORY='tripsifysite-cell/zonaia-catalogue-sync'
process.env.GITHUB_REF=scenario==='untrusted'?'refs/heads/other':'refs/heads/main'
process.env.GITHUB_EVENT_NAME='workflow_dispatch'
process.env.GH_TOKEN='test-only'
process.env.SUPABASE_URL='https://abcdefghijklmnopqrst.supabase.co'
process.env.SUPABASE_ANON_KEY='test-only'
process.env.CATALOGUE_PUBLISHER_EMAIL='test@example.invalid'
process.env.CATALOGUE_PUBLISHER_PASSWORD='test-only'
process.env.PAGES_DEPLOY_HOOK='https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/1234-abcd'
process.env.BOOTSTRAP=['bootstrap','source-failure','corrupt-roundtrip','upload-failure','storage-full'].includes(scenario)?'true':'false'
const timestamp='2026-10-15T00:00:00Z'
const row=(n)=>({id:n,slug:'sample-'+n,created_at:timestamp,updated_at:timestamp})
const data={ias:[row(1)],prompts:[row(2)],blog:[row(3)]}
const inventory=Object.fromEntries(Object.entries(data).map(([k,rows])=>[k,rows.map(r=>({id:r.id,updated_at:r.updated_at}))]))
const {snapshot,bytes}=encodeSnapshot(data,timestamp)
const prefix='v1/20261015-1234567890abcdef'
const manifest={version:1,sha256:digest(bytes),compressedBytes:bytes.length,chunks:[{path:prefix+'/part-0.bin.gz',bytes:bytes.length,sha256:digest(bytes)}]}
const objects=new Map([[prefix+'/manifest.json',Buffer.from(JSON.stringify(manifest))],[prefix+'/part-0.bin.gz',bytes]])
const state={version:1,baseline:process.env.BOOTSTRAP!=='true',manifestPath:prefix+'/manifest.json',manifestSha256:digest(Buffer.from(JSON.stringify(manifest))),sourceFingerprint:scenario==='unchanged'?fingerprint(inventory):'0'.repeat(64),history:[]}
globalThis.fetch=async(input,options={})=>{
  const u=new URL(input),method=options.method||'GET'
  trace.push({host:u.hostname,path:u.pathname,method})
  const result=(value,status=200)=>new Response(typeof value==='string'?value:JSON.stringify(value),{status})
  if(u.hostname==='api.github.com'){
    if(method==='PUT')return result({commit:{sha:'next'}})
    return result({sha:'initial',content:Buffer.from(JSON.stringify(state)).toString('base64')})
  }
  if(u.hostname==='api.cloudflare.com')return result({success:true})
  if(u.hostname==='www.zonaia.com.ar')return result({manifestSha256:state.manifestSha256})
  if(u.pathname==='/auth/v1/token')return result({access_token:'test-only',user:{app_metadata:{purpose:'zonaia_snapshot_publisher'}}})
  if(u.pathname.startsWith('/rest/v1/')){
    const config=Object.values(tables).find(t=>u.pathname.endsWith('/'+t.table)),name=Object.keys(tables).find(k=>tables[k]===config)
    if(!name)throw Error('Unexpected fixture table')
    if(u.searchParams.get('select')==='id,updated_at')return result(u.searchParams.get('id')==='gt.0'?inventory[name]:[])
    if(scenario==='source-failure')return result({message:'must not appear in logs'},500)
    return result(data[name])
  }
  if(u.pathname.includes('/object/list/')){
    const body=JSON.parse(options.body)
    return result(body.prefix==='v1'?[{name:'access-check.txt',id:'test',metadata:{size:scenario==='storage-full'?500000000:10}}]:[])
  }
  if(u.pathname.includes('/object/authenticated/')){
    const path=u.pathname.split('/zonaia-build-snapshots/')[1],value=objects.get(path)
    if(!value)return result('not found',404)
    if(scenario==='corrupt-roundtrip'&&!path.startsWith(prefix))return new Response('corrupt')
    return new Response(value)
  }
  if(u.pathname.includes('/object/zonaia-build-snapshots/')){
    if(scenario==='upload-failure')return result('denied',403)
    const path=u.pathname.split('/zonaia-build-snapshots/')[1]
    if(objects.has(path))return result('duplicate',409)
    objects.set(path,Buffer.from(options.body));return result({Key:path})
  }
  throw Error('Unmocked network request')
}
process.on('exit',()=>writeFileSync(process.env.TEST_TRACE,JSON.stringify(trace)))
