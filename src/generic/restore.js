// 恢复是固定快照的服务端会话；分页可重取，全部应用成功后才提交设备基线。
import {assert,json} from '../lib/http.js';
import {digest,token} from '../lib/crypto.js';
import {one,all,stmt} from '../lib/db.js';
import {getContent} from '../storage/content.js';
import {syncSettings} from '../sync/settings.js';
import {requestId,scopeValue} from './input.js';
import {snapshotStatements,differenceStatement} from './snapshot.js';
import {heldScope,heldScopeValues,rememberRestored} from './held.js';
import {headsSql,emptyRestore,isEmptyRestore,acknowledgeEmpty,rememberRestoreSummary,latestRestoreSql} from './summary.js';

async function sessionInfo(env,row){
  const info=isEmptyRestore(row)?{total:0,page:null}:await one(env,'SELECT COUNT(*) total, (SELECT marker FROM restore_items WHERE session=? ORDER BY position LIMIT 1) page FROM restore_items WHERE session=?',row.token,row.token);
  return {session:row.token,mode:row.mode,page:info.page,total:info.total,expiresAt:row.expires,policy:JSON.parse(row.policy)};
}
async function start(env,device,input){
  const operation=requestId(input.requestId),scope=JSON.stringify(scopeValue(input.scope));
  assert(input.full===undefined||typeof input.full==='boolean',400,'full 必须是布尔值');
  const fingerprint=await digest(JSON.stringify([scope,input.full===true]));
  const find=()=>one(env,'SELECT * FROM restore_sessions WHERE device=? AND request_id=?',device.id,operation);
  const previous=await find();
  if(previous){assert(previous.fingerprint===fingerprint,409,'恢复范围变化，请开始新的下载');assert(previous.expires>Date.now(),410,'下载会话已过期，请重新开始');return json(await sessionInfo(env,previous));}
  const scopeHash=await digest(scope),session=token(),policy=JSON.stringify(await syncSettings(env)),now=Date.now();
  try{
    if(!input.full){const empty=await emptyRestore(env,device,{session,operation,fingerprint,scopeHash,scope,policy,now});if(empty)return json(await sessionInfo(env,empty));}
    await env.DB.batch([
      stmt(env,`INSERT INTO restore_sessions(token,owner,device,request_id,fingerprint,scope_hash,scope,mode,policy,created,expires)
        VALUES(?,?,?,?,?,?,json_set(?,'$._heads',json(${headsSql})),CASE WHEN ? OR EXISTS(SELECT 1 FROM restore_baselines WHERE device=? AND scope_hash=? AND dirty=1) THEN 'full'
          WHEN EXISTS(SELECT 1 FROM restore_baselines WHERE device=? AND scope_hash=? AND dirty=0) OR EXISTS(SELECT 1 FROM device_contents h WHERE h.device=? AND ${heldScope()}) THEN 'delta' ELSE 'full' END,?,?,?)`,
        session,device.user_id,device.id,operation,fingerprint,scopeHash,scope,device.user_id,input.full===true?1:0,device.id,scopeHash,device.id,scopeHash,device.id,...heldScopeValues(scope),policy,now,now+86400000),
      stmt(env,'DELETE FROM device_sync_summaries WHERE device=?',device.id),
      ...snapshotStatements(env,device,session,scope,policy),
      stmt(env,`INSERT OR IGNORE INTO restore_known(device,scope_hash,identity,type,namespace,key,path) SELECT ?,?,h.identity,h.type,h.namespace,h.key,h.path FROM device_contents h WHERE h.device=? AND ${heldScope()}`,device.id,scopeHash,device.id,...heldScopeValues(scope)),
      differenceStatement(env,device,session,scopeHash,scope,policy),
      // 开始应用后，本机可能处于部分完成状态；成功确认时再记录持有内容。
      stmt(env,`DELETE FROM device_contents AS h WHERE h.device=? AND ${heldScope()}`,device.id,...heldScopeValues(scope)),
      stmt(env,`INSERT OR IGNORE INTO restore_known(device,scope_hash,identity,type,namespace,key,path) SELECT ?,?,identity,type,namespace,key,path FROM restore_snapshots WHERE session=?`,device.id,scopeHash,session),
      stmt(env,`INSERT INTO restore_baselines(device,scope_hash,session,seq,dirty) VALUES(?,?,'',0,1) ON CONFLICT(device,scope_hash) DO UPDATE SET dirty=1`,device.id,scopeHash)
    ]);
  }catch(error){
    const raced=await find();if(!raced)throw error;
    assert(raced.fingerprint===fingerprint,409,'恢复范围变化，请开始新的下载');return json(await sessionInfo(env,raced));
  }
  return json(await sessionInfo(env,await find()));
}

