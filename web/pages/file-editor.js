// 文件详情与修改操作；二进制内容不进入文本编辑器。
import { $, api, send, esc, time, badge, empty, on, form, confirm, toast } from '../ui.js';
import { putFile } from './files.js';
import { showVersions } from './revisions.js';
export async function openEditor({row,rows,base,refresh,users,onDirty}) {
  const isFile=row.kind==='file';const isDir=row.kind==='directory';
  $('#editor').innerHTML=`<div class="editor-heading"><div><h2>${esc(row.path||row.data.title||row.data.key)}</h2><span class="mono">v${row.version}</span> ${badge(row.deleted?'已删除':row.enabled?'已启用':'已停用',row.enabled&&!row.deleted?'green':'')}</div><div class="actions">${!isDir&&!row.deleted?'<button class="primary" id="save">保存修改</button>':''}</div></div><div class="editor-actions"><button id="rename" ${row.deleted||!row.path?'disabled':''}>重命名 / 移动</button><button id="enable" ${row.deleted?'disabled':''}>${row.enabled?'停用':'启用'}</button><button id="versions">历史版本</button><button id="delete" class="danger">${row.deleted?'恢复':'移入回收站'}</button>${isFile?`<a class="button" href="${base}/files/${row.id}" download="${esc(row.path.split('/').pop())}">下载</a>`:''}</div><div id="editor-content" class="editor-content">${isDir?empty('目录 / 线路','移动目录会同时更新子项路径；停用目录后，其子项也不参与发布和扫描。'):'<div class="loading">读取内容…</div>'}</div><div class="editor-status"><span>${esc(row.source.startsWith('admin')?'管理后台':'设备修改')} · ${time(row.updated)}</span><span>${isFile?`${(row.data.size/1024).toFixed(1)} KB`:`${isDir?rows.filter(r=>r.path?.startsWith(row.path+'/')).length+' 个子项':row.kind}`}</span></div>`;
  let original='';let editable=false;
  if(isFile && base.endsWith('/public') && !row.deleted){
    const button=document.createElement('button');button.id='copy-public';button.textContent='复制给用户';$('.editor-actions').append(button);
    on('#copy-public','click',async()=>{
      if(!users.length)throw new Error('请先创建用户');
      const input=await form('复制公共资源',[{name:'owner',label:'目标用户',type:'select',options:users.map(u=>({value:u.id,label:u.name}))},{name:'path',label:'目标相对路径',value:row.path.split('/').pop(),hint:'复制后独立维护，不会被公共库后续编辑覆盖。'}],'复制');
      if(input){await send('/api/admin/copy',{...input,fileId:row.id,sourceVersion:row.version,id:crypto.randomUUID(),opId:crypto.randomUUID()});toast('已复制到用户空间');}
    });
  }
  if(!isDir){
    if(isFile){const response=await api(`${base}/files/${row.id}`);const buffer=await response.arrayBuffer();try{original=new TextDecoder('utf-8',{fatal:true}).decode(buffer);editable=!original.includes('\0');}catch{editable=false;}}
    else{original=JSON.stringify(row.data,null,2);editable=true;}
    $('#editor-content').innerHTML=editable?`<textarea id="code" class="code" spellcheck="false" aria-label="文件内容" ${row.deleted?'readonly':''}>${esc(original)}</textarea>`:empty('二进制文件','可以下载、移动、停用与管理版本。');
    if(!editable&&$('#save'))$('#save').disabled=true;
    on('#code','input',()=>{onDirty($('#code').value!==original);if($('#save'))$('#save').textContent=$('#code').value===original?'保存修改':'保存修改 •';});
  }
  const commit=async patch=>{await send(`${base}/commit`,{opId:crypto.randomUUID(),restore:!!row.deleted,patch:{...row,baseVersion:row.version,...patch}});onDirty(false);await refresh();};
  on('#save','click',async()=>{let data;if(isFile)data=await putFile(base,new TextEncoder().encode($('#code').value),row.path);else{try{data=JSON.parse($('#code').value);}catch{throw new Error('记录 JSON 格式错误');}}await commit({data});toast('修改已保存，等待设备拉取');});
  on('#rename','click',async()=>{const input=await form('重命名 / 移动',[{name:'path',label:'新相对路径',value:row.path,hint:'文件 ID 保持不变；目标父目录需要已存在。'}]);if(input)await commit({path:input.path});});
  on('#enable','click',()=>commit({enabled:!row.enabled}));
  on('#delete','click',async()=>{if(await confirm(row.deleted?'恢复此项':'移入回收站',row.deleted?'恢复会生成新版本。删除目录的子项需要逐项恢复。':'设备下次同步会收到删除记录。旧内容可从回收站恢复。'))await commit({deleted:!row.deleted});});
  on('#versions','click',()=>showVersions(base,row,refresh));
}
