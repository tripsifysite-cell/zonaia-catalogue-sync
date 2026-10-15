import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
const here=fileURLToPath(new URL('.',import.meta.url))
for(const scenario of ['bootstrap','changed','unchanged','untrusted','source-failure','corrupt-roundtrip','upload-failure','storage-full']){
  test('bounded end-to-end simulation: '+scenario,()=>{
    const temp=mkdtempSync(join(tmpdir(),'catalogue-sync-test-')),traceFile=join(temp,'trace.json')
    try{
      const run=spawnSync(process.execPath,['--import',pathToFileURL(join(here,'integration-fixture.mjs')).href,'sync.mjs'],{cwd:here,encoding:'utf8',env:{...process.env,TEST_SCENARIO:scenario,TEST_TRACE:traceFile},timeout:20000})
      assert.equal(run.error,undefined)
      const trace=JSON.parse(readFileSync(traceFile,'utf8'))
      const success=['bootstrap','changed','unchanged'].includes(scenario)
      assert.equal(run.status,success?0:1,run.stderr)
      const puts=trace.filter(r=>r.host==='api.github.com'&&r.method==='PUT')
      const hooks=trace.filter(r=>r.host==='api.cloudflare.com')
      assert.equal(puts.length,['bootstrap','changed'].includes(scenario)?1:0)
      assert.equal(hooks.length,puts.length)
      if(scenario==='unchanged')assert.equal(trace.filter(r=>r.path.includes('/storage/')).length,0)
      if(scenario==='untrusted')assert.equal(trace.length,0)
      assert.equal((run.stderr+run.stdout).includes('must not appear in logs'),false)
      assert.equal((run.stderr+run.stdout).includes('test-only'),false)
    }finally{rmSync(temp,{recursive:true,force:true})}
  })
}
