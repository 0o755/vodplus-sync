// 从项目自带迁移生成幂等补齐计划，普通访问不删除或覆盖已有业务数据。
export const MIGRATION_NAMES=[
  '0001_initial.sql','0002_d1_files.sql','0003_permanent_shares.sql','0004_sync_lookup.sql',
  '0005_sync_settings.sql','0006_device_config.sql','0007_excluded_directories.sql','0008_factory_reset.sql',
  '0009_generic_sync.sql','0010_publish_checks.sql'
];

export function statements(sql){
  // 触发器中的分号属于同一条语句，不能拆开执行其中的清空指令。
  const triggers=[];
  const text=sql.replace(/^--.*$/gm,'').replace(/CREATE TRIGGER[\s\S]*?END;/g,trigger=>`__TRIGGER_${triggers.push(trigger)-1}__;`);
  return text.split(';').map(part=>part.trim()).filter(Boolean).map(part=>{
    const match=part.match(/^__TRIGGER_(\d+)__$/);return match?triggers[Number(match[1])]:part;
  });
}

export function repairPlan(migrations,{names,columns,applied,hasSettings}){
  const plan=[];const missingColumn=!columns.has('excluded_directories');
  for(const {name,sql} of migrations){
    for(const statement of statements(sql)){
      const create=statement.match(/^CREATE (TABLE|UNIQUE INDEX|INDEX|TRIGGER) (\w+)/i);
      if(create){
        if(!names.has(create[2]))plan.push(statement.replace(/^CREATE (TABLE|UNIQUE INDEX|INDEX|TRIGGER) /i,'CREATE $1 IF NOT EXISTS '));
      }else if(/^PRAGMA foreign_keys/i.test(statement)){
        // D1 已启用外键；保留完整事务，不在请求内切换约束。
      }else if(name==='0005_sync_settings.sql'&&/^INSERT INTO sync_settings /i.test(statement)){
        if(!hasSettings)plan.push(statement.replace('INSERT INTO sync_settings','INSERT OR IGNORE INTO sync_settings(id,file_extensions,include_extensionless,revision,updated)'));
      }else if(name==='0007_excluded_directories.sql'){
        if(missingColumn)plan.push(statement);
      }else if(name==='0003_permanent_shares.sql'){
        if(!applied.has(name))plan.push(statement);
      }else{
        throw new Error(`Unsupported runtime migration: ${name}`);
      }
    }
  }
  const pending=migrations.map(migration=>migration.name).filter(name=>!applied.has(name));
  if(!names.has('d1_migrations'))plan.push('CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
  // 与 Wrangler 共用迁移记录，之后正常部署不会重复建表或重复增加字段。
  if(pending.length)plan.push(`INSERT OR IGNORE INTO d1_migrations(name) VALUES ${pending.map(name=>`('${name}')`).join(',')}`);
  return plan;
}
