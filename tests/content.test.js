// 不绑定 R2，验证 1.5 MiB 二进制文件、中文跨块、空文件及内容去重。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createHarness, digest } from './harness.js';
let h,owner,device;
before(async()=>{h=await createHarness();owner=await h.createUser('D1文件测试');device=await h.bind(owner,'D1文件测试');});
after(async()=>h?.dispose());
async function roundtrip(bytes,path){
  const hash=digest(bytes);const fileId=crypto.randomUUID();
  const upload=await h.request(`/api/sync/blobs/${hash}`,{method:'PUT',token:device.token,raw:bytes});assert.equal(upload.status,200);
  const result=await h.request('/api/sync/commit',{method:'POST',token:device.token,data:{opId:crypto.randomUUID(),patch:{id:fileId,kind:'file',path,baseVersion:0,data:{hash,size:bytes.length}}}});assert.equal(result.status,200);
  const response=await h.mf.dispatchFetch(`http://localhost/api/sync/files/${fileId}`,{headers:{authorization:`Bearer ${device.token}`}});
  assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  return {hash,fileId};
}
test('完整上传并下载 1.5 MiB 随机二进制，数据库各块低于行限制',async()=>{
  const {hash}=await roundtrip(randomBytes(1572864),'binary.jar');
  const result=await h.db.prepare('SELECT COUNT(*) parts, MAX(length(content)) largest FROM file_chunks WHERE owner=? AND hash=?').bind(owner,hash).first();
  assert.equal(result.parts,8);assert.equal(result.largest,262144);
});
test('中文 UTF-8 跨块和空文件保持逐字节一致',async()=>{
  await roundtrip(Buffer.from('中文配置与爬虫🧩\n'.repeat(15000)),'unicode.txt');await roundtrip(Buffer.alloc(0),'empty.txt');
});
test('重复上传只存一份，同摘要不能借用另一人物的内容',async()=>{
  const bytes=Buffer.from('repeated-content');const {hash}=await roundtrip(bytes,'original.txt');
  for(let n=0;n<2;n++)assert.equal((await h.request(`/api/sync/blobs/${hash}`,{method:'PUT',token:device.token,raw:bytes})).status,200);
  assert.equal((await h.db.prepare('SELECT COUNT(*) count FROM file_contents WHERE owner=? AND hash=?').bind(owner,hash).first()).count,1);
  const other=await h.createUser('另一个人物');const binding=await h.bind(other,'另一个人物');
  const result=await h.request('/api/sync/commit',{method:'POST',token:binding.token,data:{opId:crypto.randomUUID(),patch:{id:crypto.randomUUID(),kind:'file',path:'other.txt',baseVersion:0,data:{hash,size:bytes.length}}}});assert.equal(result.status,400);
});
