// 仅清理过期凭证与短期运行日志，保留回执、墓碑及文件内容以支持离线设备。
export async function maintenance(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires<?').bind(now),
    env.DB.prepare('DELETE FROM bindings WHERE expires<?').bind(now),
    env.DB.prepare('DELETE FROM share_tokens WHERE expires<?').bind(now),
    env.DB.prepare('DELETE FROM rate_limits WHERE expires<?').bind(now),
    env.DB.prepare('DELETE FROM events WHERE created<?').bind(now - 30 * 86400000)
  ]);
}
