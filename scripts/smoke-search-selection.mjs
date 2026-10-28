import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

// Real Chromium input events against SearchView. Search APIs are deterministic
// fixtures; this test does not touch any user file, index, or app profile.
const workspace = path.resolve(import.meta.dirname, "..");
const temporaryRoot = path.join(workspace, ".test-tmp");
await mkdir(temporaryRoot, { recursive: true });
const fixture = await mkdtemp(path.join(temporaryRoot, "search-selection-"));
const profile = path.join(fixture, "profile");
const browser = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find(existsSync);
assert(browser, "An existing Chrome/Edge installation is required");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, chrome, socket, id = 0;
const pending = new Map();
const errors = [];
const consoleErrors = [];
const checks = [];
let stage = "boot";
await writeFile(path.join(fixture, "index.html"), '<!doctype html><html lang="zh-CN" data-effect="matrix"><head><meta charset="UTF-8"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
await writeFile(path.join(fixture, "fixture.jsx"), `
import React from "react";
import { createRoot } from "react-dom/client";
import "/src/styles.css";
import "/src/liquid-glass.css";
import { api } from "/src/lib/api.ts";
import { setAppLanguage } from "/src/lib/i18n.ts";
import { SearchView } from "/src/views/SearchView.tsx";
setAppLanguage("zh-CN");
const state=window.__selection={calls:[],opens:[],visible:true};
Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>state.visible?"visible":"hidden"});
window.__setVisible=value=>{state.visible=value;document.dispatchEvent(new Event("visibilitychange"));};
const items=Array.from({length:120},(_,index)=>({name:"item-"+String(index).padStart(3,"0")+".txt",path:"E:\\\\fixture\\\\item-"+index+".txt",isDirectory:false,size:10,score:1,source:"native-index",preview:"Fixture text " + index}));
Object.assign(api,{
  async getSearchWorkspace(){return undefined;},
  async saveSearchWorkspace(){},
  async listSearchBookmarks(){return [];},
  async listSearchBookmarkFolders(){return [];},
  async searchPage(query,filters){state.calls.push({query,filters});return {items,hasMore:false,totalMatches:items.length,generation:1};},
  async searchContentPage(query,scope,options){state.calls.push({query,scope,options});return {items,hasMore:false,totalMatches:items.length,generation:1};},
  async chooseDirectory(){return "E:\\\\fixture";},
  async contentIndexStatus(root){return {state:"ready",root,filesVisited:120,filesIndexed:120};},
  async openPath(path){state.opens.push(path);return {ok:true};}
});
createRoot(document.getElementById("root")).render(React.createElement("main",{className:"view-scroll",style:{height:"100vh",padding:24}},React.createElement(SearchView,{indexer:{mode:"cached",state:"ready",entries:120,progress:100,root:"*"},drives:[],onAnalyze:()=>{},onMigrate:()=>{},notify:(type,message)=>{if(type==="error")throw Error(message);}})));
window.__input=value=>{const input=document.querySelector(".search-keyword-editor > input");input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));};
`);
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`Timed out: ${method}`)); }, 15_000);
    pending.set(requestId, {resolve: value => {clearTimeout(timer);resolve(value);},reject: reason => {clearTimeout(timer);reject(reason);}});
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
const draft = ".search-keyword-editor > input";
async function input(value) { await evaluate(`window.__input(${JSON.stringify(value)})`); }
async function key(key, virtualKey, modifiers = 0) {
  await send("Input.dispatchKeyEvent",{type:"keyDown",key,code:key,windowsVirtualKeyCode:virtualKey,modifiers});
  await send("Input.dispatchKeyEvent",{type:"keyUp",key,code:key,windowsVirtualKeyCode:virtualKey,modifiers});
}
async function commit(value) {
  await input(value); await key("Enter",13);
  await until(`document.querySelector(${JSON.stringify(draft)}).value===""`);
  // Allow a paint between physical key sequences, as when typing. Chromium's
  // remote input can otherwise inject dozens of React updates in one frame.
  await wait(20);
}
async function chips() { return evaluate('[...document.querySelectorAll(".search-keyword-chip > button:first-child")].map(item=>item.textContent)'); }
async function selected() { return evaluate('[...document.querySelectorAll(".result-row.selected")].map(item=>item.querySelector(".result-name-cell > strong,.content-result-main > strong").textContent)'); }
async function rowPoint(index, fraction = .45) {
  return evaluate(`(()=>{const row=document.querySelectorAll(".result-row")[${index}];row.scrollIntoView({block:"nearest"});const box=row.getBoundingClientRect();return {x:box.left+box.width*${fraction},y:box.top+box.height/2};})()`);
}
async function click(index, modifiers = 0) {
  const point=await rowPoint(index);
  await send("Input.dispatchMouseEvent",{type:"mouseMoved",...point});
  await send("Input.dispatchMouseEvent",{type:"mousePressed",...point,button:"left",buttons:1,clickCount:1,modifiers});
  await send("Input.dispatchMouseEvent",{type:"mouseReleased",...point,button:"left",buttons:0,clickCount:1,modifiers});
  await wait(40);
}
async function dragRows(from,to,modifiers=0) {
  await evaluate('document.querySelector(".result-list").scrollTop=0');await wait(40);
  const start=await rowPoint(from,.36), end=await rowPoint(to,.60);
  await send("Input.dispatchMouseEvent",{type:"mouseMoved",...start});
  await send("Input.dispatchMouseEvent",{type:"mousePressed",...start,button:"left",buttons:1,clickCount:1,modifiers});
  for(let step=1;step<=8;step++) {
    await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:start.x+(end.x-start.x)*step/8,y:start.y+(end.y-start.y)*step/8,button:"left",buttons:1,modifiers});
    await wait(20);
  }
  assert(await evaluate('!!document.querySelector(".search-selection-marquee")'),"Dragging should show the selection rectangle");
  await send("Input.dispatchMouseEvent",{type:"mouseReleased",...end,button:"left",buttons:0,clickCount:1,modifiers});
  await wait(60);
  assert.equal(await evaluate('!!document.querySelector(".search-selection-marquee")'),false,"Rectangle should disappear when released");
}

