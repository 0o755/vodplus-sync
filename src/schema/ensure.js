// 首次 API 访问自动补齐漏跑的迁移；完成后缓存，同库并发请求共用一次检查。
import initial from '../../migrations/0001_initial.sql';
import files from '../../migrations/0002_d1_files.sql';
import shares from '../../migrations/0003_permanent_shares.sql';
import lookup from '../../migrations/0004_sync_lookup.sql';
import settings from '../../migrations/0005_sync_settings.sql';
import devices from '../../migrations/0006_device_config.sql';
import excluded from '../../migrations/0007_excluded_directories.sql';
import reset from '../../migrations/0008_factory_reset.sql';
import generic from '../../migrations/0009_generic_sync.sql';
import checks from '../../migrations/0010_publish_checks.sql';
import indexes from '../../migrations/0011_query_indexes.sql';
import {MIGRATION_NAMES,repairPlan} from './plan.js';

const migrations=[initial,files,shares,lookup,settings,devices,excluded,reset,generic,checks,indexes].map((sql,index)=>({name:MIGRATION_NAMES[index],sql}));
const readiness=new WeakMap();

async function inspect(db){
  const results=await db.batch([
    db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger')"),
    db.prepare('PRAGMA table_info(sync_settings)')
  ]);
  const names=new Set(results[0].results.map(row=>row.name));
  const columns=new Set(results[1].results.map(row=>row.name));
  const applied=names.has('d1_migrations')?new Set((await db.prepare('SELECT name FROM d1_migrations').all()).results.map(row=>row.name)):new Set();
  const hasSettings=names.has('sync_settings')&&!!await db.prepare('SELECT id FROM sync_settings WHERE id=1').first();
  return {names,columns,applied,hasSettings};
}

async function repair(db){
  for(let attempt=0;attempt<3;attempt++){
    const plan=repairPlan(migrations,await inspect(db));
    if(!plan.length)return;
    try{
      // DDL、默认行及迁移记录一起提交，失败时整体回滚，不留下半升级结构。
      await db.batch(plan.map(sql=>db.prepare(sql)));return;
    }catch(error){
      // 不同 Worker 实例可能同时补列；另一实例已完成时重新检查即可。
      if(attempt===2||!/duplicate column name|already exists/i.test(String(error?.message)))throw error;
    }
  }
}

export function ensureSchema(env,{force=false}={}){
  const previous=readiness.get(env.DB);
  if(previous&&!force)return previous;
  const task=(async()=>{if(previous)await previous;await repair(env.DB);})();
  readiness.set(env.DB,task);
  task.catch(()=>{if(readiness.get(env.DB)===task)readiness.delete(env.DB);});
  return task;
}
