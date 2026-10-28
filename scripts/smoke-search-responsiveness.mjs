import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

// Measures React scheduling + debounce + a fixed 10 ms mock API, not disk or
// native-index latency. --baseline=<snapshot.tsx> loads an earlier SearchView at
// its original module URL, preserving its relative imports for an honest A/B.
const workspace = path.resolve(import.meta.dirname, "..");
const baselinePath = process.argv.find(value => value.startsWith("--baseline="))?.slice(11);
const baseline = baselinePath ? await readFile(path.resolve(baselinePath), "utf8") : undefined;
const temporaryRoot = path.join(workspace, ".test-tmp");
await mkdir(temporaryRoot, { recursive: true });
const fixture = await mkdtemp(path.join(temporaryRoot, "search-responsiveness-"));
const profile = path.join(fixture, "profile");
const browser = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find(existsSync);
assert(browser, "An existing Chrome/Edge installation is required");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, chrome, socket, id = 0;
const pending = new Map();
const errors = [];
const checks = [];
await writeFile(path.join(fixture, "index.html"), '<!doctype html><html lang="zh-CN" data-effect="calm"><head><meta charset="UTF-8"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
await writeFile(path.join(fixture, "fixture.jsx"), `
import React from "react";
import { createRoot } from "react-dom/client";
import "/src/styles.css";
import { api } from "/src/lib/api.ts";
import { setAppLanguage } from "/src/lib/i18n.ts";
import { SearchView } from "/src/views/SearchView.tsx";
setAppLanguage("zh-CN");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = window.__perf = { calls: [], sizeCalls: [], saves: 0, folders: false, indexListeners: new Set(), visible: true };
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state.visible ? "visible" : "hidden" });
window.__setVisible = value => { state.visible = value; document.dispatchEvent(new Event("visibilitychange")); };
Object.assign(api, {
  async getSearchWorkspace() { return undefined; },
  async saveSearchWorkspace() { state.saves++; },
  async listSearchBookmarks() { return []; },
  async listSearchBookmarkFolders() { return []; },
  onSearchIndexChanged(listener) { state.indexListeners.add(listener); return () => state.indexListeners.delete(listener); },
  async searchPage(query, filters) {
    state.calls.push({mode:"name",query,at:performance.now(),filters});
    if(state.deferNext) { state.deferNext=false; await new Promise(resolve=>{state.releaseSearch=resolve;}); }
    await sleep(10);
    const items = Array.from({length:state.folders?200:1},(_,i)=>({name:query+(state.folders?"-folder-"+i:".txt"),path:"E:\\\\fixture\\\\"+query+"-"+i,isDirectory:state.folders,size:1,score:1,source:"native-index"}));
    return {items,hasMore:false,totalMatches:items.length,generation:1};
  },
  async searchContentPage(query) {
    state.calls.push({mode:"content",query,at:performance.now()}); await sleep(10);
    return {items:[{name:query+".txt",path:"E:\\\\fixture\\\\"+query+".txt",preview:query,score:1}],hasMore:false,totalMatches:1,generation:1};
  },
  async chooseDirectory() { return "E:\\\\fixture"; },
  async contentIndexStatus(root) { return {state:"ready",root,filesVisited:1,filesIndexed:1}; },
  async directorySizes(paths) { state.sizeCalls.push({paths,at:performance.now()}); await sleep(10); return paths.map(path=>({path,bytes:50,files:1,directories:1,complete:true})); }
});
const root=createRoot(document.getElementById("root"));
window.__render = () => root.render(React.createElement("main", {className:"view-scroll",style:{height:"100vh",padding:24}}, React.createElement(SearchView,{indexer:{mode:"cached",state:"ready",entries:100000,progress:100,root:"*"},drives:[],onAnalyze:()=>{},onMigrate:()=>{},notify:(type,message)=>{if(type==="error")throw Error(message);}})));
window.__render();
window.__input = value => { const input=document.querySelector(".search-keyword-editor > input"); input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,value); input.dispatchEvent(new Event("input",{bubbles:true})); };
window.__measure = (query, content=false) => new Promise((resolve,reject) => {
  const selector=content?".content-result-main > strong":".result-name-cell > strong";
  const started=performance.now(); let finished=false;
  const observer=new MutationObserver(()=>{if(document.querySelector(selector)?.textContent===query+".txt")finish();});
  const timeout=setTimeout(()=>{observer.disconnect();reject(Error("Result did not render: "+query));},5000);
  function finish(){if(finished)return;finished=true;observer.disconnect();clearTimeout(timeout);requestAnimationFrame(()=>resolve(performance.now()-started));}
  observer.observe(document.getElementById("root"),{subtree:true,childList:true,characterData:true}); window.__input(query);
});
`);

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`Timed out: ${method}`)); }, 15_000);
    pending.set(requestId, {resolve: value => {clearTimeout(timer);resolve(value);},reject: reason=>{clearTimeout(timer);reject(reason);}});
    socket.send(JSON.stringify({id:requestId,method,params}));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {expression,returnByValue:true,awaitPromise:true});
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function until(expression) {
  for(let n=0;n<100;n++){if(await evaluate(expression))return;await wait(40);}
  throw Error(`Condition failed: ${expression}; ${JSON.stringify(errors)}`);
}
async function clickText(text) { await evaluate(`[...document.querySelectorAll("button")].find(button=>button.textContent.includes(${JSON.stringify(text)})).click()`); }
function statistics(samples) {
  const sorted=[...samples].sort((a,b)=>a-b);
  return {samples:sorted.length,p50Ms:Number(sorted[Math.floor(sorted.length*.5)].toFixed(1)),p95Ms:Number(sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)].toFixed(1))};
}

