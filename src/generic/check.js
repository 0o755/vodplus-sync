// 小型摘要清单与云端当前内容比对，一致项直接计入发布清单。
import {assert,json,relativePath,Fault} from '../lib/http.js';
import {digest} from '../lib/crypto.js';
import {valueDigest} from '../lib/content-digest.js';
import {all,stmt} from '../lib/db.js';
import {namespace,dataKey} from './input.js';
import {publishing,publicationGuard} from './publication.js';
import {syncSettings,assertFileAllowed} from '../sync/settings.js';
import {allowedFile,policyValues} from './snapshot.js';

export const matchingCheck=`EXISTS(SELECT 1 FROM entities e WHERE e.owner=? AND e.id=c.entity_id AND e.version=c.version AND e.deleted=0 AND e.enabled=1
  AND (c.type='data' OR (e.path=c.path AND NOT EXISTS(SELECT 1 FROM entities p WHERE p.owner=e.owner AND p.kind='directory' AND p.deleted=0 AND p.enabled=0 AND substr(e.path,1,length(p.path)+1)=p.path||'/'))))`;
export const pendingChecks=`SELECT c.* FROM publish_checks c WHERE c.session=? AND (c.type='data' OR (${allowedFile('c.path')})) AND NOT ${matchingCheck}`;
export const pendingValues=(session,scope,policy,owner)=>[session,...policyValues(scope,policy),owner];
export const checkIdentity=item=>item.type==='data'?{type:'data',namespace:item.namespace,key:item.key}:{type:'file',path:item.path};

export async function checkPush(env,device,input,attempt=0){
  assert(typeof input.session==='string',400,'缺少发布会话');
  const scope=await publishing(env,device,input.session),policy=await syncSettings(env);
  assert(Array.isArray(input.items)&&input.items.length>0&&input.items.length<=100,400,'一次比对需要 1–100 项');
  const identities=new Set();const items=[];
  for(const raw of input.items){
    assert(raw&&['data','file'].includes(raw.type),400,'清单项目类型无效');
    assert(typeof raw.hash==='string'&&/^[a-f0-9]{64}$/.test(raw.hash),400,'内容摘要需要 64 位小写十六进制 SHA256');
    let item;
    if(raw.type==='data'){
      const ns=namespace(raw.namespace),key=dataKey(raw.key);
      assert(scope.namespaces.includes(ns)&&!ns.startsWith('legacy.'),400,'数据分区不在本次推送范围内');
      item={type:'data',namespace:ns,key,hash:raw.hash,id:'record_'+await digest(JSON.stringify([ns,key])),identity:JSON.stringify(['data',ns,key])};
    }else{
      const path=relativePath(raw.path);assert(scope.files&&scope.roots.some(root=>!root||path===root||path.startsWith(root+'/')),400,'文件不在本次推送范围内');
      item={type:'file',path,hash:raw.hash,size:raw.size,identity:JSON.stringify(['file',path])};
      try{assertFileAllowed(policy,path);}catch(error){if(error instanceof Fault&&error.status===422)item.reason=error.detail.code;else throw error;}
      assert(Number.isSafeInteger(raw.size)&&raw.size>=0&&(item.reason||raw.size<=1572864),413,'文件大小无效或超过 1.5 MiB');
    }
    assert(!identities.has(item.identity),400,'比对清单不能重复包含同一项目');identities.add(item.identity);items.push(item);
  }
  // 分开使用记录主键和存活路径索引，避免每个摘要都扫描整个用户空间。
  const current=await all(env,`SELECT j.key position,e.* FROM json_each(?) j LEFT JOIN entities e ON e.owner=? AND e.deleted=0 AND e.id=json_extract(j.value,'$.id') WHERE json_extract(j.value,'$.type')='data'
    UNION ALL SELECT j.key position,e.* FROM json_each(?) j LEFT JOIN entities e ON e.owner=? AND e.deleted=0 AND e.kind='file' AND e.path=json_extract(j.value,'$.path') WHERE json_extract(j.value,'$.type')='file'`,JSON.stringify(items),device.user_id,JSON.stringify(items),device.user_id);
  for(const row of current){
    const item=items[Number(row.position)];if(!row.id||!row.enabled||item.reason)continue;
    const data=JSON.parse(row.data);
    const same=item.type==='data'?await valueDigest(data.value)===item.hash:row.path===item.path&&data.hash===item.hash&&data.size===item.size;
    if(same){item.entity_id=row.id;item.version=row.version;}
  }
  const encoded=JSON.stringify(items),session=input.session;
  const guard=publicationGuard+' AND EXISTS(SELECT 1 FROM sync_settings WHERE id=1 AND revision=?)';
  const guardValues=[session,device.id,Date.now(),policy.revision];
  const result=await env.DB.batch([
    stmt(env,`INSERT INTO publish_checks(session,identity,type,namespace,key,path,hash,size,entity_id,version)
      SELECT ?,json_extract(j.value,'$.identity'),json_extract(j.value,'$.type'),json_extract(j.value,'$.namespace'),json_extract(j.value,'$.key'),json_extract(j.value,'$.path'),json_extract(j.value,'$.hash'),json_extract(j.value,'$.size'),json_extract(j.value,'$.entity_id'),json_extract(j.value,'$.version')
      FROM json_each(?) j WHERE json_extract(j.value,'$.reason') IS NULL AND ${guard}
      ON CONFLICT(session,identity) DO UPDATE SET hash=excluded.hash,size=excluded.size,entity_id=excluded.entity_id,version=excluded.version`,session,encoded,...guardValues),
    stmt(env,`DELETE FROM publish_checks WHERE session=? AND identity IN(SELECT json_extract(value,'$.identity') FROM json_each(?) WHERE json_extract(value,'$.reason') IS NOT NULL) AND ${guard}`,session,encoded,...guardValues),
    stmt(env,`INSERT OR IGNORE INTO publish_items(session,identity) SELECT c.session,c.identity FROM publish_checks c WHERE c.session=? AND c.identity IN(SELECT json_extract(value,'$.identity') FROM json_each(?)) AND ${matchingCheck} AND ${guard}`,session,encoded,device.user_id,...guardValues),
    stmt(env,'SELECT revision FROM sync_settings WHERE id=1')
  ]);
  await publishing(env,device,session);
  if(result[3].results[0].revision!==policy.revision){assert(attempt<2,503,'同步规则正在更新，请重试比对',{retryable:true});return checkPush(env,device,input,attempt+1);}
  const matched=await all(env,`SELECT c.identity FROM publish_checks c WHERE c.session=? AND c.identity IN(SELECT json_extract(value,'$.identity') FROM json_each(?)) AND ${matchingCheck}`,session,encoded,device.user_id);
  const unchanged=new Set(matched.map(row=>row.identity));
  return json({items:items.map(item=>({...checkIdentity(item),status:item.reason?'skipped':unchanged.has(item.identity)?'unchanged':'upload',...(item.reason?{reason:item.reason}:{})}))});
}
