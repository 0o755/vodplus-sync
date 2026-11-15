// 密码通过 POST 换取有限期的只读链接，口令不持久化。
import {$,send,on,copy} from './ui.js';
const shareId=location.pathname.split('/')[2];
on('#unlock','submit',async e=>{e.preventDefault();$('#error').textContent='';try{const result=await send(`/share/${shareId}/auth`,Object.fromEntries(new FormData(e.target)));$('#url').value=result.url;$('#unlock').hidden=true;$('#result').hidden=false;e.target.reset();}catch(error){$('#error').textContent=error.message;}});
on('#copy','click',()=>copy($('#url').value));
