import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import { writeSnapshotIfChanged } from '../scripts/sync-output.mjs';

const syncScript = fileURLToPath(new URL('../scripts/sync.mjs', import.meta.url));
const temporaryRoot = path.resolve(process.env.TEST_TMP_ROOT || os.tmpdir());
const fixtureContent = {
  source:'Tencent Docs online spreadsheet',fileId:'test',people:[{
    id:'p',name:'测试人员',weeks:[{
      year:'2025',month:'十月',week:'10.06-10.12',attendance:Array(14).fill(''),
      attendanceColors:Array(14).fill(''),monthlyPlan:'月计划',completed:'完成',problems:'无',nextPlan:'计划',
    }],
  }],
};

async function temporary(t) {
  await fs.mkdir(temporaryRoot,{recursive:true});
  const directory=await fs.mkdtemp(path.join(temporaryRoot,'weekly-sync-test-'));
  t.after(async()=>{
    const checked=path.resolve(directory);
    if(!checked.startsWith(temporaryRoot+path.sep+'weekly-sync-test-')) throw new Error('Unexpected cleanup path');
    await fs.rm(checked,{recursive:true,force:true});
  });
  return directory;
}

test('unchanged data leaves file bytes, timestamp and modification time intact',async t=>{
  const directory=await temporary(t);
  const target=path.join(directory,'data.json');
  assert.equal(await writeSnapshotIfChanged(target,fixtureContent,()=> '2000-01-01T00:00:00Z'),true);
  await fs.utimes(target,new Date('2000-01-01'),new Date('2000-01-01'));
  const before=await fs.readFile(target,'utf8');
  const mtime=(await fs.stat(target)).mtimeMs;
  assert.equal(await writeSnapshotIfChanged(target,fixtureContent,()=> '2099-01-01T00:00:00Z'),false);
  assert.equal(await fs.readFile(target,'utf8'),before);
  assert.equal((await fs.stat(target)).mtimeMs,mtime);
});

test('changed content is written once with a new update time',async t=>{
  const directory=await temporary(t),target=path.join(directory,'data.json');
  await writeSnapshotIfChanged(target,fixtureContent,()=> '2000-01-01T00:00:00Z');
  const changed=structuredClone(fixtureContent);
  changed.people[0].weeks[0].completed='实际更新';
  assert.equal(await writeSnapshotIfChanged(target,changed,()=> '2026-10-27T00:00:00Z'),true);
  const saved=JSON.parse(await fs.readFile(target,'utf8'));
  assert.equal(saved.syncedAt,'2026-10-27T00:00:00Z');
  assert.equal(saved.people[0].weeks[0].completed,'实际更新');
  assert.deepEqual(await fs.readdir(directory),['data.json']);
});

test('empty result and corrupt existing file are not overwritten',async t=>{
  const directory=await temporary(t),target=path.join(directory,'data.json');
  await fs.writeFile(target,'existing data');
  await assert.rejects(writeSnapshotIfChanged(target,{people:[]}),/没有人员/);
  await assert.rejects(writeSnapshotIfChanged(target,fixtureContent),/无法读取或解析/);
  assert.equal(await fs.readFile(target,'utf8'),'existing data');
});

const mockSource = `
import fs from 'node:fs';
let calls=0;
let session=0;
globalThis.fetch=async(url,options)=>{
  calls++;
  fs.writeFileSync('calls.json',JSON.stringify({calls}));
  if(!options.signal)throw new Error('Request has no timeout signal');
  const req=JSON.parse(options.body),scenario=process.env.MOCK_SCENARIO;
  const testConnection=scenario.startsWith('style-connection-');
  const requestSession=options.headers['Mcp-Session-Id'];
  if(testConnection && req.method==='initialize'){
    if(requestSession)throw new Error('A new connection must omit the old session');
    session++;
  }else if(testConnection && requestSession!=='session-'+session){
    throw new Error('Request did not use the active session');
  }
  if(['401','403','429'].includes(scenario))return {ok:false,status:Number(scenario),headers:{get:()=>null}};
  if(scenario==='timeout')throw new DOMException('Simulated request timeout','TimeoutError');
  if(scenario==='bad-json')return {ok:true,headers:{get:()=>null},text:async()=>'<html>bad response</html>'};
  let result;
  if(req.method==='initialize')result={protocolVersion:'2025-06-18'};
  if(req.method==='notifications/initialized')return {ok:true,headers:{get:()=>null},text:async()=>''};
  if(req.method==='tools/list')result={tools:[{name:'sheet.get_sheet_info'},{name:'sheet.get_cell_data'},...(scenario==='no-style'?[]:[{name:'sheet.get_cell_style'}])]};
  if(req.params?.name==='sheet.get_sheet_info')result={structuredContent:{sheets:[{id:'p',title:'测试人员'}]}};
  if(req.params?.name==='sheet.get_cell_data'){
    result=scenario==='tool-error'
      ? {isError:true,content:[{type:'text',text:'read failed '+process.env.TENCENT_DOCS_TOKEN}]}
      : {structuredContent:{values:scenario==='empty'?[]:[['2025','','十月','10.06-10.12',...Array(14).fill(''),'月计划','完成','无','计划']]}};
  }
  if(req.params?.name==='sheet.get_cell_style')result=scenario==='style-error'
    ? {isError:true,content:[{type:'text',text:'style failed'}]}
    : {structuredContent:{cells:[]}};
  if(testConnection && req.params?.name==='sheet.get_cell_style'){
    if(session===1 || scenario==='style-connection-persists'){
      const error={code:-32603,message:'tool execution failed (tool: get_cell_style): type:business, code:6086006, msg:type:framework, code:141, msg:invalid connection'};
      return {ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({jsonrpc:'2.0',id:req.id,error})};
    }
    result={structuredContent:{cells:[{row:0,col:4,background_color:'#ff0000'}]}};
  }
  const id=scenario==='wrong-id'?999:req.id;
  return {ok:true,headers:{get:name=>testConnection && req.method==='initialize' && name==='mcp-session-id'?'session-'+session:null},text:async()=>JSON.stringify({jsonrpc:'2.0',id,result})};
};
`;

