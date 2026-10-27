/** Copy clean, reusable source to an empty folder without hosted identity or Git history. */
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, copyFile, chmod, stat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const destination=path.resolve(process.argv[2]||path.join(root,'outputs','github'));
const relative=path.relative(root,destination);
if(!relative || (!relative.startsWith('..'+path.sep) && !path.isAbsolute(relative) && !relative.startsWith('outputs'+path.sep))) {
  throw new Error('Choose an empty directory outside the project, or below outputs/.');
}
await mkdir(destination,{recursive:true});
if((await readdir(destination)).length) throw new Error('The export directory must be empty. Existing files were left unchanged.');
const files=[...new Set(execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))];
const forbidden=new Set(['.git','.wrangler','.sites-runtime','.next','.vinext','node_modules','dist','outputs']);
let copied=0;
for(const file of files){
  const parts=file.split('/');
  if(parts.some(part=>forbidden.has(part))||parts.some(part=>/^\.env(?:\.|$)|^\.dev\.vars(?:\.|$)/.test(part))) continue;
  if(file==='.openai/hosting.json')continue;
  const src=path.join(root,file),out=path.join(destination,file);
  const info=await stat(src);if(!info.isFile())continue;
  await mkdir(path.dirname(out),{recursive:true});await copyFile(src,out);await chmod(out,info.mode&0o777);copied++;
}
const hosting=JSON.parse(await readFile(path.join(root,'.openai','hosting.json'),'utf8'));
delete hosting.project_id;
await mkdir(path.join(destination,'.openai'),{recursive:true});
await writeFile(path.join(destination,'.openai','hosting.json'),JSON.stringify(hosting,null,2)+'\n');
console.log(JSON.stringify({directory:destination,sourceFiles:copied+1,hostedIdentityIncluded:false,gitHistoryIncluded:false}));
