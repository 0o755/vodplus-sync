// 记录设备已成功持有的具体项目，跨恢复范围复用；不推进其他设备的云端状态。
import {stmt} from '../lib/db.js';
import {matchingCheck} from './check.js';
import {allowedFile,policyValues} from './snapshot.js';

export function heldScope(alias='h'){
  return `((${alias}.type='data' AND ${alias}.namespace IN(SELECT value FROM json_each(?,'$.namespaces')))
    OR (${alias}.type='file' AND json_extract(?,'$.files')=1 AND EXISTS(SELECT 1 FROM json_each(?,'$.roots') r WHERE r.value='' OR ${alias}.path=r.value OR substr(${alias}.path,1,length(r.value)+1)=r.value||'/')))`;
}
export const heldScopeValues=scope=>[scope,scope,scope];
export function rememberPublished(env,device,row,policy){
  const complete='EXISTS(SELECT 1 FROM publish_sessions WHERE token=? AND finished=1)';
  const selected=`((h.type='data' AND h.namespace IN(SELECT value FROM json_each(?,'$.namespaces'))) OR (h.type='file' AND json_extract(?,'$.files')=1 AND ${allowedFile('h.path')}))`;
  return [
    stmt(env,`DELETE FROM device_contents AS h WHERE device=? AND ${selected} AND NOT EXISTS(SELECT 1 FROM publish_checks c WHERE c.session=? AND c.identity=h.identity AND ${matchingCheck}) AND ${complete}`,device.id,row.scope,row.scope,...policyValues(row.scope,policy),row.token,device.user_id,row.token),
    stmt(env,`INSERT INTO device_contents(device,identity,type,namespace,key,path,entity_id,version)
      SELECT ?,c.identity,c.type,c.namespace,c.key,c.path,c.entity_id,c.version FROM publish_checks c WHERE c.session=? AND ${matchingCheck}
      AND (c.type='data' OR (${allowedFile('c.path')})) AND ${complete}
      ON CONFLICT(device,identity) DO UPDATE SET entity_id=excluded.entity_id,version=excluded.version
      WHERE device_contents.entity_id<>excluded.entity_id OR device_contents.version<>excluded.version`,device.id,row.token,device.user_id,...policyValues(row.scope,policy),row.token),
    // 完整推送已确认的范围可恢复增量；范围外的中断恢复仍保留 dirty 标记。
    stmt(env,`UPDATE restore_baselines SET dirty=0 WHERE device=? AND ${complete} AND scope_hash IN(
      SELECT s.scope_hash FROM restore_sessions s WHERE s.device=?
      AND NOT EXISTS(SELECT 1 FROM json_each(s.scope,'$.namespaces') n WHERE n.value NOT IN(SELECT value FROM json_each(?,'$.namespaces')))
      AND (json_extract(s.scope,'$.files')=0 OR (json_extract(?,'$.files')=1 AND NOT EXISTS(
        SELECT 1 FROM json_each(s.scope,'$.roots') r WHERE NOT EXISTS(SELECT 1 FROM json_each(?,'$.roots') p WHERE p.value='' OR r.value=p.value OR substr(r.value,1,length(p.value)+1)=p.value||'/')))))`,device.id,row.token,device.id,row.scope,row.scope,row.scope)
  ];
}
export function rememberRestored(env,device,row){
  // 将文件、通用记录和其他记录分开联查，各自使用路径、分区键或主键索引。
  const select=(index,predicate)=>`SELECT ?,n.identity,n.type,n.namespace,n.key,n.path,e.id,n.version
    FROM restore_snapshots n CROSS JOIN entities e ${index} ON e.owner=? AND e.deleted=0 AND e.enabled=1 AND e.version=n.version AND ${predicate}
    WHERE n.session=? AND EXISTS(SELECT 1 FROM restore_sessions WHERE token=? AND acknowledged=1)`;
  const file=select('INDEXED BY live_path',"n.type='file' AND e.path IS NOT NULL AND e.path=n.path AND e.kind='file' AND json_extract(e.data,'$.hash')=n.hash");
  const record=select('INDEXED BY entity_record_lookup',"n.type='data' AND e.kind='record' AND CAST(json_extract(e.data,'$.namespace') AS TEXT)=n.namespace AND CAST(json_extract(e.data,'$.key') AS TEXT)=n.key AND e.data->'$.value'=n.value");
  const other=select('',"n.type='data' AND e.path IS NULL AND e.kind<>'record' AND e.id=n.key AND 'legacy.'||e.kind=n.namespace AND e.data=n.value");
  const params=[device.id,device.user_id,row.token,row.token];
  return stmt(env,`INSERT OR REPLACE INTO device_contents(device,identity,type,namespace,key,path,entity_id,version) ${file} UNION ALL ${record} UNION ALL ${other}`,...params,...params,...params);
}
