// D1 内容存储层：按人物和摘要隔离，整文件事务写入，复用相同内容。
import { one, all, stmt } from '../lib/db.js';
import { assert } from '../lib/http.js';

const CHUNK_SIZE = 192 * 1024;
export const contentInfo = (env, owner, hash) => one(env, 'SELECT size FROM file_contents WHERE owner=? AND hash=?', owner, hash);
function encode(bytes) {
  const strings = [];
  for (let offset = 0; offset < bytes.length; offset += 16384) strings.push(String.fromCharCode(...bytes.subarray(offset, offset + 16384)));
  return btoa(strings.join(''));
}
export async function putContent(env, owner, hash, input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  assert(bytes.length <= 1572864, 413, '文件超过 1.5 MiB');
  const existing = await contentInfo(env, owner, hash);
  if (existing) { assert(existing.size === bytes.length, 409, '已有内容大小不一致'); return; }
  const batch = [stmt(env, 'INSERT OR IGNORE INTO file_contents(owner,hash,size,created) VALUES(?,?,?,?)', owner, hash, bytes.length, Date.now())];
  for (let offset = 0, part = 0; offset < bytes.length; offset += CHUNK_SIZE, part++) {
    batch.push(stmt(env, 'INSERT OR IGNORE INTO file_chunks(owner,hash,part,content) VALUES(?,?,?,?)', owner, hash, part, encode(bytes.subarray(offset, offset + CHUNK_SIZE))));
  }
  // 元信息和全部内容在同一事务中可见，不会发布半个文件。
  await env.DB.batch(batch);
}
export async function getContent(env, owner, hash) {
  // 一次读取元信息和内容，空文件通过 LEFT JOIN 保留元信息。
  const rows = await all(env, 'SELECT f.size,c.part,c.content FROM file_contents f LEFT JOIN file_chunks c ON c.owner=f.owner AND c.hash=f.hash WHERE f.owner=? AND f.hash=? ORDER BY c.part', owner, hash);
  if (!rows.length) return null;
  const info = rows[0]; const chunks = rows.filter(row => row.part !== null);
  assert(chunks.length === Math.ceil(info.size / CHUNK_SIZE), 500, '文件内容不完整');
  const bytes = new Uint8Array(info.size); let offset = 0;
  for (const [index, chunk] of chunks.entries()) {
    assert(chunk.part === index, 500, '文件片段顺序异常');
    const decoded = atob(chunk.content);
    assert(decoded.length === Math.min(CHUNK_SIZE, info.size - offset), 500, '文件片段大小异常');
    for (let i = 0; i < decoded.length; i++) bytes[offset++] = decoded.charCodeAt(i);
  }
  return { size: info.size, body: bytes, text: async () => new TextDecoder().decode(bytes) };
}
export async function copyContent(env, source, target, hash) {
  assert(await contentInfo(env, source, hash), 404, '源文件内容不存在');
  // 在数据库内复制，避免把公共文件反复下载、编码、上传。
  await env.DB.batch([
    stmt(env, 'INSERT OR IGNORE INTO file_contents(owner,hash,size,created) SELECT ?,hash,size,? FROM file_contents WHERE owner=? AND hash=?', target, Date.now(), source, hash),
    stmt(env, 'INSERT OR IGNORE INTO file_chunks(owner,hash,part,content) SELECT ?,hash,part,content FROM file_chunks WHERE owner=? AND hash=?', target, source, hash)
  ]);
}
