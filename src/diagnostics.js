// 仅检查公开的表结构版本，不返回用户、凭证或请求参数。
import {json} from './lib/http.js';
const required=[
 ['administrators','0001_initial.sql'],['devices','0001_initial.sql'],['entities','0001_initial.sql'],
 ['file_contents','0002_d1_files.sql'],['file_chunks','0002_d1_files.sql'],
 ['sync_settings','0005_sync_settings.sql'],['device_config','0006_device_config.sql'],
 ['maintenance_actions','0008_factory_reset.sql'],
 ['restore_sessions','0009_generic_sync.sql'],['restore_snapshots','0009_generic_sync.sql'],
 ['restore_items','0009_generic_sync.sql'],['restore_baselines','0009_generic_sync.sql'],['restore_known','0009_generic_sync.sql'],
 ['publish_sessions','0009_generic_sync.sql'],['publish_items','0009_generic_sync.sql'],['publish_checks','0010_publish_checks.sql'],['device_contents','0010_publish_checks.sql']
];
export async function health(env){
  try{
    const results=await env.DB.batch([env.DB.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')"),env.DB.prepare('PRAGMA table_info(sync_settings)')]);
    const names=new Set(results[0].results.map(row=>row.name));const missing=new Set(required.filter(([name])=>!names.has(name)).map(([,migration])=>migration));
    if(!results[1].results.some(row=>row.name==='excluded_directories'))missing.add('0007_excluded_directories.sql');
    if(!names.has('factory_reset'))missing.add('0008_factory_reset.sql');
    if(!names.has('reset_generic_sync'))missing.add('0009_generic_sync.sql');
    if(!names.has('reset_publish_checks'))missing.add('0010_publish_checks.sql');
    return json({ok:missing.size===0,requiredSchema:10,syncApi:2,capabilities:['push-check','device-held-content'],automaticMigration:true,code:missing.size?'SCHEMA_NOT_READY':'OK',missingMigrations:[...missing]},missing.size?503:200);
  }catch{return json({ok:false,requiredSchema:10,code:'DATABASE_UNAVAILABLE'},503);}
}
export function failureCode(error){
  const message=String(error?.message||error);
  if(/no such (table|column)|has no column named/i.test(message))return 'SCHEMA_NOT_READY';
  if(/D1.*(limit|quota)|exceeded.*(read|write|storage)|database.*(full|size limit)/i.test(message))return 'DATABASE_LIMIT';
  return 'INTERNAL_ERROR';
}
