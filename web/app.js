// 页面壳与管理员登录；具体功能放在 pages 目录。
import { $, api, send, esc, on, toast, canLeave, setUnsaved } from './ui.js';
import { overview } from './pages/overview.js';
import { usersPage, devicesPage } from './pages/people.js';
import { filesPage } from './pages/files.js';
const nav = [['overview','概览','◫'],['users','用户管理','◎'],['files','爬虫管理','▤'],['devices','设备管理','▣']];
let active = 'overview'; let data;
async function login() {
  const status = await api('/api/status'); const setup = !status.initialized;
  $('#app').innerHTML = `<main class="auth"><div class="wordmark"><b>V</b> VodPlus <span>SYNC</span></div><h1>${setup ? '建立你的同步空间' : '欢迎回来'}</h1><p>${setup ? '使用部署时设置的初始化密钥创建管理员。' : '管理家人的资源与设备，让每一次更新有迹可循。'}</p><form id="login-form">${setup ? '<label>初始化密钥<input name="secret" type="password" required autocomplete="off"></label>' : ''}<label>管理员账号<input name="username" required autocomplete="username"></label><label>密码<input name="password" type="password" minlength="12" required autocomplete="${setup ? 'new-password':'current-password'}"></label><p id="login-error" class="error-text" role="alert"></p><button class="primary" ${setup && !status.setupAvailable ? 'disabled' : ''}>${setup ? '创建管理员' : '登录后台'}</button></form><small>${setup && !status.setupAvailable ? '请先在 Cloudflare Secrets 设置 BOOTSTRAP_SECRET（至少 32 位随机字符）。' : '人物档案与管理员账号分别管理。'}</small></main>`;
  on('#login-form','submit',async e => { e.preventDefault(); const button=e.target.querySelector('button');button.disabled=true;
    try { await send(setup ? '/api/setup' : '/api/login', Object.fromEntries(new FormData(e.target))); await load(); }
    catch(error){ $('#login-error').textContent=error.message; button.disabled=false; }
  });
}
async function load() {
  try { data = await api('/api/admin/overview'); await render(); }
  catch (error) { if(error.status===401) return login(); throw error; }
}
async function render() {
  setUnsaved(false);
  $('#app').innerHTML = `<aside class="sidebar"><a class="wordmark" href="#overview"><b>V</b> VodPlus <span>SYNC</span></a><div class="workspace-label">家庭工作空间</div><nav>${nav.map(([key,label,icon])=>`<a href="#${key}" ${active===key?'aria-current="page"':''}><span>${icon}</span>${label}</a>`).join('')}</nav><div class="sidebar-bottom"><span class="status-dot"></span> 按需同步 · 私有空间<small>Workers / D1</small><button id="logout" class="text-button">退出登录 ↗</button></div></aside><main class="workspace"><header class="topbar"><span>工作空间 <i>/</i> ${nav.find(n=>n[0]===active)[1]}</span><div><span class="admin-label">管理员</span><span class="avatar">管</span></div></header><div id="page"></div><footer>VodPlus Sync <span>每个人的数据，各自保存。</span></footer></main>`;
  on('#logout','click',async()=>{await send('/api/logout');await login();});
  document.querySelectorAll('a[href^="#"]').forEach(link=>link.addEventListener('click',event=>{if(!canLeave())event.preventDefault();}));
  const context = {data,reload:load};
  await ({overview,users:usersPage,devices:devicesPage,files:filesPage}[active])(context);
}
window.addEventListener('hashchange',()=>{ const key=location.hash.slice(1).split('?')[0]; if(nav.some(n=>n[0]===key)){active=key;load().catch(e=>toast(e.message,true));} });
active=nav.some(n=>n[0]===location.hash.slice(1).split('?')[0])?location.hash.slice(1).split('?')[0]:'overview';
load().catch(error=>{ $('#app').innerHTML=`<main class="auth"><h1>暂时无法连接</h1><p>${esc(error.message)}</p><button id="retry">重试</button></main>`;on('#retry','click',load); });
