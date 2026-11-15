// Worker 总入口：路由鉴权、统一错误和后台静态资源。
import { Fault, assert, json, secure } from './lib/http.js';
import { admin, authRoute, device } from './auth.js';
import { adminRoute } from './admin.js';
import { syncRoute } from './sync/routes.js';
import { manageShare, shareRoute } from './shares.js';
import { maintenance } from './maintenance.js';
import {adminDeviceConfigRoute,syncDeviceConfigRoute} from './devices/routes.js';

export default {
  async scheduled(_event, env) { await maintenance(env); },
  async fetch(request, env) {
    try {
      const url = new URL(request.url); let response = await authRoute(env, request, url.pathname);
      if (!response && url.pathname.startsWith('/api/admin/')) {
        await admin(env, request);
        response = await adminDeviceConfigRoute(env,request,url) || await adminRoute(env, request, url) || await manageShare(env, request, url);
      }
      if (!response && url.pathname.startsWith('/api/sync/')) {const current=await device(env,request);response=await syncDeviceConfigRoute(env,request,url,current)||await syncRoute(env,request,url,current);}
      if (!response && url.pathname.startsWith('/share/')) response = await shareRoute(env, request, url);
      if (!response) {
        assert(!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/share/'), 404, '接口不存在');
        assert(['GET','HEAD'].includes(request.method), 405, '请求方式不支持');
        const target = url.pathname.startsWith('/s/') ? new URL('/share.html', url) : url;
        response = await env.ASSETS.fetch(new Request(target, request));
      }
      return secure(response);
    } catch (error) {
      const status = error instanceof Fault ? error.status : 500;
      return secure(json({ error: status === 500 ? '服务暂时不可用，请检查数据库迁移和资源绑定' : error.message, detail: error.detail }, status, status === 503 && error.detail?.retryable ? { 'retry-after': '1' } : {}));
    }
  }
};
