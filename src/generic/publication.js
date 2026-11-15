// 完整推送只收集本次成功发布的清单，确认后才删除范围内缺失项。
import {assert,json} from '../lib/http.js';
import {token} from '../lib/crypto.js';
import {one,all,stmt} from '../lib/db.js';
import {scopeValue,requestId} from './input.js';
import {allowedFile,policyValues} from './snapshot.js';
import {syncSettings} from '../sync/settings.js';
import {pendingChecks,pendingValues,checkIdentity} from './check.js';
import {rememberPublished} from './held.js';

export async function publishing(env,device,session){
  if(session===undefined||session===null)return null;
  assert(typeof session==='string',400,'发布会话无效');
  const row=await one(env,'SELECT * FROM publish_sessions WHERE token=? AND device=? AND owner=?',session,device.id,device.user_id);
  assert(row,404,'发布会话不存在');assert(!row.finished,409,'发布已经完成，请开始新的推送');assert(row.expires>Date.now(),410,'发布会话已过期，请重新开始');return JSON.parse(row.scope);
}
export const publicationGuard='EXISTS(SELECT 1 FROM publish_sessions WHERE token=? AND device=? AND finished=0 AND expires>?)';

export async function publication(env,device,input,attempt=0){
  if(input.action==='start'){
    const id=requestId(input.requestId),scope=scopeValue(input.scope);assert(scope.namespaces.every(ns=>!ns.startsWith('legacy.')),400,'旧数据分区不能用于完整发布');
    const text=JSON.stringify(scope),expires=Date.now()+86400000;
    await stmt(env,'INSERT OR IGNORE INTO publish_sessions(token,device,owner,request_id,scope,expires) VALUES(?,?,?,?,?,?)',token(),device.id,device.user_id,id,text,expires).run();
    const row=await one(env,'SELECT * FROM publish_sessions WHERE device=? AND request_id=?',device.id,id);
    assert(row.scope===text,409,'推送范围变化，请开始新的推送');assert(row.expires>Date.now(),410,'发布会话已过期，请重新开始');
    return json({session:row.token,expiresAt:row.expires});
  }
  assert(input.action==='finish',400,'不支持的推送操作');
  const row=await one(env,'SELECT * FROM publish_sessions WHERE token=? AND device=? AND owner=?',input.session??'',device.id,device.user_id);
  assert(row,404,'发布会话不存在');if(row.finished)return json({ok:true});assert(row.expires>Date.now(),410,'发布会话已过期，请重新开始');
  const currentPolicy=await syncSettings(env),policy=JSON.stringify(currentPolicy),source=`device:${device.id}`,now=Date.now();
  // 确认清单与规则版本一起校验，避免刚被排除的文件被旧规则误删。
  const ready=`EXISTS(SELECT 1 FROM publish_sessions WHERE token=? AND finished=0) AND EXISTS(SELECT 1 FROM sync_settings WHERE id=1 AND revision=?) AND NOT EXISTS(${pendingChecks})`;
  const readyValues=[row.token,currentPolicy.revision,...pendingValues(row.token,row.scope,policy,device.user_id)];
  const result=await env.DB.batch([
    stmt(env,`UPDATE entities SET deleted=1,version=version+1,source=?,updated=? WHERE owner=? AND deleted=0 AND kind='record'
      AND json_extract(data,'$.namespace') IN (SELECT value FROM json_each(?,'$.namespaces'))
      AND NOT EXISTS(SELECT 1 FROM publish_items WHERE session=? AND identity=json_array('data',json_extract(entities.data,'$.namespace'),json_extract(entities.data,'$.key')))
      AND ${ready}`,source,now,device.user_id,row.scope,row.token,...readyValues),
    stmt(env,`UPDATE entities SET deleted=1,version=version+1,source=?,updated=? WHERE owner=? AND deleted=0 AND kind='file' AND json_extract(?,'$.files')=1
      AND ${allowedFile('entities.path')}
      AND NOT EXISTS(SELECT 1 FROM publish_items WHERE session=? AND identity=json_array('file',entities.path))
      AND ${ready}`,source,now,device.user_id,row.scope,...policyValues(row.scope,policy),row.token,...readyValues),
    stmt(env,`UPDATE publish_sessions SET finished=1 WHERE token=? AND ${ready}`,row.token,...readyValues),
    ...rememberPublished(env,device,row,policy)
  ]);
  if(!result[2].meta.changes){
    if((await one(env,'SELECT finished FROM publish_sessions WHERE token=?',row.token)).finished)return json({ok:true});
    const pending=await all(env,pendingChecks+' ORDER BY c.identity LIMIT 101',...pendingValues(row.token,row.scope,policy,device.user_id));
    if(pending.length)return json({ok:false,upload:pending.slice(0,100).map(checkIdentity),hasMore:pending.length>100});
    assert(attempt<2,503,'同步规则正在更新，请重试确认',{retryable:true});return publication(env,device,input,attempt+1);
  }
  return json({ok:true});
}
