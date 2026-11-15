// 普通文件按相对路径直接发布，父目录、摘要和版本均由服务端管理。
import {assert,bytes,json,relativePath,Fault} from '../lib/http.js';
import {digest} from '../lib/crypto.js';
import {one,stmt} from '../lib/db.js';
import {putContent} from '../storage/content.js';
import {syncSettings,assertFileAllowed} from '../sync/settings.js';
import {requestId} from './input.js';
import {receipt,receiptStatement,receiptGuard,receiptValues} from './push.js';
import {publishing,publicationGuard} from './publication.js';

export async function pushFile(env,request,url,device){
  const path=relativePath(url.searchParams.get('path'));const operation=requestId(request.headers.get('idempotency-key'));
  const deleting=request.method==='DELETE';const content=deleting?null:await bytes(request,1572864);
  const session=request.headers.get('x-sync-session');
  const hash=deleting?null:await digest(content);const fingerprint=await digest(JSON.stringify([request.method,path,hash,session]));
  const saved=await receipt(env,device,operation,fingerprint);if(saved)return json(saved);
  const scope=await publishing(env,device,session);
  assert(!scope||(scope.files&&scope.roots.some(root=>!root||path===root||path.startsWith(root+'/'))),400,'文件不在本次推送范围内');
  const policy=await syncSettings(env);
  try{assertFileAllowed(policy,path);}catch(error){
    if(error instanceof Fault&&error.status===422)return json({ok:true,skipped:true,reason:error.detail.code});throw error;
  }
  const owner=device.user_id;const nonce=crypto.randomUUID();const result=deleting?{ok:true,path}:{ok:true,path,size:content.length};
  if(!deleting)await putContent(env,owner,hash,content);
  const parts=path.split('/');const rows=[];
  if(!deleting)for(let i=1;i<parts.length;i++)rows.push({id:crypto.randomUUID(),path:parts.slice(0,i).join('/'),kind:'directory',data:'{}'});
  rows.push({id:crypto.randomUUID(),path,kind:'file',data:JSON.stringify({hash,size:content?.length??0})});
  const encoded=JSON.stringify(rows);
  const wrongKind=await one(env,`SELECT e.path FROM entities e JOIN json_each(?) j ON lower(e.path)=lower(json_extract(j.value,'$.path')) WHERE e.owner=? AND e.path IS NOT NULL AND e.deleted=0 AND e.kind<>json_extract(j.value,'$.kind') LIMIT 1`,encoded,owner);
  assert(!wrongKind,422,'目标文件或父目录与已有路径类型不一致');
  const condition=`EXISTS(SELECT 1 FROM sync_settings WHERE id=1 AND revision=?)
    AND NOT EXISTS(SELECT 1 FROM entities e JOIN json_each(?) j ON lower(e.path)=lower(json_extract(j.value,'$.path')) WHERE e.owner=? AND e.path IS NOT NULL AND e.deleted=0 AND e.kind<>json_extract(j.value,'$.kind'))
    AND (SELECT COUNT(*) FROM entities WHERE owner=?)+(SELECT COUNT(*) FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM entities WHERE owner=? AND path IS NOT NULL AND lower(path)=lower(json_extract(j.value,'$.path'))))<=5000`;
  const batch=[receiptStatement(env,device,operation,fingerprint,nonce,result,(deleting?'EXISTS(SELECT 1 FROM sync_settings WHERE id=1 AND revision=?)':condition)+(scope?' AND '+publicationGuard:''),[...(deleting?[policy.revision]:[policy.revision,encoded,owner,owner,encoded,owner]),...(scope?[session,device.id,Date.now()]:[])])];
  if(deleting){
    batch.push(stmt(env,`UPDATE entities SET deleted=1,version=version+1,source=?,updated=? WHERE owner=? AND path IS NOT NULL AND lower(path)=lower(?) AND kind='file' AND deleted=0 AND ${receiptGuard}`,`device:${device.id}`,Date.now(),owner,path,...receiptValues(device,operation,nonce)));
  }else{
    batch.push(stmt(env,`INSERT INTO entities(owner,id,kind,path,version,data,deleted,enabled,source,updated)
      SELECT ?,COALESCE((SELECT id FROM entities WHERE owner=? AND path IS NOT NULL AND lower(path)=lower(json_extract(j.value,'$.path')) ORDER BY deleted,updated DESC LIMIT 1),json_extract(j.value,'$.id')),
      json_extract(j.value,'$.kind'),json_extract(j.value,'$.path'),1,json_extract(j.value,'$.data'),0,1,?,?
      FROM json_each(?) j WHERE ${receiptGuard}
      ON CONFLICT(owner,id) DO UPDATE SET kind=excluded.kind,path=excluded.path,version=entities.version+1,data=excluded.data,deleted=0,enabled=1,source=excluded.source,updated=excluded.updated
      WHERE entities.path<>excluded.path OR entities.data<>excluded.data OR entities.deleted<>0 OR entities.enabled<>1 OR entities.kind<>excluded.kind`,owner,owner,`device:${device.id}`,Date.now(),encoded,...receiptValues(device,operation,nonce)));
  }
  if(scope&&!deleting)batch.push(stmt(env,`INSERT OR IGNORE INTO publish_items(session,identity) SELECT ?,json_array('file',?) WHERE ${receiptGuard}`,session,path,...receiptValues(device,operation,nonce)));
  if(scope)batch.push(deleting
    ?stmt(env,`DELETE FROM publish_checks WHERE session=? AND identity=json_array('file',?) AND ${receiptGuard}`,session,path,...receiptValues(device,operation,nonce))
    :stmt(env,`UPDATE publish_checks SET hash=?,size=?,entity_id=(SELECT id FROM entities WHERE owner=? AND path=? AND deleted=0),version=(SELECT version FROM entities WHERE owner=? AND path=? AND deleted=0)
      WHERE session=? AND identity=json_array('file',?) AND ${receiptGuard}`,hash,content.length,owner,path,owner,path,session,path,...receiptValues(device,operation,nonce)));
  await env.DB.batch(batch);
  if(scope)await publishing(env,device,session);
  const published=await receipt(env,device,operation,fingerprint);
  if(!published){
    const count=await one(env,'SELECT COUNT(*) n FROM entities WHERE owner=?',owner);
    assert(count.n<5000,413,'用户空间已达记录容量上限');
    assert(false,503,'文件规则或路径刚刚变化，请重试本次推送',{retryable:true});
  }
  return json(published);
}
