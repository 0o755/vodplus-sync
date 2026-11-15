// 通用手动同步参考 SDK：服务端管理版本和差异，调用方只负责自己的数据与本地 I/O。
export class SyncClient {
  constructor({server,token,fetch:transport=globalThis.fetch,onProgress=()=>{}}){
    this.server=server.replace(/\/$/,'');this.token=token;this.transport=transport;this.onProgress=onProgress;
  }
  async request(path,{method='POST',data,body,headers={}}={}){
    const response=await this.transport(this.server+'/api/v2/sync/'+path,{method,headers:{authorization:`Bearer ${this.token}`,...(data?{'content-type':'application/json'}:{}),...headers},body:data?JSON.stringify(data):body});
    if(!response.ok){
      let detail;try{detail=await response.json();}catch{}
      const error=new Error(detail?.error||`服务请求失败（HTTP ${response.status}）`);error.status=response.status;error.detail=detail?.detail;throw error;
    }
    return response;
  }
  async json(path,data){return (await this.request(path,{data})).json();}
  async pushRecords(namespace,upsert,remove=[]){return this.json('push',{requestId:crypto.randomUUID(),namespace,upsert,delete:remove});}
  async pushFile(path,content,session){
    return (await this.request('file?path='+encodeURIComponent(path),{method:'PUT',body:content,headers:{'content-type':'application/octet-stream','idempotency-key':crypto.randomUUID(),...(session?{'x-sync-session':session}:{})}})).json();
  }
  async deleteFile(path){return (await this.request('file?path='+encodeURIComponent(path),{method:'DELETE',headers:{'idempotency-key':crypto.randomUUID()}})).json();}

  async pushAll({scope,records=[],files=[]}){
    const session=await this.json('push',{action:'start',requestId:crypto.randomUUID(),scope});
    const progress={task:'push',records:0,files:0,skipped:0,done:false};let batch=[],space='',size=0;
    const flush=async()=>{
      if(!batch.length)return;
      await this.json('push',{requestId:crypto.randomUUID(),session:session.session,namespace:space,upsert:batch});
      progress.records+=batch.length;batch=[];size=0;this.onProgress({...progress});
    };
    for await(const item of records){
      const length=new TextEncoder().encode(JSON.stringify(item)).length;
      if(batch.length&&(space!==item.namespace||batch.length===50||size+length>100000))await flush();
      space=item.namespace;batch.push({key:item.key,value:item.value});size+=length;
    }
    await flush();
    for await(const file of files){
      const result=await this.pushFile(file.path,await file.read(),session.session);
      if(result.skipped)progress.skipped++;else progress.files++;this.onProgress({...progress});
    }
    // 任一读取或上传失败都会抛出异常，不能误执行清单缺失删除。
    await this.json('push',{action:'finish',session:session.session});this.onProgress({...progress,done:true});
  }

  async download({scope,full=false,beginFull=async()=>{},putData,deleteData,putFile,deleteFile}){
    const session=await this.json('restore',{action:'start',requestId:crypto.randomUUID(),scope,full});
    if(session.mode==='full')await beginFull(scope.namespaces);
    let page=session.page;const progress={task:'download',completed:0,total:session.total,done:false};this.onProgress({...progress});
    while(page){
      const packet=await this.json('restore',{action:'page',session:session.session,page});
      for(const item of packet.items){
        if(item.type==='data')await (item.op==='delete'?deleteData(item.namespace,item.key):putData(item.namespace,item.key,item.value));
        else if(item.op==='delete')await deleteFile(item.path);
        else {
          const response=await this.request('restore',{data:{action:'content',session:session.session,content:item.content}});
          const content=new Uint8Array(await response.arrayBuffer());
          if(content.length!==item.size)throw new Error('文件下载不完整，请重试');
          // putFile 应完整写入临时文件后替换目标；不比较本机版本或扫描差异。
          await putFile(item.path,content);
        }
        progress.completed++;this.onProgress({...progress});
      }
      page=packet.next;
    }
    await this.json('restore',{action:'ack',session:session.session});this.onProgress({...progress,done:true});
  }
}
