// 空间文件树与记录视图，编辑器及版本处理保持独立。
import { $, api, send, esc, time, badge, on, form, toast, ownerOptions, table, empty, setUnsaved } from '../ui.js';
import { openEditor } from './file-editor.js';
import { showConflicts } from './revisions.js';
export async function hashBytes(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join(''); }
export async function putFile(base, bytes) { const hash=await hashBytes(bytes);await api(`${base}/blobs/${hash}`,{method:'PUT',body:bytes});return {hash,size:bytes.byteLength}; }
export async function filesPage({data}) {
  const owners=ownerOptions(data.users);const requested=new URLSearchParams(location.hash.split('?')[1]).get('owner');
  let owner=owners.some(o=>o.value===requested)?requested:(data.users[0]?.id||'public');let rows=[];let selected;let dirty=false;let view='files';let deleted=false;let filter='';
  $('#page').innerHTML=`<div class="page-heading"><div><div class="eyebrow">LIBRARY</div><h1>爬虫与本地资源</h1><p>文件按人物同步到设备的本地资源目录；公共库可按需复制。</p></div><select id="owner" aria-label="选择空间">${owners.map(o=>`<option value="${o.value}" ${owner===o.value?'selected':''}>${esc(o.label)}</option>`).join('')}</select></div><div class="library-tabs"><button id="files-tab" class="active">文件资源</button><button id="records-tab">用户记录</button><button id="conflicts">冲突候选</button><label class="check"><input id="trash" type="checkbox"> 查看回收站</label></div><section class="library"><aside class="file-pane"><div class="file-tools"><input id="filter" placeholder="筛选名称…" aria-label="筛选文件"><div><button id="new-file">＋ 文件</button><button id="new-dir">＋ 目录</button><button id="upload">上传</button></div></div><div id="tree"></div><div class="file-pane-bottom" id="library-count"></div></aside><div id="editor">${empty('选择文件，开始整理','支持脚本、配置与普通文件，单文件最大 1.5 MiB。')}</div></section><input type="file" id="upload-input" hidden>`;
  const base=()=>`/api/admin/spaces/${owner}`;
  const warn=()=>!dirty||window.confirm('当前内容尚未保存，放弃修改吗？');
  const refresh=async()=>{rows=(await api(`${base()}/entities`)).items;renderTree();if(selected){selected=rows.find(r=>r.id===selected.id);if(selected)await edit(selected);}};
  const edit=async row=>{selected=row;dirty=false;setUnsaved(false);renderTree();await openEditor({row,rows,base:base(),refresh,users:data.users,onDirty:value=>{dirty=value;setUnsaved(value);}});};
  function renderTree(){
    const list=rows.filter(r=>(view==='files'?r.path:!r.path)&&!!r.deleted===deleted&&String(r.path||r.data.key).toLowerCase().includes(filter.toLowerCase()));
    $('#tree').innerHTML=list.length?list.map(r=>`<button class="tree-row depth-${Math.min((r.path?.split('/').length||1)-1,5)} ${selected?.id===r.id?'selected':''}" data-file="${r.id}"><span class="file-icon">${r.kind==='directory'?'▰':r.kind==='file'?'▤':'◷'}</span><span>${esc(r.path?.split('/').pop()||r.data.title||r.data.key)}</span>${!r.enabled?'<i>停用</i>':''}</button>`).join(''):empty(deleted?'回收站为空':'这里还没有内容',view==='files'?'新建目录或上传第一个文件。':'设备同步后，历史、进度和搜索会出现在这里。');
    $('#library-count').textContent=`${list.length} 项 · ${owners.find(o=>o.value===owner).label}`;
    for(const r of list)on(`[data-file="${r.id}"]`,'click',async()=>{if(warn())await edit(r);});
  }
  on('#owner','change',async e=>{if(!warn()){e.target.value=owner;return;}owner=e.target.value;selected=null;dirty=false;setUnsaved(false);$('#editor').innerHTML=empty('选择文件，开始整理');await refresh();});
  on('#filter','input',e=>{filter=e.target.value;renderTree();});
  on('#trash','change',e=>{deleted=e.target.checked;renderTree();});
  for(const [selector,type] of [['#files-tab','files'],['#records-tab','records']])on(selector,'click',()=>{view=type;$('#files-tab').classList.toggle('active',type==='files');$('#records-tab').classList.toggle('active',type==='records');renderTree();});
  const create=async(kind,file)=>{
    const parent=selected?.kind==='directory'?selected.path:selected?.path?.split('/').slice(0,-1).join('/')||'';
    const input=await form(kind==='directory'?'新建目录 / 线路':file?'上传文件':'新建文件',[{name:'path',label:'相对路径',value:parent?`${parent}/${file?.name||''}`:file?.name||'',hint:'使用 / 分隔目录，父目录需要先创建。'}],'创建');if(!input)return;
    const payload=kind==='file'?await putFile(base(),file?await file.arrayBuffer():new TextEncoder().encode('')):{};
    const result=await send(`${base()}/commit`,{opId:crypto.randomUUID(),patch:{id:crypto.randomUUID(),kind,path:input.path,baseVersion:0,data:payload}});selected=result.items[0];await refresh();toast('已创建');
  };
  on('#new-file','click',()=>create('file'));on('#new-dir','click',()=>create('directory'));on('#upload','click',()=>$('#upload-input').click());
  on('#upload-input','change',async e=>{const file=e.target.files[0];if(file){if(file.size>1572864)throw new Error('文件不能超过 1.5 MiB');await create('file',file);}e.target.value='';});
  on('#conflicts','click',()=>showConflicts(base(),rows,refresh));
  await refresh();
}
