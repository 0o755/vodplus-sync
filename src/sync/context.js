// 提交前的同一数据库快照；普通文件仅取路径元数据，不重复搬运所有用户记录。
import { stmt, decode } from '../lib/db.js';
import { settingsValue } from './settings.js';
export async function readCommitContext(env, owner, patch) {
  const statements = [
    stmt(env, 'SELECT COALESCE(MAX(seq),0) value FROM changes WHERE owner=?', owner),
    stmt(env, 'SELECT * FROM entities WHERE owner=? AND id=?', owner, patch.id)
  ];
  const files = patch.kind === 'file' || patch.kind === 'directory';
  if (files) statements.push(stmt(env, patch.kind === 'directory'
    ? 'SELECT * FROM entities WHERE owner=? AND path IS NOT NULL ORDER BY path,id'
    : 'SELECT id,kind,path,version,deleted,enabled FROM entities WHERE owner=? AND path IS NOT NULL ORDER BY path,id', owner));
  let countIndex; let policyIndex;
  if (patch.baseVersion === 0) { countIndex = statements.length; statements.push(stmt(env, 'SELECT COUNT(*) total FROM entities WHERE owner=?', owner)); }
  if (files && owner !== 'public') { policyIndex = statements.length; statements.push(stmt(env, 'SELECT * FROM sync_settings WHERE id=1')); }
  const results = await env.DB.batch(statements);
  return {
    checkpoint: results[0].results[0].value,
    current: decode(results[1].results[0]),
    rows: files ? results[2].results.map(row => row.data === undefined ? row : decode(row)) : [],
    total: countIndex === undefined ? 0 : results[countIndex].results[0].total,
    policy: policyIndex === undefined ? null : settingsValue(results[policyIndex].results[0])
  };
}
