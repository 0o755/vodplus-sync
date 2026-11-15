// Workers Builds 先完成资源配置，再按绑定名迁移，最后发布服务。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
for(const args of [['d1','migrations','apply','DB','--remote'],['deploy']]){
  const result=spawnSync(process.execPath,[cli,...args],{stdio:'inherit',shell:false,windowsHide:true});
  if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);
}
