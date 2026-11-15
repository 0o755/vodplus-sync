// 使用真实 workerd 和 D1 SQLite，不配置 R2，验证纯 D1 部署也能完整运行。
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FILE_ICON_ASSETS } from '../web/lib/file-types.js';
export const digest=value=>createHash('sha256').update(value).digest('hex');
export async function createHarness({assets=false,setup=true}={}){
  const bundle=await build({entryPoints:['src/worker.js'],bundle:true,write:false,format:'esm',platform:'browser'});
  const staticFiles=new Map();
  if(assets){
    const files=['index.html','styles.css','app.js','ui.js','icons.js','share.html','share.js','deploy.html','deploy.js','lib/binding-links.js','lib/files-api.js','lib/upload-plan.js','pages/binding.js','pages/sync-settings.js','pages/overview.js','pages/shares.js','pages/people.js','pages/device-config.js','pages/files.js','pages/file-editor.js','pages/file-actions.js','pages/uploads.js','pages/revisions.js'];
    files.push('lib/file-types.js','lib/file-list.js','pages/account.js','pages/service-reset.js',...FILE_ICON_ASSETS);
    for(const file of files)staticFiles.set('/'+file,await readFile(new URL('../web/'+file,import.meta.url)));
  }
  const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',d1Databases:['DB'],serviceBindings:{ASSETS:request=>{
    const path=new URL(request.url).pathname;const file=path==='/'?'/index.html':path;
    return staticFiles.has(file)?new Response(staticFiles.get(file),{headers:{'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8'}}):new Response('Not found',{status:404});
  }}});
  const db=await mf.getD1Database('DB');
  const sql=(await readFile(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8')).replace(/^--.*$/gm,'');
  const triggers=[...sql.matchAll(/CREATE TRIGGER[\s\S]*?END;/g)].map(m=>m[0]);
  for(const statement of sql.replace(/CREATE TRIGGER[\s\S]*?END;/g,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  for(const trigger of triggers)await db.prepare(trigger).run();
  const fileSql=(await readFile(new URL('../migrations/0002_d1_files.sql',import.meta.url),'utf8')).replace(/^--.*$/gm,'');
  for(const statement of fileSql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  const shareSql=(await readFile(new URL('../migrations/0003_permanent_shares.sql',import.meta.url),'utf8')).replace(/^--.*$/gm,'');
  await db.prepare(shareSql).run();
  const lookupSql=(await readFile(new URL('../migrations/0004_sync_lookup.sql',import.meta.url),'utf8')).replace(/^--.*$/gm,'');
  for(const statement of lookupSql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  const settingsSql=(await readFile(new URL('../migrations/0005_sync_settings.sql',import.meta.url),'utf8')).replace(/^--.*$/gm,'');
  for(const statement of settingsSql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  const deviceSql=(await readFile(new URL('../migrations/0006_device_config.sql',import.meta.url),'utf8')).replace(/^--.*$/gm,'');
  for(const statement of deviceSql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  const excludeSql=(await readFile(new URL('../migrations/0007_excluded_directories.sql',import.meta.url),'utf8')).replace(/^--.*$/gm,'');
  for(const statement of excludeSql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  const resetSql=(await readFile(new URL('../migrations/0008_factory_reset.sql',import.meta.url),'utf8')).replace(/^--.*$/gm,'');
  const resetTrigger=resetSql.match(/CREATE TRIGGER[\s\S]*?END;/)[0];
  for(const statement of resetSql.replace(resetTrigger,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  await db.prepare(resetTrigger).run();
  let cookie='';
  const request=async(path,{method='GET',data,token,admin=true,raw,headers={}}={})=>{
    const response=await mf.dispatchFetch('http://localhost'+path,{method,headers:{...(admin&&cookie?{cookie}:{}),...(token?{authorization:`Bearer ${token}`} : {}),...(data?{'content-type':'application/json'}:{}),...headers},body:data?JSON.stringify(data):raw});
    const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}
    return {status:response.status,value,headers:response.headers};
  };
  if(setup){
    const response=await request('/api/setup',{method:'POST',data:{username:'admin',password:'test-password-1234'}});
    if(response.status!==200)throw new Error(JSON.stringify(response.value));cookie=response.headers.get('set-cookie').split(';')[0];
  }
  const createUser=async name=>(await request('/api/admin/users',{method:'POST',data:{name}})).value.id;
  const bind=async userId=>{const code=(await request(`/api/admin/users/${userId}/binding`,{method:'POST',data:{}})).value.code;return (await request('/api/bind',{method:'POST',admin:false,data:{code,deviceName:'测试设备'}})).value;};
  const put=async(owner,path,text='print("hello")',extra={})=>{
    const hash=digest(text);await request(`/api/admin/spaces/${owner}/blobs/${hash}`,{method:'PUT',raw:text});
    const patch={id:crypto.randomUUID(),kind:'file',path,baseVersion:0,data:{hash,size:Buffer.byteLength(text)},...extra};
    return {patch,result:await request(`/api/admin/spaces/${owner}/commit`,{method:'POST',data:{opId:crypto.randomUUID(),patch}})};
  };
  return {mf,db,request,createUser,bind,put,dispose:()=>mf.dispose()};
}
