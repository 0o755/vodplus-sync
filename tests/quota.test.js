// 数百项目恢复应按规模线性读取，避免联查重复扫描耗尽每日额度。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,digest} from './harness.js';
import {restore} from '../src/generic/restore.js';
import {measuredDatabase} from './query-metrics.js';

for(const count of [500,1000])test(`${count} 项恢复避免平方级扫描，无变化时只读取紧凑状态`,async()=>{
  const h=await createHarness();try{
    const owner=await h.createUser('行读取测试'),bound=await h.bind(owner),device={id:bound.deviceId,user_id:owner};
    const items=[...Array.from({length:count*0.8},(_,i)=>({id:'file_'+String(i).padStart(8,'0'),kind:'file',path:`files/file${i}.py`,data:JSON.stringify({hash:digest('file '+i),size:5})})),
      ...Array.from({length:count*0.2},(_,i)=>({id:'record_'+digest(JSON.stringify(['quota.notes',String(i)])),kind:'record',path:null,data:JSON.stringify({namespace:'quota.notes',key:String(i),value:{text:String(i)}})}))];
    await h.db.prepare(`INSERT INTO entities(owner,id,kind,path,version,data,deleted,enabled,source,updated) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.kind'),json_extract(value,'$.path'),1,json_extract(value,'$.data'),0,1,'fixture',1 FROM json_each(?)`).bind(owner,JSON.stringify(items)).run();
    const meter=measuredDatabase(h.db),env={DB:meter.DB};
    const session=await (await restore(env,device,{action:'start',requestId:crypto.randomUUID(),scope:{namespaces:['quota.notes'],files:true}})).json();
    let page=session.page;while(page){const result=await (await restore(env,device,{action:'page',session:session.session,page})).json();page=result.next;}
    const before=meter.summary();await restore(env,device,{action:'ack',session:session.session});
    const after=meter.summary();
    const costly=meter.queries.find(q=>q.sql.startsWith('INSERT OR REPLACE INTO device_contents')).sql;
    const params=[device.id,owner,session.session,session.session];
    const plan=(await h.db.prepare('EXPLAIN QUERY PLAN '+costly).bind(...params,...params,...params).all()).results;
    assert.ok(plan.some(row=>/entity_record_lookup.*owner=\? AND <expr>=\? AND <expr>=\?/.test(row.detail)),'记录联查必须同时命中分区与记录键');
    assert.ok(after.read<count*30,`读取 ${after.read} 行，${count} 个项目不应产生平方级扫描`);
    // 已确认的历史空会话也不能使新一次确认退化为线性扫描。
    await h.db.prepare(`INSERT INTO restore_sessions(token,owner,device,request_id,fingerprint,scope_hash,scope,mode,policy,created,expires,acknowledged)
      SELECT 'past-'||j.value,owner,device,'past-'||j.value,fingerprint,scope_hash,scope,mode,policy,created,expires,1
      FROM restore_sessions,json_each(?) j WHERE token=?`).bind(JSON.stringify(Array.from({length:100},(_,i)=>i)),session.session).run();
    meter.queries.length=0;
    const repeated=await (await restore(env,device,{action:'start',requestId:crypto.randomUUID(),scope:{namespaces:['quota.notes'],files:true}})).json();
    assert.equal(repeated.total,0);await restore(env,device,{action:'ack',session:repeated.session});
    const unchanged=meter.summary();assert.ok(unchanged.read<=30,`无变化恢复读取 ${unchanged.read} 行`);assert.ok(unchanged.written<=10,`无变化恢复写入 ${unchanged.written} 行`);
    console.log(JSON.stringify({items:count,firstRestore:after,unchangedRestore:unchanged,confirmationRead:after.read-before.read}));
  }finally{await h.dispose();}
});