for(const scenario of ['401','403','429','timeout','bad-json','wrong-id','tool-error','style-error','style-connection-persists','empty','no-style']) {
  test('sync failure preserves published data: '+scenario,async t=>{
    const directory=await temporary(t);
    await fs.mkdir(path.join(directory,'data'));
    const before=JSON.stringify({...fixtureContent,syncedAt:'2000-01-01T00:00:00Z'});
    await fs.writeFile(path.join(directory,'data/data.json'),before);
    await fs.writeFile(path.join(directory,'config.json'),JSON.stringify({fileId:'test',firstWeekYear:2025}));
    await fs.writeFile(path.join(directory,'mock.mjs'),mockSource);
    const run=spawnSync(process.execPath,['--import',pathToFileURL(path.join(directory,'mock.mjs')).href,syncScript],{
      cwd:directory,encoding:'utf8',timeout:5000,env:{...process.env,TENCENT_DOCS_TOKEN:'private-test-token',MOCK_SCENARIO:scenario},
    });
    assert.notEqual(run.status,0);
    if(['401','403','429'].includes(scenario))assert.match(run.stderr,new RegExp('HTTP '+scenario));
    if(scenario==='tool-error')assert.match(run.stderr,/读取失败/);
    if(scenario==='style-error')assert.match(run.stderr,/考勤颜色失败/);
    if(scenario==='style-connection-persists')assert.match(run.stderr,/考勤颜色失败.*invalid connection/);
    if(scenario==='empty')assert.match(run.stderr,/没有有效周记录/);
    if(scenario==='no-style')assert.match(run.stderr,/没有发现考勤颜色读取工具/);
    assert.equal(await fs.readFile(path.join(directory,'data/data.json'),'utf8'),before);
    assert.ok(!run.stderr.includes('private-test-token'));
    const {calls}=JSON.parse(await fs.readFile(path.join(directory,'calls.json'),'utf8'));
    if(['401','403','429','timeout','bad-json','wrong-id'].includes(scenario))assert.equal(calls,1,'error must not trigger automatic retry');
    if(scenario==='style-error')assert.equal(calls,6,'other style errors must not trigger reconnection');
    if(scenario==='style-connection-persists')assert.equal(calls,9,'an invalid connection must only be retried once');
  });
}

test('invalid attendance connection reconnects once and saves the retried style',async t=>{
  const directory=await temporary(t);
  await fs.writeFile(path.join(directory,'config.json'),JSON.stringify({fileId:'test',firstWeekYear:2025}));
  await fs.writeFile(path.join(directory,'mock.mjs'),mockSource);
  const run=spawnSync(process.execPath,['--import',pathToFileURL(path.join(directory,'mock.mjs')).href,syncScript],{
    cwd:directory,encoding:'utf8',timeout:5000,
    env:{...process.env,TENCENT_DOCS_TOKEN:'private-test-token',MOCK_SCENARIO:'style-connection-recovered'},
  });
  assert.equal(run.status,0,run.stderr);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,'calls.json'),'utf8')).calls,9);
  const snapshot=JSON.parse(await fs.readFile(path.join(directory,'data/data.json'),'utf8'));
  assert.equal(snapshot.people[0].weeks[0].attendanceColors[0],'#FF0000');
});

test('complete sync twice with identical source creates no second file update',async t=>{
  const directory=await temporary(t);
  await fs.writeFile(path.join(directory,'config.json'),JSON.stringify({fileId:'test',firstWeekYear:2025}));
  await fs.writeFile(path.join(directory,'mock.mjs'),mockSource);
  const run=()=>spawnSync(process.execPath,['--import',pathToFileURL(path.join(directory,'mock.mjs')).href,syncScript],{
    cwd:directory,encoding:'utf8',timeout:5000,env:{...process.env,TENCENT_DOCS_TOKEN:'private-test-token',MOCK_SCENARIO:'success'},
  });
  const first=run();assert.equal(first.status,0,first.stderr);
  const target=path.join(directory,'data/data.json'),before=await fs.readFile(target,'utf8');
  const second=run();assert.equal(second.status,0,second.stderr);
  assert.equal(await fs.readFile(target,'utf8'),before);
  assert.match(second.stdout,/内容未变化/);
  assert.equal(JSON.parse(before).people[0].weeks[0].year,'2025');
});