try {
  server=await createServer({configFile:false,root:workspace,server:{host:"127.0.0.1",port:0,watch:null},logLevel:"error"});await server.listen();
  chrome=spawn(browser,["--headless=new","--remote-debugging-port=0","--remote-allow-origins=*",`--user-data-dir=${profile}`,"--no-first-run","--disable-background-networking","--window-size=1440,1200","about:blank"],{stdio:"ignore",windowsHide:true,env:{...process.env,TEMP:fixture,TMP:fixture}});
  let port;
  for(let n=0;n<100&&!port;n++){try{port=Number((await readFile(path.join(profile,"DevToolsActivePort"),"utf8")).split("\n")[0]);}catch{await wait(100);}}
  assert(port);
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(pages.find(page=>page.type==="page").webSocketDebuggerUrl);await new Promise(resolve=>socket.addEventListener("open",resolve,{once:true}));
  socket.addEventListener("message",event=>{const message=JSON.parse(event.data);if(message.method==="Runtime.exceptionThrown")errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);if(message.method==="Runtime.consoleAPICalled"&&["error","warning"].includes(message.params.type))consoleErrors.push({stage,args:message.params.args,stack:message.params.stackTrace});const item=pending.get(message.id);if(item){pending.delete(message.id);message.error?item.reject(Error(message.error.message)):item.resolve(message.result);}});
  await send("Runtime.enable");await send("Page.enable");
  await send("Page.navigate",{url:`http://127.0.0.1:${server.httpServer.address().port}/${path.relative(workspace,fixture).split(path.sep).join("/")}/index.html`});
  await until(`!!document.querySelector(${JSON.stringify(draft)})`);
  stage="keyboard-delete";
  assert.equal(await evaluate('document.querySelector(".search-keyword-hint").textContent'),"回车确认关键词，点击标签可编辑");
  for(const term of ["alpha","beta","gamma"])await commit(term);
  assert.deepEqual(await chips(),["alpha","beta","gamma"]);
  await key("Backspace",8);await until('document.querySelectorAll(".search-keyword-chip").length===2');
  assert.deepEqual(await chips(),["alpha","beta"]);
  await key("Delete",46);await until('document.querySelectorAll(".search-keyword-chip").length===1');
  assert.deepEqual(await chips(),["alpha"]);
  await input("xyz");await key("Backspace",8);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(draft)}).value`),"xy");
  assert.deepEqual(await chips(),["alpha"]);
  await evaluate(`document.querySelector(${JSON.stringify(draft)}).setSelectionRange(0,0)`);await key("Delete",46);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(draft)}).value`),"y");
  assert.deepEqual(await chips(),["alpha"]);
  await input("");
  await evaluate(`document.querySelector(${JSON.stringify(draft)}).dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}))`);
  await key("Backspace",8);await key("Delete",46);
  assert.deepEqual(await chips(),["alpha"],"IME editing must not delete committed tags");
  await evaluate(`document.querySelector(${JSON.stringify(draft)}).dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:""}))`);
  await key("Backspace",8);await until('document.querySelectorAll(".search-keyword-chip").length===0');
  for(let n=0;n<32;n++){stage=`32-keywords-${n}`;await commit(`term-${n}`);}
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(draft)}).disabled`),false,"A full tag input must stay focusable for deletion");
  await key("Backspace",8);await until('document.querySelectorAll(".search-keyword-chip").length===31');
  await key("Delete",46);await until('document.querySelectorAll(".search-keyword-chip").length===30');
  checks.push("Backspace/Delete remove whole previous tags, preserve text editing and IME, and work at the 32-keyword limit");
  stage="theme-focus";

  // Computed style checks all themes, including an edited chip input. The
  // distinction is themed focus feedback, rather than a hardcoded error ring.
  for(const theme of ["aurora","matrix","ember","calm","ivory"]) {
    await evaluate(`document.documentElement.dataset.effect=${JSON.stringify(theme)};document.querySelector(${JSON.stringify(draft)}).focus()`);
    await wait(200);
    const focus=await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(draft)}),wrap=document.querySelector(".search-input-wrap");return {outline:getComputedStyle(input).outlineStyle,shadow:getComputedStyle(wrap).boxShadow};})()`);
    assert.equal(focus.outline,"none",`${theme}: the text input should not acquire a separate error outline`);
    assert.notEqual(focus.shadow,"none",`${theme}: focus should be visible on the search surface`);
  }
  await evaluate('document.querySelector(".search-keyword-chip > button").click()');
  await until('!!document.querySelector(".search-keyword-chip input")');
  const chipFocus=await evaluate('(()=>{const input=document.querySelector(".search-keyword-chip input");return {outline:getComputedStyle(input).outlineStyle,shadow:getComputedStyle(input.closest(".search-keyword-chip")).boxShadow};})()');
  assert.equal(chipFocus.outline,"none");assert.notEqual(chipFocus.shadow,"none");
  await key("Enter",13);await input("");
  await evaluate('document.documentElement.dataset.effect="matrix"');
  checks.push("Draft and editable-chip focus use the themed glow in all five themes");

  await until('document.querySelectorAll(".result-row").length>=4');
  stage="name-selection";
  await click(0);await click(2,2);
  assert.deepEqual(await selected(),["item-000.txt","item-002.txt"]);
  await click(0,2);assert.deepEqual(await selected(),["item-002.txt"]);
  await click(1);assert.deepEqual(await selected(),["item-001.txt"]);
  await dragRows(0,2);
  assert.deepEqual(await selected(),["item-000.txt","item-001.txt","item-002.txt"],"Releasing a drag must retain every selected row instead of firing a single click");
  assert(await evaluate('[...document.querySelectorAll(".result-row.selected")].every(row=>row.getAttribute("aria-selected")==="true")'));
  await click(4,2);assert.deepEqual(await selected(),["item-000.txt","item-001.txt","item-002.txt","item-004.txt"]);
  await dragRows(1,3,2);assert.deepEqual(await selected(),["item-000.txt","item-001.txt","item-002.txt","item-003.txt","item-004.txt"]);
  checks.push("Name results support Ctrl toggling, single click, box selection, and additive Ctrl box selection");
  stage="button-exclusion";
  const selectionBeforeButton=await selected();
  const buttonPoint=await evaluate('(()=>{const button=document.querySelector(".open-result-button");button.scrollIntoView({block:"nearest"});const rect=button.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};})()');
  await send("Input.dispatchMouseEvent",{type:"mousePressed",...buttonPoint,button:"left",buttons:1,clickCount:1});
  await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:buttonPoint.x-200,y:buttonPoint.y+100,button:"left",buttons:1});await wait(50);
  assert.equal(await evaluate('!!document.querySelector(".search-selection-marquee")'),false,"Dragging an action button must not start selection");
  await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:buttonPoint.x-200,y:buttonPoint.y+100,button:"left",buttons:0,clickCount:1});
  assert.deepEqual(await selected(),selectionBeforeButton);
  checks.push("Action buttons do not start box selection or disturb selected rows");
  stage="virtual-drag";

  // Scroll during an active drag. This specifically covers virtual rows that
  // did not exist in the DOM when the drag began.
  await evaluate('document.querySelector(".result-list").scrollTop=0');await wait(50);
  const first=await rowPoint(0,.35), third=await rowPoint(2,.6);
  await send("Input.dispatchMouseEvent",{type:"mousePressed",...first,button:"left",buttons:1,clickCount:1});
  await send("Input.dispatchMouseEvent",{type:"mouseMoved",...third,button:"left",buttons:1});await wait(40);
  await evaluate('document.querySelector(".result-list").scrollTop=2600');await wait(80);
  await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:third.x+1,y:third.y,button:"left",buttons:1});await wait(60);
  assert((await selected()).length>2,"Newly visible virtual rows should join the active rectangle");
  await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:third.x+1,y:third.y,button:"left",buttons:0,clickCount:1});
  await evaluate('document.querySelector(".result-list").scrollTop=0');await wait(80);
  assert((await selected()).includes("item-000.txt"),"Offscreen selection should survive scrolling");
  checks.push("Box selection remains consistent across virtual-list scrolling");
  stage="hidden-cancellation";
  const hiddenStart=await rowPoint(0,.35),hiddenEnd=await rowPoint(2,.60);
  await send("Input.dispatchMouseEvent",{type:"mousePressed",...hiddenStart,button:"left",buttons:1,clickCount:1});
  await send("Input.dispatchMouseEvent",{type:"mouseMoved",...hiddenEnd,button:"left",buttons:1});await wait(40);
  assert(await evaluate('!!document.querySelector(".search-selection-marquee")'));
  await evaluate('window.__setVisible(false)');await wait(40);
  assert.equal(await evaluate('!!document.querySelector(".search-selection-marquee")'),false,"Hiding the view should cancel a live drag");
  // The physical release can occur in another app while our view is hidden.
  // Release outside the list so no click there consumes the suppression flag.
  await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:1,y:1,button:"left",buttons:0,clickCount:1});
  await evaluate('window.__setVisible(true)');await wait(100);
  async function clickFirstOpen() {
    const count=await evaluate('window.__selection.opens.length');
    const point=await evaluate('(()=>{const button=document.querySelector(".open-result-button");button.scrollIntoView({block:"nearest"});const rect=button.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};})()');
    await send("Input.dispatchMouseEvent",{type:"mouseMoved",...point});
    await send("Input.dispatchMouseEvent",{type:"mousePressed",...point,button:"left",buttons:1,clickCount:1});
    await send("Input.dispatchMouseEvent",{type:"mouseReleased",...point,button:"left",buttons:0,clickCount:1});
    await until(`window.__selection.opens.length===${count+1}`);
    assert.equal(await evaluate('!!document.querySelector(".search-selection-marquee")'),false);
    await wait(260);
  }
  await clickFirstOpen();
  stage="blur-cancellation";
  const blurStart=await rowPoint(0,.35),blurEnd=await rowPoint(2,.60);
  await send("Input.dispatchMouseEvent",{type:"mousePressed",...blurStart,button:"left",buttons:1,clickCount:1});
  await send("Input.dispatchMouseEvent",{type:"mouseMoved",...blurEnd,button:"left",buttons:1});await wait(40);
  assert(await evaluate('!!document.querySelector(".search-selection-marquee")'));
  await evaluate('window.dispatchEvent(new Event("blur"))');await wait(40);
  assert.equal(await evaluate('!!document.querySelector(".search-selection-marquee")'),false);
  await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:1,y:1,button:"left",buttons:0,clickCount:1});
  await clickFirstOpen();
  checks.push("Hide/blur cancel active dragging; the first subsequent Open button click executes normally");
  // Keep one review image in the ignored project temp directory. It shows a
  // focused keyword input and live rectangle without accessing the real app.
  await evaluate('document.querySelector("button[aria-label=\\"清空搜索\\"]").click()');
  await commit("alpha");await commit("beta");
  await until('document.querySelectorAll(".result-row").length>=3');
  const previewStart=await rowPoint(0,.35),previewEnd=await rowPoint(2,.60);
  await send("Input.dispatchMouseEvent",{type:"mousePressed",...previewStart,button:"left",buttons:1,clickCount:1});
  await send("Input.dispatchMouseEvent",{type:"mouseMoved",...previewEnd,button:"left",buttons:1});await wait(80);
  await evaluate(`document.querySelector(${JSON.stringify(draft)}).focus({preventScroll:true})`);await wait(200);
  await mkdir(path.join(workspace,".task-tmp"),{recursive:true});
  const screenshot=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await writeFile(path.join(workspace,".task-tmp","search-selection-preview.png"),Buffer.from(screenshot.data,"base64"));
  await send("Input.dispatchMouseEvent",{type:"mouseReleased",...previewEnd,button:"left",buttons:0,clickCount:1});
  stage="content-selection";

  await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent.includes("内容搜索")).click()');
  await until('!!document.querySelector(".scope-actions .scope-button")');await evaluate('document.querySelector(".scope-actions .scope-button").click()');
  await until('document.querySelectorAll(".content-row").length>=4');
  await click(0);await click(2,2);assert.deepEqual(await selected(),["item-000.txt","item-002.txt"]);
  await dragRows(0,2);assert.deepEqual(await selected(),["item-000.txt","item-001.txt","item-002.txt"]);
  checks.push("Content results use the same Ctrl and box-selection behavior");
  assert.deepEqual(errors,[]);
  assert.deepEqual(consoleErrors,[],"Browser console should have no warnings or errors");
  console.log(JSON.stringify({result:"PASS",checks},null,2));
} finally {
  if(consoleErrors.length)console.error(JSON.stringify({consoleErrors},null,2));
  socket?.close();
  if(chrome&&chrome.exitCode===null){const exited=new Promise(resolve=>chrome.once("exit",resolve));chrome.kill();await Promise.race([exited,wait(3000)]);}
  await server?.close();
  const relative=path.relative(temporaryRoot,fixture);assert(relative&&!relative.startsWith("..")&&!path.isAbsolute(relative));
  await rm(fixture,{recursive:true,force:true,maxRetries:8,retryDelay:200});
}
