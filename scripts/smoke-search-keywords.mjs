import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

const workspace = path.resolve(import.meta.dirname, "..");
const temporaryRoot = path.join(workspace, ".test-tmp");
await mkdir(temporaryRoot, { recursive: true });
const fixture = await mkdtemp(path.join(temporaryRoot, "search-keywords-"));
const profile = path.join(fixture, "profile");
const browser = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find(existsSync);
assert(browser, "An existing Chrome/Edge installation is required");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, chrome, socket, id = 0;
const pending = new Map();
const errors = [];
await writeFile(path.join(fixture, "index.html"), '<!doctype html><html lang="zh-CN" data-effect="matrix"><head><meta charset="UTF-8"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
await writeFile(path.join(fixture, "fixture.jsx"), `
import React from "react";
import { createRoot } from "react-dom/client";
import "/src/styles.css";
import { api } from "/src/lib/api.ts";
import { setAppLanguage } from "/src/lib/i18n.ts";
import { SearchView } from "/src/views/SearchView.tsx";
setAppLanguage("zh-CN");
const state = window.__keywords = { calls: [], saved: undefined, bookmarks: [] };
const names = ["dsh-alpha.txt", "dsh-beta.txt", "other-beta.txt"];
const documents = [
  {name:"alpha-only.txt", text:"alpha documentation"},
  {name:"beta-only.txt", text:"beta documentation"},
  {name:"alpha-beta.txt", text:"alpha and beta documentation"},
  {name:"unrelated.txt", text:"gamma documentation"}
];
Object.assign(api, {
  async getSearchWorkspace() { return state.saved; },
  async saveSearchWorkspace(value) { state.saved = structuredClone(value); return value; },
  async listSearchBookmarks() { return state.bookmarks; },
  async listSearchBookmarkFolders() { return []; },
  async saveSearchBookmark(value) { state.bookmarks.push(value); return value; },
  async searchPage(query, filters) {
    state.calls.push({mode:"name", query, filters});
    if (state.deferNext) { state.deferNext=false; await new Promise(resolve => { state.releaseSearch=resolve; }); }
    const items = names.filter(name => (filters.keywordMatch === "any" ? filters.keywords.some(term => name.includes(term)) : filters.keywords.every(term => name.includes(term)))).map(name => ({name, path:"E:\\\\fixture\\\\"+name, isDirectory:false, size:10, score:1, source:"native-index"}));
    return {items, hasMore:false, totalMatches:items.length, generation:1};
  },
  async searchContentPage(query, scope, options) {
    state.calls.push({mode:"content", query, scope, options});
    const items = documents.filter(document => (options.keywordMatch === "any" ? options.keywords.some(term => document.text.includes(term)) : options.keywords.every(term => document.text.includes(term)))).map(document => ({name:document.name,path:"E:\\\\fixture\\\\"+document.name,preview:document.text,score:1}));
    return {items,hasMore:false,generation:1,totalMatches:items.length};
  },
  async chooseDirectory() { return "E:\\\\fixture"; },
  async contentIndexStatus(root) { return {state:"ready",root,filesVisited:1,filesIndexed:1}; }
});
const root = createRoot(document.getElementById("root"));
let revision = 0;
window.__renderSearch = (standalone = false) => root.render(React.createElement("main", {className:"view-scroll",style:{height:"100vh",padding:24}}, React.createElement(SearchView, {key:++revision, standalone,indexer:{mode:"cached",state:"ready",entries:3,progress:100,root:"*"},drives:[],onAnalyze:()=>{},onMigrate:()=>{},notify:(type,message)=>{if(type==="error")throw Error(message);}})));
window.__renderSearch();
`);
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(Error(`Timed out: ${method}`)), 15_000);
    pending.set(requestId, {resolve: value => {clearTimeout(timer);resolve(value);},reject});
    socket.send(JSON.stringify({id:requestId,method,params}));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {expression,returnByValue:true,awaitPromise:true});
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function until(expression) {
  for (let n=0;n<100;n++) {if (await evaluate(expression)) return; await wait(80);}
  throw Error(`Condition failed: ${expression}; ${JSON.stringify(errors)}`);
}
async function input(selector, value) {
  await evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)}); input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event("input",{bubbles:true}));})()`);
}
async function enter(selector, composing = false) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,isComposing:${composing}}))`);
}
const draft = ".search-keyword-editor > input";
async function assertResultNames(expected, content = false) {
  const selector = content ? ".content-result-main > strong" : ".result-name-cell > strong";
  await until(`document.querySelectorAll(${JSON.stringify(selector)}).length === ${expected.length}`);
  const names = await evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(item=>item.textContent).sort()`);
  assert.deepEqual(names, [...expected].sort(), "Every keyword's matches must be included once");
  assert.equal(new Set(names).size, names.length, "An item matching multiple keywords must not be duplicated");
}
try {
  // This one-shot fixture never edits source while running; avoid watching
  // Chromium's exclusively locked session files in the working project.
  server = await createServer({configFile:false,root:workspace,server:{host:"127.0.0.1",port:0,watch:null},logLevel:"error"});
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
  await until(`!!document.querySelector(${JSON.stringify(draft)})`);
  await input(draft,"dsh");
  await until('window.__keywords.calls.at(-1)?.filters?.keywords[0] === "dsh"');
  await enter(draft,true);
  assert.equal(await evaluate('document.querySelectorAll(".search-keyword-chip").length'),0,"IME confirmation must not create a keyword");
  const callsBeforeCommit = await evaluate('window.__keywords.calls.length');
  await enter(draft);
  await until('document.querySelectorAll(".search-keyword-chip").length === 1');
  await wait(150);
  assert.equal(await evaluate('window.__keywords.calls.length'), callsBeforeCommit, "Committing an unchanged live query must not repeat it");
  await input(draft,"beta");
  await until('window.__keywords.calls.at(-1)?.filters?.keywords.join("|") === "dsh|beta"');
  assert.equal(await evaluate('window.__keywords.calls.at(-1).filters.keywordMatch'),"any","A live second keyword must use OR without changing a selector");
  await assertResultNames(["dsh-alpha.txt", "dsh-beta.txt", "other-beta.txt"]);
  await enter(draft);
  await until('document.querySelectorAll(".search-keyword-chip").length === 2');
  await assertResultNames(["dsh-alpha.txt", "dsh-beta.txt", "other-beta.txt"]);
  assert.equal(await evaluate('!!document.querySelector(".search-keyword-match")'),false,"Search must not offer an AND/OR selector");
  await evaluate('document.querySelector(".search-keyword-chip > button").click()');
  await input(".search-keyword-chip input","alpha");
  await enter(".search-keyword-chip input");
  await until('window.__keywords.calls.at(-1)?.filters?.keywords[0] === "alpha"');
  await evaluate('document.querySelector(".add-search-bookmark").click()');
  await until('window.__keywords.bookmarks[0]?.filters?.keywords.join("|") === "alpha|beta"');
  await until('window.__keywords.saved?.filters?.keywords.join("|") === "alpha|beta"');
  await evaluate('window.__keywords.bookmarks[0].filters.keywordMatch="all"; window.__keywords.saved.filters.keywordMatch="all"; window.__keywords.calls=[]; window.__renderSearch(true)');
  await until('document.querySelectorAll(".search-keyword-chip").length === 2');
  await until('window.__keywords.calls.at(-1)?.filters?.keywords.join("|") === "alpha|beta"');
  assert.equal(await evaluate('window.__keywords.calls.at(-1).filters.keywordMatch'),"any","Legacy workspace all must restore as OR");
  await assertResultNames(["dsh-alpha.txt", "dsh-beta.txt", "other-beta.txt"]);
  await until('!!document.querySelector("button[aria-label=\\"清空搜索\\"]")');
  await evaluate('document.querySelector("button[aria-label=\\"清空搜索\\"]").click()');
  await until('document.querySelectorAll(".search-keyword-chip").length === 0');
  await evaluate('document.querySelector(".search-bookmark-toggle").click()');
  await until('!!document.querySelector(".bookmark-apply")');
  await evaluate('document.querySelector(".bookmark-apply").click()');
  await until('document.querySelectorAll(".search-keyword-chip").length === 2');
  await until('window.__keywords.calls.at(-1)?.filters?.keywords.join("|") === "alpha|beta"');
  assert.equal(await evaluate('window.__keywords.calls.at(-1).filters.keywordMatch'),"any","Legacy bookmark all must apply as OR");
  await assertResultNames(["dsh-alpha.txt", "dsh-beta.txt", "other-beta.txt"]);
  await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent.includes("内容搜索")).click()');
  await evaluate('document.querySelector(".scope-actions .scope-button").click()');
  await until('window.__keywords.calls.at(-1)?.mode === "content"');
  assert.deepEqual(await evaluate('window.__keywords.calls.at(-1).options.keywords'),["alpha","beta"]);
  assert.equal(await evaluate('window.__keywords.calls.at(-1).options.keywordMatch'),"any");
  await assertResultNames(["alpha-only.txt", "beta-only.txt", "alpha-beta.txt"], true);
  await evaluate('document.querySelector(".search-keyword-remove").click()');
  await until('window.__keywords.calls.at(-1)?.options?.keywords.join("|") === "beta"');
  await assertResultNames(["beta-only.txt", "alpha-beta.txt"], true);
  await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent.includes("名称搜索")).click()');
  await until('!!document.querySelector("button[aria-label=\\"清空搜索\\"]")');
  await evaluate('document.querySelector("button[aria-label=\\"清空搜索\\"]").click()');
  await until('document.querySelectorAll(".search-keyword-chip").length === 0');
  await evaluate('window.__keywords.deferNext=true');
  await input(draft,"alpha");
  await until('typeof window.__keywords.releaseSearch === "function"');
  await input(draft,"");
  await evaluate('window.__keywords.releaseSearch()');
  await wait(200);
  assert.equal(await evaluate('document.querySelectorAll(".result-row").length'),0,"A completed stale request must not restore cleared results");
  assert.equal(await evaluate('!!document.querySelector(".search-input-wrap .spinner")'),false);
  assert.deepEqual(errors,[]);
  console.log("PASS: default OR union, individual and overlapping filename matches without duplicates, live draft, Enter chips, IME, click editing, legacy all bookmark/workspace migration, standalone restore, content OR union, removal, stale-request invalidation");
} finally {
  socket?.close();
  if(chrome&&chrome.exitCode===null){const exited=new Promise(resolve=>chrome.once("exit",resolve));chrome.kill();await Promise.race([exited,wait(3000)]);}
  await server?.close();
  const relative=path.relative(temporaryRoot,fixture);
  assert(relative&&!relative.startsWith("..")&&!path.isAbsolute(relative));
  await rm(fixture,{recursive:true,force:true,maxRetries:8,retryDelay:200});
}
