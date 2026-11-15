// 复现旧部署漏迁移、并发初始化与重置，所有清空仅作用于测试内存数据库。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHarness,digest} from './harness.js';
import {password} from '../src/lib/crypto.js';
import {MIGRATION_NAMES,repairPlan} from '../src/schema/plan.js';

const currentPassword='12345';
async function legacyData(h){
  const session='a'.repeat(64);const token='b'.repeat(64);const hash=digest('old file');
  await h.db.batch([
    h.db.prepare('INSERT INTO administrators VALUES(1,?,?)').bind('旧管理员',await password(currentPassword)),
    h.db.prepare('INSERT INTO sessions VALUES(?,?)').bind(digest(session),Date.now()+600000),
    h.db.prepare('INSERT INTO users VALUES(?,?,1,1)').bind('old-user','旧人物'),
    h.db.prepare('INSERT INTO devices(id,user_id,name,token_hash) VALUES(?,?,?,?)').bind('old-device','old-user','旧设备',digest(token)),
    h.db.prepare('INSERT INTO file_contents VALUES(?,?,?,1)').bind('old-user',hash,8),
    h.db.prepare('INSERT INTO file_chunks VALUES(?,?,0,?)').bind('old-user',hash,Buffer.from('old file').toString('base64'))
  ]);
  return {token,headers:{cookie:`vp_session=${session}`}};
}

test('旧库缺少 0005–0008 时首次访问自动补齐，原账号、文件与设备凭证继续可用',async()=>{
  const h=await createHarness({setup:false,migrations:4});try{
    const legacy=await legacyData(h);
    await h.db.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)').run();
    await h.db.batch(MIGRATION_NAMES.slice(0,4).map(name=>h.db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(name)));
    assert.equal((await h.request('/api/health')).status,503);
    const results=await Promise.all(Array.from({length:4},()=>h.request('/api/sync/settings',{token:legacy.token})));
    for(const result of results){assert.equal(result.status,200,JSON.stringify(result.value));assert.deepEqual(result.value.excludedDirectories,['_cache','__pycache__','pycache']);}
    assert.equal((await h.request('/api/health')).status,200);
    assert.equal((await h.request('/api/admin/account',legacy)).value.username,'旧管理员');
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM users').first()).n,1);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM file_contents').first()).n,1);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM file_chunks').first()).n,1);
    assert.deepEqual((await h.db.prepare('SELECT name FROM d1_migrations ORDER BY name').all()).results.map(row=>row.name),MIGRATION_NAMES);
    assert.equal((await h.db.prepare('SELECT revision FROM sync_settings').first()).revision,2);
    assert.equal((await h.request('/api/sync/device-config',{token:legacy.token})).status,200);
  }finally{await h.dispose();}
});

test('后台直接重置旧数据库，缺表不阻止清空且随后可新建管理员',async()=>{
  const h=await createHarness({setup:false,migrations:2});try{
    const legacy=await legacyData(h);
    const result=await h.request('/api/admin/account/reset',{method:'POST',headers:legacy.headers,data:{currentPassword,confirmation:'RESET'}});
    assert.equal(result.status,200,JSON.stringify(result.value));
    assert.equal((await h.request('/api/status')).value.initialized,false);
    for(const table of ['users','devices','file_contents','file_chunks','administrators','sessions'])assert.equal((await h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n,0);
    assert.equal((await h.request('/api/health')).status,200);
    assert.equal((await h.request('/api/setup',{method:'POST',data:{username:'new-admin',password:'54321'}})).status,200);
    assert.equal((await h.request('/api/sync/settings',{token:legacy.token})).status,401);
  }finally{await h.dispose();}
});

test('旧库自定义规则不会被补齐迁移覆盖，目录字段只增加一次',async()=>{
  const h=await createHarness({setup:false,migrations:6});try{
    await h.db.prepare('UPDATE sync_settings SET file_extensions=?,include_extensionless=0,revision=7,updated=42').bind('["custom"]').run();
    await h.request('/api/status');await h.request('/api/status');
    const settings=await h.db.prepare('SELECT * FROM sync_settings').first();
    assert.equal(settings.file_extensions,'["custom"]');assert.equal(settings.include_extensionless,0);assert.equal(settings.revision,8);assert.equal(settings.updated,42);
  }finally{await h.dispose();}
});

test('运行期间丢失重置表或同步规则行，重置仍重新检查并恢复默认状态',async()=>{
  const h=await createHarness();try{
    await h.createUser('待清空');
    await h.db.batch([h.db.prepare('DROP TABLE maintenance_actions'),h.db.prepare('DELETE FROM sync_settings')]);
    const result=await h.request('/api/admin/account/reset',{method:'POST',data:{currentPassword:'test-password-1234',confirmation:'RESET'}});
    assert.equal(result.status,200,JSON.stringify(result.value));assert.equal((await h.request('/api/status')).value.initialized,false);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM users').first()).n,0);
    assert.equal((await h.db.prepare('SELECT revision FROM sync_settings').first()).revision,1);
  }finally{await h.dispose();}
});

test('补齐失败时结构与迁移记录一起回滚，修复数据库异常后可以重试',async()=>{
  const h=await createHarness({setup:false,migrations:4});try{
    const legacy=await legacyData(h);
    await h.db.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)').run();
    await h.db.prepare("CREATE TRIGGER prevent_migration BEFORE INSERT ON d1_migrations BEGIN SELECT RAISE(ABORT,'test migration rollback'); END;").run();
    assert.equal((await h.request('/api/sync/settings',{token:legacy.token})).status,500);
    assert.equal(await h.db.prepare("SELECT name FROM sqlite_master WHERE name='sync_settings'").first(),null);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM d1_migrations').first()).n,0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM file_contents').first()).n,1);
    await h.db.prepare('DROP TRIGGER prevent_migration').run();
    assert.equal((await h.request('/api/sync/settings',{token:legacy.token})).status,200);
    assert.equal((await h.request('/api/health')).status,200);
  }finally{await h.dispose();}
});

test('完整结构且自定义排除目录存在时，补迁移记录不会重设规则或版本',async()=>{
  const h=await createHarness({setup:false});try{
    await h.db.prepare('UPDATE sync_settings SET excluded_directories=?,revision=12').bind('["private-cache"]').run();
    await h.request('/api/status');
    const settings=await h.db.prepare('SELECT * FROM sync_settings').first();
    assert.equal(settings.excluded_directories,'["private-cache"]');assert.equal(settings.revision,12);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM d1_migrations').first()).n,MIGRATION_NAMES.length);
  }finally{await h.dispose();}
});

test('空数据库可自动初始化，普通访问不会执行重置触发器内容',async()=>{
  const h=await createHarness({setup:false,migrations:0});try{
    assert.equal((await h.request('/api/status')).status,200);
    assert.equal((await h.request('/api/setup',{method:'POST',data:{username:'first-admin',password:currentPassword}})).status,200);
    assert.equal((await h.request('/api/status')).value.initialized,true);
    assert.equal((await h.request('/api/health')).status,200);
  }finally{await h.dispose();}
  const migrations=await Promise.all(MIGRATION_NAMES.map(async name=>({name,sql:await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')})));
  const plan=repairPlan(migrations,{names:new Set(),columns:new Set(),applied:new Set(),hasSettings:false});
  assert.ok(plan.every(sql=>!/^(DELETE|DROP)\b/i.test(sql)));
  assert.equal(plan.filter(sql=>sql.startsWith('CREATE TRIGGER')).length,4);
  assert.ok(plan.length<=45,'首次请求的迁移语句为正常路由保留 D1 查询额度');
});