try {
  server = await createServer({configFile:false,root:workspace,plugins:baseline?[{name:"baseline-search-view",enforce:"pre",load(id){if(id.replaceAll("\\","/").split("?")[0].endsWith("/src/views/SearchView.tsx"))return baseline;}}]:[],server:{host:"127.0.0.1",port:0,watch:null},logLevel:"error"});
  await server.listen();
  chrome = spawn(browser,["--headless=new","--remote-debugging-port=0","--remote-allow-origins=*",`--user-data-dir=${profile}`,"--no-first-run","--disable-background-networking","--window-size=1440,1100","about:blank"],{stdio:"ignore",windowsHide:true,env:{...process.env,TEMP:fixture,TMP:fixture}});
  let port;
  for(let n=0;n<100&&!port;n++){try{port=Number((await readFile(path.join(profile,"DevToolsActivePort"),"utf8")).split("\n")[0]);}catch{await wait(100);}}
  assert(port);
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(pages.find(page=>page.type==="page").webSocketDebuggerUrl);
  await new Promise(resolve=>socket.addEventListener("open",resolve,{once:true}));
  socket.addEventListener("message",event=>{const message=JSON.parse(event.data);if(message.method==="Runtime.exceptionThrown")errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);const item=pending.get(message.id);if(item){pending.delete(message.id);message.error?item.reject(Error(message.error.message)):item.resolve(message.result);}});
  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate",{url:`http://127.0.0.1:${server.httpServer.address().port}/${path.relative(workspace,fixture).split(path.sep).join("/")}/index.html`});
  await until('!!document.querySelector(".search-keyword-editor > input")');
  await evaluate('window.__measure("warm-name")');
  const name=[]; for(let n=0;n<16;n++)name.push(await evaluate(`window.__measure("name-${n}")`));
  await clickText("内容搜索");
  await until('!!document.querySelector(".scope-actions .scope-button")');
  await evaluate('document.querySelector(".scope-actions .scope-button").click()');
  await evaluate('window.__measure("warm-content",true)');
  const content=[]; for(let n=0;n<16;n++)content.push(await evaluate(`window.__measure("content-${n}",true)`));
  const metrics={kind:baseline?"baseline":"current",apiDelayMs:10,name:statistics(name),content:statistics(content)};
  if(!baseline) {
    await clickText("名称搜索");
    await evaluate('window.__measure("before-burst")');
    await evaluate(`(async()=>{window.__perf.calls=[];for(const q of ["b","bu","bur","burst","burst-final"]){window.__input(q);await new Promise(r=>setTimeout(r,12));}})()`);
    await until('document.querySelector(".result-name-cell > strong")?.textContent==="burst-final.txt"');
    assert.deepEqual(await evaluate('window.__perf.calls.map(call=>call.query)'),["burst-final"]);
    checks.push("A rapid input burst requests only the final query");

    await evaluate('window.__perf.calls=[]; document.querySelector(".search-keyword-editor > input").dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true})); window.__input("zhong")');
    await wait(250);
    assert.equal(await evaluate('window.__perf.calls.length'),0,"No queries should run during IME composition");
    await evaluate('window.__input("中文"); document.querySelector(".search-keyword-editor > input").dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"中文"}))');
    await until('document.querySelector(".result-name-cell > strong")?.textContent==="中文.txt"');
    assert.deepEqual(await evaluate('window.__perf.calls.map(call=>call.query)'),["中文"]);
    checks.push("IME intermediate text does not query; committed text does");

    await evaluate('window.__setVisible(false)'); await wait(30);
    await evaluate('window.__perf.calls=[]; window.__perf.sizeCalls=[]; window.__input("hidden-query"); for(const listener of window.__perf.indexListeners)listener({generation:2})');
    await wait(1000);
    assert.equal(await evaluate('window.__perf.calls.length'),0,"Hidden search must not query");
    assert.equal(await evaluate('window.__perf.sizeCalls.length'),0,"Hidden search must not request folder sizes");
    await evaluate('window.__setVisible(true)');
    await until('document.querySelector(".result-name-cell > strong")?.textContent==="hidden-query.txt"');
    checks.push("Hidden input and index events remain quiet; showing the view refreshes results");

    await evaluate('window.__perf.deferNext=true; window.__input("stale-request")');
    await until('typeof window.__perf.releaseSearch === "function"');
    await evaluate('window.__input(""); window.__perf.releaseSearch()');
    await wait(200);
    assert.equal(await evaluate('document.querySelectorAll(".result-row").length'),0);
    checks.push("An old in-flight result cannot restore a cleared search");

    await evaluate('window.__perf.folders=true; window.__perf.sizeCalls=[]; window.__input("folders-one")');
    await until('document.querySelector(".result-name-cell > strong")?.textContent.includes("folders-one-folder")');
    await wait(300);
    assert.equal(await evaluate('window.__perf.sizeCalls.length'),0,"Folder walks should wait until input is idle");
    await evaluate('window.__input("folders-two")');
    await until('document.querySelector(".result-name-cell > strong")?.textContent.includes("folders-two-folder")');
    await wait(300);
    assert.equal(await evaluate('window.__perf.sizeCalls.length'),0,"Typing should postpone folder size work");
    await until('window.__perf.sizeCalls.length>0');
    assert(await evaluate('window.__perf.sizeCalls.every(call=>call.paths.length<=24)'),"Only a bounded visible batch should be sized");
    assert(await evaluate('window.__perf.sizeCalls.every(call=>call.paths.every(path=>path.includes("folders-two")))'),"Superseded folder results should not be sized");
    await evaluate('window.__setVisible(false)');await wait(40);
    const sizeCalls=await evaluate('window.__perf.sizeCalls.length');await wait(850);
    assert.equal(await evaluate('window.__perf.sizeCalls.length'),sizeCalls,"Hidden size work must not continue");
    checks.push("Folder sizing waits for idle input, follows visible results, and stops scheduling when hidden");
  }
  assert.deepEqual(errors,[]);
  await mkdir(path.join(workspace,".task-tmp"),{recursive:true});
  await writeFile(path.join(workspace,".task-tmp",`search-responsiveness-${metrics.kind}.json`),JSON.stringify({metrics,checks},null,2)+"\n");
  console.log(JSON.stringify({metrics,checks},null,2));
} finally {
  socket?.close();
  if(chrome&&chrome.exitCode===null){const exited=new Promise(resolve=>chrome.once("exit",resolve));chrome.kill();await Promise.race([exited,wait(3000)]);}
  await server?.close();
  const relative=path.relative(temporaryRoot,fixture);assert(relative&&!relative.startsWith("..")&&!path.isAbsolute(relative));
  await rm(fixture,{recursive:true,force:true,maxRetries:8,retryDelay:200});
}
