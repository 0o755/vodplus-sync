// 无依赖 UI 基础：转义、请求、表格与可访问的对话框。
export const $ = selector => document.querySelector(selector);
let unsaved = false;
export const setUnsaved = value => { unsaved = value; };
export const canLeave = () => !unsaved || window.confirm('当前内容尚未保存，放弃修改吗？');
window.addEventListener('beforeunload', event => { if(unsaved){event.preventDefault();event.returnValue='';} });
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
export const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未连接';
export const badge = (text, style = '') => `<span class="badge ${style}">${esc(text)}</span>`;
export const empty = (title, detail = '') => `<div class="empty"><span class="empty-mark">＋</span><strong>${esc(title)}</strong><p>${esc(detail)}</p></div>`;
export const table = (headers, rows) => `<div class="table-wrap"><table><thead><tr>${headers.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
export async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body && typeof options.body === 'string' ? { 'content-type':'application/json' } : {}), ...options.headers } });
  if (!response.ok) { const result = await response.json().catch(() => ({})); const error = new Error(result.error || `请求失败 ${response.status}`); error.detail = result.detail; error.status = response.status; throw error; }
  return response.headers.get('content-type')?.includes('application/json') ? response.json() : response;
}
export const send = (path, data = {}, method = 'POST') => api(path, { method, body: JSON.stringify(data) });
export function toast(message, error = false) { $('#toast').textContent = message; $('#toast').className = error ? 'show error' : 'show'; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').className = '', 4500); }
export function on(selector, event, action) {
  const element = $(selector); if (!element) return;
  element.addEventListener(event, async e => { try { await action(e); } catch (error) { toast(error.message, true); } });
}
export async function form(title, fields, action = '保存') {
  const modal = $('#modal');
  modal.innerHTML = `<form method="dialog"><div class="dialog-heading"><h2>${esc(title)}</h2><button value="cancel" class="icon-button" aria-label="关闭" formnovalidate>×</button></div><div class="dialog-body">${fields.map(f => f.html || `<label>${esc(f.label)}${f.type === 'select' ? `<select name="${f.name}">${f.options.map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>` : `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value || '')}" ${f.required === false ? '' : 'required'} ${f.min ? `minlength="${f.min}"` : ''} autocomplete="off">`}${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</label>`).join('')}</div><div class="dialog-footer"><button value="cancel" formnovalidate>取消</button><button class="primary" value="ok">${esc(action)}</button></div></form>`;
  modal.showModal();
  return new Promise(resolve => modal.addEventListener('close', () => resolve(modal.returnValue === 'ok' ? Object.fromEntries(new FormData(modal.querySelector('form'))) : null), { once:true }));
}
export async function confirm(title, message) { return !!await form(title, [{ html:`<p>${esc(message)}</p>` }], '确认'); }
export async function showSecret(title, value, hint) {
  await form(title, [{ html:`<p>${esc(hint)}</p><textarea readonly rows="4">${esc(value)}</textarea><small>选中内容复制；关闭后不会再显示该凭证。</small>` }], '完成');
}
export async function copy(text) { try { await navigator.clipboard.writeText(text); toast('已复制'); } catch { await showSecret('复制内容', text, '浏览器未允许自动复制，请手动复制。'); } }
export const ownerOptions = users => [{value:'public',label:'公共爬虫库'}, ...users.map(u => ({value:u.id,label:u.name}))];
