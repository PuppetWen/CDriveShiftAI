import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, lstat, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const workspace = path.resolve(import.meta.dirname, "..");
const base = path.join(workspace, ".test-tmp");
await mkdir(base, {recursive:true});
const fixture = await mkdtemp(path.join(base,"search-keywords-native-"));
const root = path.join(fixture,"files");
const state = path.join(fixture,"state");
await mkdir(root); await mkdir(state);
await mkdir(path.join(root,"alpha-beta-folder"));
await mkdir(path.join(root,"alpha-folder"));
await mkdir(path.join(root,"beta-folder"));
await writeFile(path.join(root,"alpha.txt"),"alpha alone");
await writeFile(path.join(root,"beta.txt"),"beta alone");
await writeFile(path.join(root,"unrelated.txt"),"unrelated content");
await writeFile(path.join(root,"alpha-beta.txt"),"alpha far apart from beta\n中文测试 文档内容");
const child=spawn(path.join(workspace,"native","indexer","target","release","cshift-indexer.exe"),["--serve"],{cwd:state,windowsHide:true,env:{...process.env,TEMP:fixture,TMP:fixture}});
const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
const events=[]; const pending=new Map(); let id=0;
child.stderr.on("data",chunk=>process.stderr.write(chunk));
lines.on("line",line=>{const message=JSON.parse(line);const request=pending.get(message.id);if(request){pending.delete(message.id);clearTimeout(request.timer);message.ok===false?request.reject(Error(message.error)):request.resolve(message);}else events.push(message);});
const request=payload=>new Promise((resolve,reject)=>{const requestId=++id;const timer=setTimeout(()=>{pending.delete(requestId);reject(Error(`Timeout: ${payload.op}`));},15000);pending.set(requestId,{resolve,reject,timer});child.stdin.write(`${JSON.stringify({id:requestId,...payload})}\n`);});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function ready(event){for(let n=0;n<200;n++){if(events.some(value=>value.event===event&&value.status.state==="ready"))return;await wait(50);}throw Error(`Index not ready: ${event}`);}
try {
  await request({op:"init",root,cachePath:path.join(state,"names.bin"),contentCacheDir:path.join(state,"content")});
  await ready("status");
  const query={op:"query",query:"alpha beta",keywords:["alpha","beta"],kind:"file",scope:root,sortBy:"name",sortDirection:"asc",limit:1};
  let page=await request({...query,keywordMatch:"all"});
  assert.equal(page.totalMatches,3); assert.equal(page.results[0].name,"alpha-beta.txt");
  assert(page.hasMore);
  const second=await request({...query,keywordMatch:"any",cursor:page.nextCursor});
  assert.equal(second.results[0].name,"alpha.txt");
  const third=await request({...query,cursor:second.nextCursor});
  assert.equal(third.results[0].name,"beta.txt"); assert.equal(third.hasMore,false);
  assert.equal(new Set([...page.results,...second.results,...third.results].map(item=>item.path)).size,3);
  assert.equal((await request({...query,kind:"folder",keywordMatch:"all"})).totalMatches,3);
  assert.equal((await request({...query,keywords:["alh","bta"],fuzzy:true,keywordMatch:"all"})).totalMatches,3);
  assert.equal((await request({...query,keywords:["^alpha","beta"],regex:true,keywordMatch:"all"})).totalMatches,3);
  assert.equal((await request({...query,wholeWord:true})).totalMatches,3);
  assert.equal((await request({...query,keywords:["alpha","missing-term"]})).totalMatches,2);
  await request({op:"contentIndex",scope:root}); await ready("contentStatus");
  const content={op:"contentQuery",scope:root,query:"alpha beta",keywords:["alpha","beta"],sortBy:"name",sortDirection:"asc",limit:1};
  page=await request({...content,keywordMatch:"all"});
  assert.equal(page.totalMatches,3); assert.equal(page.results[0].name,"alpha-beta.txt"); assert(page.hasMore);
  const contentSecond=await request({...content,cursor:page.nextCursor});
  const contentThird=await request({...content,cursor:contentSecond.nextCursor});
  assert.deepEqual([page.results[0].name,contentSecond.results[0].name,contentThird.results[0].name],["alpha-beta.txt","alpha.txt","beta.txt"]);
  assert.equal(contentThird.hasMore,false);
  assert.equal((await request({...content,keywords:["alpha.*apart","beta"],regex:true,keywordMatch:"all"})).totalMatches,2);
  assert.equal((await request({...content,keywords:["中文测试","文档内容"],keywordMatch:"all"})).totalMatches,1);
  assert.equal((await request({...content,keywords:["中文测试","missing-term"]})).totalMatches,1);
  console.log("PASS: files/folders/content always use OR, ignore old all preference, include single-term matches and deduplicate across global pages; fuzzy, whole-word, regex and Chinese pass");
  child.stdin.end(); await once(child,"exit");
} finally {
  lines.close();
  if(child.exitCode===null&&child.signalCode===null){const exited=once(child,"exit");child.kill();await exited;}
  assert.equal(path.dirname(path.resolve(fixture)),base);
  assert(path.basename(fixture).startsWith("search-keywords-native-")&&!(await lstat(fixture)).isSymbolicLink());
  await rm(fixture,{recursive:true,force:true,maxRetries:5});
}
