import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

// Real App + SearchView + ForceDeleteDialog under React StrictMode. All file,
// process and shell operations are replaced by in-memory fixtures.
const workspace = path.resolve(import.meta.dirname, "..");
const tempRoot = path.join(workspace, ".test-tmp");
const output = path.join(workspace, "review-artifacts", "delete-app-queue");
const chromePath = [process.env.DELETE_GUIDANCE_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
].find(value => value && existsSync(value));
assert(chromePath, "A local Chrome or Edge installation is required");
await mkdir(tempRoot, { recursive: true });
await mkdir(output, { recursive: true });
const fixture = await mkdtemp(path.join(tempRoot, "delete-app-queue-"));
const profile = path.join(fixture, "profile");
const checks = [];
const errors = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, chrome, socket;
let nextId = 0;
const pending = new Map();

await writeFile(path.join(fixture, "index.html"), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
await writeFile(path.join(fixture, "fixture.jsx"), `
import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "/src/styles.css";
import { api } from "/src/lib/api.ts";
import { defaultFilters } from "/src/lib/search.ts";
const paths = ["E:\\\\queue-fixture\\\\first.txt", "E:\\\\queue-fixture\\\\second.txt", "E:\\\\queue-fixture\\\\third.txt"];
const state = window.__queueSmoke = { paths, calls: [], queue: [paths[0]], listeners: new Set(), sequence: 0, deferred: false };
const results = paths.map((item, index) => ({path:item, name: item.split("\\\\").pop(), size:10, isDirectory:false, extension:".txt", score:10-index, modifiedAt:new Date().toISOString()}));
const settings = await api.getSettings(); settings.language = "zh-CN"; settings.effectMode = "matrix";
Object.assign(api, {
  async getSettings() { return settings; },
  async getSearchWorkspace() { return {version:1, mode:"name", query:"queue-fixture", filters:defaultFilters(), filterPanelOpen:false, extensionInput:"", datePreset:"any", contentScope:"*", results, contentResults:[], selectedPath:paths[2], elapsed:1, savedAt:new Date().toISOString()}; },
  async saveSearchWorkspace() {},
  async search() { return results; },
  async searchPage() { return {items:results, hasMore:false, generation:1, totalMatches:results.length}; },
  async takeForceDeleteRequests() { const batch = state.queue.splice(0); state.calls.push({operation:"take",batch}); if (batch.length) await new Promise(resolve=>setTimeout(resolve,30)); return batch; },
  onForceDeleteRequests(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
  async previewForceDelete(target) { state.calls.push({operation:"preview",path:target}); return {verificationId:target+":"+(++state.sequence), path:target, name:target.split("\\\\").pop(), isDirectory:false, isSymbolicLink:false, highRisk:false, elevated:false, processes:[]}; },
  async executeForceDelete(token) { state.calls.push({operation:"execute",token}); if (state.deferred) await new Promise(resolve => {state.finishDelete = resolve;}); return {deleted:true, terminatedProcesses:[]}; },
  async trashPath(target) { state.calls.push({operation:"trash",path:target}); return true; },
  async openPath(target) { state.calls.push({operation:"open",path:target}); return true; },
  async getPathProperties(target) { return {path:target, name:target.split("\\\\").pop(), parentPath:"E:\\\\queue-fixture", extension:".txt", isDirectory:false, isSymbolicLink:false, size:10, files:1, directories:0, readable:true, writable:true}; }
});
window.__enqueue = (...items) => { state.queue.push(...items); for(const listener of state.listeners) listener(); };
const {default: App} = await import("/src/App.tsx");
createRoot(document.getElementById("root")).render(React.createElement(StrictMode, null, React.createElement(App)));
window.__ready = true;
`);

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: result => { clearTimeout(timeout); resolve(result); }, reject: error => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue:true, awaitPromise:true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function waitFor(expression) {
  for (let i=0; i<120; i++) { if (await evaluate(expression)) return; await wait(100); }
  throw new Error(`Timed out waiting for ${expression}; errors=${JSON.stringify(errors)}`);
}
async function check(name, expression) { assert.equal(await evaluate(expression), true, name); checks.push(name); }
async function click(selector, text) {
  await evaluate(`(() => {
    const node=[...document.querySelectorAll(${JSON.stringify(selector)})].find(item=>${text ? `item.textContent.includes(${JSON.stringify(text)})` : "true"});
    if(!node || node.disabled) throw new Error("Expected enabled control: " + ${JSON.stringify(selector)});
    node.click();
  })()`);
}
const activeTarget = 'document.querySelector(".force-delete-target span")?.textContent';
async function expectTarget(index) { await waitFor(`${activeTarget} === window.__queueSmoke.paths[${index}] && !!document.querySelector(".force-delete-confirmation input")`); }
async function screenshot(name) { const result = await send("Page.captureScreenshot", { format:"png", captureBeyondViewport:false }); await writeFile(path.join(output, `${name}.png`), Buffer.from(result.data,"base64")); }

try {
  server = await createServer({root:workspace, server:{host:"127.0.0.1",port:0}, logLevel:"error"});
  await server.listen();
  chrome = spawn(chromePath, ["--headless=new","--remote-debugging-port=0","--remote-allow-origins=*",`--user-data-dir=${profile}`,"--no-first-run","--disable-background-networking","--window-size=1440,1100","about:blank"], {stdio:"ignore",windowsHide:true});
  let port;
  for(let i=0;i<100&&!port;i++) { try{port=Number((await readFile(path.join(profile,"DevToolsActivePort"),"utf8")).split("\n")[0]);}catch{await wait(100);} }
  assert(port,"Chrome must expose a debug port");
  const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(pages.find(page=>page.type==="page").webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true});});
  socket.addEventListener("message",event=>{const message=JSON.parse(event.data);if(message.method==="Runtime.exceptionThrown")errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);const item=pending.get(message.id);if(item){pending.delete(message.id);message.error?item.reject(new Error(message.error.message)):item.resolve(message.result);}});
  await send("Page.enable"); await send("Runtime.enable");
  const relative=path.relative(workspace,fixture).split(path.sep).join("/");
  await send("Page.navigate", {url:`http://127.0.0.1:${server.httpServer.address().port}/${relative}/index.html?view=search`});
  await waitFor("window.__ready === true");
  await expectTarget(0);
  await waitFor('document.querySelectorAll(".result-row").length === 3');
  await check("StrictMode preserves a request consumed by the first effect", 'window.__queueSmoke.calls.filter(item=>item.operation==="take").length>=2 && window.__queueSmoke.listeners.size===1');
  await evaluate("window.__enqueue(window.__queueSmoke.paths[1], window.__queueSmoke.paths[1].toUpperCase())");
  await wait(150);
  await check("a second Explorer request cannot replace the current confirmation", `${activeTarget} === window.__queueSmoke.paths[0] && document.querySelectorAll(".force-delete-dialog").length===1`);
  await screenshot("first-retained-while-second-queued");
  await click(".force-delete-dialog > header button");
  await expectTarget(1);
  await check("closing the first confirmation opens the next queued target", 'document.querySelectorAll(".force-delete-dialog").length===1 && !document.querySelector(".force-delete-confirmation input").checked');
  // Verify no keyboard action leaks into the selected search row behind a modal.
  await evaluate('document.activeElement?.blur(); window.dispatchEvent(new KeyboardEvent("keydown", {key:"Delete", bubbles:true}));');
  await wait(100);
  await check("Delete while a global confirmation is open cannot trash a background search result", '!window.__queueSmoke.calls.some(item=>item.operation==="trash")');
  await click(".force-delete-dialog > header button");
  await waitFor('!document.querySelector(".force-delete-dialog")');
  await check("case-insensitive duplicate requests create only one queued confirmation", 'document.querySelectorAll(".force-delete-dialog").length===0');
  await evaluate('document.querySelectorAll(".result-row")[0].dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:550,clientY:420}));');
  await waitFor('!!document.querySelector(".search-context-menu")');
  await click(".search-context-menu button", "强制永久删除");
  await expectTarget(0);
  await check("search context menu opens exactly one global force-delete dialog", 'document.querySelectorAll(".force-delete-dialog").length===1 && !document.querySelector(".search-context-menu")');
  await evaluate('window.__queueSmoke.deferred = true');
  await click(".force-delete-confirmation input");
  await click(".force-delete-dialog footer button.danger");
  await waitFor('typeof window.__queueSmoke.finishDelete === "function"');
  await evaluate("window.__enqueue(window.__queueSmoke.paths[2])");
  await wait(100);
  await check("new requests during deletion keep the active target and disabled confirmation", `${activeTarget} === window.__queueSmoke.paths[0] && document.querySelector(".force-delete-dialog footer button.danger").disabled`);
  await evaluate("window.__queueSmoke.finishDelete()");
  await expectTarget(2);
  await check("successful global search deletion removes its result through onDeleted", 'document.querySelectorAll(".result-row").length===2 && ![...document.querySelectorAll(".result-row")].some(item=>item.innerText.includes("first.txt"))');
  await check("the next queued request requires its own confirmation", '!document.querySelector(".force-delete-confirmation input").checked && document.querySelector(".force-delete-dialog footer button.danger").disabled');
  await click(".force-delete-dialog > header button");
  await waitFor('!document.querySelector(".force-delete-dialog")');
  await screenshot("search-row-removed-after-global-delete");
  await evaluate('document.querySelectorAll(".result-row")[0].dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:550,clientY:420}));');
  await waitFor('!!document.querySelector(".search-context-menu")');
  await click(".search-context-menu button", "属性");
  await waitFor('!!document.querySelector(".path-properties-dialog")');
  await evaluate('document.activeElement?.blur(); window.dispatchEvent(new KeyboardEvent("keydown", {key:"Delete", bubbles:true}));');
  await check("Delete inside the properties modal cannot trash a background result", '!window.__queueSmoke.calls.some(item=>item.operation==="trash")');
  await evaluate("window.__enqueue(window.__queueSmoke.paths[2])");
  await expectTarget(2);
  await check("Explorer deletion is accessible above an existing properties dialog", `(() => {
    const control=document.querySelector(".force-delete-dialog > header button"); const bounds=control.getBoundingClientRect();
    return document.querySelector(".path-properties-dialog") !== null && control.contains(document.elementFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2));
  })()`);
  await screenshot("external-delete-above-properties");
  await click(".force-delete-dialog > header button");
  await waitFor('!document.querySelector(".force-delete-dialog")');
  await check("closing global deletion returns to the still usable properties dialog", '!!document.querySelector(".path-properties-dialog")');
  await click(".path-properties-titlebar > button");
  await waitFor('!document.querySelector(".path-properties-dialog")');
  assert.deepEqual(errors,[]);
  checks.push("no uncaught browser errors");
  await writeFile(path.join(output,"smoke-results.json"),JSON.stringify({ok:true,checks,mockedSystemActions:true},null,2));
  console.log(JSON.stringify({ok:true,checks,mockedSystemActions:true},null,2));
} catch(error) {
  if(socket?.readyState===WebSocket.OPEN) { try{await screenshot("failure");}catch{} }
  await writeFile(path.join(output,"smoke-results.json"),JSON.stringify({ok:false,error:String(error),checks,errors,mockedSystemActions:true},null,2));
  throw error;
} finally {
  socket?.close();
  if(chrome&&chrome.exitCode===null) { const exited=new Promise(resolve=>chrome.once("exit",resolve));chrome.kill();await Promise.race([exited,wait(3000)]); }
  await server?.close();
  const relative=path.relative(path.resolve(tempRoot),path.resolve(fixture));
  assert(relative&&!relative.startsWith("..")&&!path.isAbsolute(relative),"Only clean this test fixture under .test-tmp");
  await rm(fixture,{recursive:true,force:true,maxRetries:8,retryDelay:200});
}
