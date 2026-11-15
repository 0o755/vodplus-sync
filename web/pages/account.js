// 账号操作独立于人物管理；不提供匿名重置接口。
import {$,api,send,form,esc,toast} from '../ui.js';
export async function showAccount(onSignedOut){
  const admin=await api('/api/admin/account');let reset=false;
  const pending=form('管理员账号',[
    {html:`<p>当前账号：<strong>${esc(admin.username)}</strong></p>`},
    {name:'currentPassword',label:'当前密码',type:'password',autocomplete:'current-password'},
    {name:'newPassword',label:'新密码',type:'password',min:5,hint:'至少 5 位。修改后所有后台登录会话都需要重新登录。'},
    {name:'repeatPassword',label:'再次输入新密码',type:'password',min:5},
    {html:'<div class="account-danger"><strong>恢复初始状态</strong><p>清空管理员、用户、设备、文件、历史和配置，重新从零开始。</p><button type="button" class="danger" id="open-reset">清空全部数据并重置</button></div>'}
  ],'修改密码',{submit:input=>{if(input.newPassword!==input.repeatPassword)throw new Error('两次输入的新密码不一致');return send('/api/admin/account/password',{currentPassword:input.currentPassword,newPassword:input.newPassword});}});
  $('#open-reset').onclick=()=>{reset=true;$('#modal').close('cancel');};
  const result=await pending;
  if(result){toast('密码已修改，请重新登录');await onSignedOut();}
  if(reset)await showReset(onSignedOut);
}
async function showReset(onSignedOut){
  const result=await form('清空全部数据并重置',[
    {html:'<p class="error-text">将删除全部管理员、用户、设备授权、文件及历史版本、分享接口、同步记录和自定义规则。此操作不能从后台撤销。</p>'},
    {name:'currentPassword',label:'当前管理员密码',type:'password',autocomplete:'current-password'},
    {name:'confirmation',label:'输入 RESET 确认',placeholder:'RESET',hint:'完成后进入管理员初始化页，设备需要重新绑定。'}
  ],'确认清空全部数据',{submit:input=>send('/api/admin/account/reset',input)});
  if(result){toast('数据已清空，请创建新管理员');await onSignedOut();}
}
export async function showLoginHelp(){
  await form('账号与重置说明',[
    {html:'<p>重新部署会保留原 D1 数据。显示登录页表示数据库已有管理员，不会自动恢复为初始状态。</p><p>可在 Cloudflare 的 D1 控制台先查询账号：</p><textarea readonly rows="2">SELECT username FROM administrators;</textarea><p>如果忘记密码且确认要清空所有数据，先确认已部署包含恢复初始状态功能的版本，再在该 Worker 绑定的 D1 控制台执行：</p><textarea readonly rows="2">INSERT INTO maintenance_actions(action) VALUES(\'factory_reset\');</textarea><p class="error-text">这条命令会清空所有业务数据和管理员。执行前应先备份；完成后重新打开页面创建管理员。</p>'}
  ],'知道了');
}