export async function restore(env,device,input){
  if(input.action==='start')return start(env,device,input);
  assert(typeof input.session==='string',400,'缺少下载会话');
  const row=await one(env,'SELECT * FROM restore_sessions WHERE token=? AND device=? AND owner=?',input.session,device.id,device.user_id);
  assert(row,404,'下载会话不存在');
  if(input.action==='ack'&&row.acknowledged)return json({ok:true});
  assert(row.expires>Date.now(),410,'下载会话已过期，请重新开始');
  if(isEmptyRestore(row)){assert(input.action==='ack',404,'恢复包不存在');return acknowledgeEmpty(env,device,row);}
  if(input.action==='page'){
    assert(typeof input.page==='string',400,'缺少恢复包标记');
    const first=await one(env,'SELECT position FROM restore_items WHERE session=? AND marker=?',row.token,input.page);
    assert(first,404,'恢复包不存在');
    const rows=await all(env,'SELECT * FROM restore_items WHERE session=? AND position>=? ORDER BY position LIMIT 26',row.token,first.position);
    const page=rows.slice(0,25),last=page.at(-1).position;
    await stmt(env,'UPDATE restore_sessions SET delivered=MAX(delivered,?) WHERE token=? AND delivered>=?',last,row.token,first.position-1).run();
    const items=page.map(item=>item.type==='data'?{type:'data',op:item.op,namespace:item.namespace,key:item.key,...(item.op==='put'?{value:JSON.parse(item.value)}:{})}
      :{type:'file',op:item.op,path:item.path,...(item.op==='put'?{size:item.size,content:item.marker}:{})});
    return json({items,next:rows[25]?.marker??null,done:rows.length<=25});
  }
  if(input.action==='content'){
    assert(typeof input.content==='string',400,'缺少文件内容标记');
    const item=await one(env,"SELECT hash FROM restore_items WHERE session=? AND marker=? AND type='file' AND op='put'",row.token,input.content);
    assert(item,404,'恢复文件不存在');const content=await getContent(env,device.user_id,item.hash);assert(content,404,'文件内容不存在');
    return new Response(content.body,{headers:{'content-type':'application/octet-stream','content-length':String(content.size)}});
  }
  if(input.action==='ack'){
    const total=await one(env,'SELECT COUNT(*) n FROM restore_items WHERE session=?',row.token);
    assert(row.delivered>=total.n,409,'恢复包尚未全部获取，请继续下载');
    const guard='EXISTS(SELECT 1 FROM restore_sessions WHERE token=? AND acknowledged=1)';
    const result=await env.DB.batch([
      stmt(env,`UPDATE restore_sessions SET acknowledged=1 WHERE token=? AND seq=${latestRestoreSql}`,row.token),
      stmt(env,`UPDATE restore_baselines SET session=?,seq=?,dirty=0 WHERE device=? AND scope_hash=? AND ${guard}`,row.token,row.seq,device.id,row.scope_hash,row.token),
      stmt(env,`DELETE FROM restore_known WHERE device=? AND scope_hash=? AND NOT EXISTS(SELECT 1 FROM restore_snapshots n WHERE n.session=? AND n.identity=restore_known.identity) AND ${guard}`,device.id,row.scope_hash,row.token,row.token),
      stmt(env,`INSERT OR IGNORE INTO restore_known(device,scope_hash,identity,type,namespace,key,path) SELECT ?,?,identity,type,namespace,key,path FROM restore_snapshots WHERE session=? AND ${guard}`,device.id,row.scope_hash,row.token,row.token),
      stmt(env,`UPDATE devices SET status='下载成功' WHERE id=? AND ${guard}`,device.id,row.token),
      rememberRestored(env,device,row),
      rememberRestoreSummary(env,device,row)
    ]);
    assert(result[0].meta.changes>0,409,'已有较新的下载任务，请重新开始完整下载',{code:'RESTORE_SUPERSEDED'});
    return json({ok:true});
  }
  assert(false,400,'不支持的恢复操作');
}
