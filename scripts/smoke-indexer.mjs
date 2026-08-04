import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const workspace = path.resolve(import.meta.dirname, "..");
const executable = path.join(
  workspace,
  "native",
  "indexer",
  "target",
  "release",
  "cshift-indexer.exe"
);
const testTempRoot = path.join(workspace, ".cdriveshiftai-data", "test-temp");
await mkdir(testTempRoot, { recursive: true });
const fixture = await mkdtemp(path.join(testTempRoot, "indexer-"));
const indexState = await mkdtemp(path.join(testTempRoot, "indexer-state-"));
const nested = path.join(fixture, "nested");
const scoped = path.join(fixture, "scope");
const similarlyNamedScope = path.join(fixture, "scope-extra");
await mkdir(nested);
await mkdir(scoped);
await mkdir(similarlyNamedScope);
await writeFile(
  path.join(nested, "Needle-file.txt"),
  "CDriveShiftAI stable-content-needle 全文索引联调",
  "utf8"
);
await writeFile(path.join(nested, "needle-photo.png"), "not a real image", "utf8");
await writeFile(path.join(nested, "needle-script.ts"), "export const needle = true;", "utf8");
await writeFile(path.join(nested, "needle-page-a.txt"), "page a", "utf8");
await writeFile(path.join(nested, "needle-page-b.txt"), "page b", "utf8");
await writeFile(path.join(nested, "needle-page-c.txt"), "page c", "utf8");
await writeFile(path.join(nested, "portable-tool.exe"), "test executable fixture", "utf8");
await writeFile(path.join(scoped, "shared-inside.log"), "inside", "utf8");
await writeFile(path.join(similarlyNamedScope, "shared-outside.log"), "outside", "utf8");

const child = spawn(executable, ["--serve"], {
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"]
});
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
const events = [];
let nextId = 0;

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    if (message.ok === false) reject(new Error(message.error));
    else resolve(message);
  } else if (message.event) {
    if (process.env.CSHIFT_SMOKE_TRACE === "1") {
      console.error("[indexer-event]", JSON.stringify(message));
    }
    events.push(message);
    for (const waiter of [...eventWaiters]) waiter(message);
  }
});

const eventWaiters = new Set();
function waitForEvent(predicate, timeoutMs = 20_000) {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      eventWaiters.delete(handler);
      reject(new Error("Timed out waiting for native indexer event"));
    }, timeoutMs);
    const handler = (message) => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      eventWaiters.delete(handler);
      resolve(message);
    };
    eventWaiters.add(handler);
  });
}

function request(payload, timeoutMs = 10_000) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Native request ${id} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
  });
}

function normalizeWindowsPath(value) {
  return value.replace(/^\\\\\?\\/, "").replaceAll("/", "\\").toLocaleLowerCase();
}

try {
  await request({
    op: "init",
    root: fixture,
    cachePath: path.join(indexState, "names.bin"),
    contentCacheDir: path.join(indexState, "content")
  });
  await waitForEvent(
    (message) => message.event === "status" && message.status?.state === "ready"
  );
  const nameResult = await request({
    op: "query",
    query: "needle-file",
    kind: "all",
    scope: fixture,
    limit: 10
  });
  if (!nameResult.results?.some((result) => result.name === "Needle-file.txt")) {
    throw new Error("Name index smoke test did not find the fixture file");
  }
  const firstPage = await request({
    op: "query",
    query: "needle-page",
    kind: "file",
    scope: fixture,
    sortBy: "name",
    sortDirection: "asc",
    limit: 1
  });
  const secondPage = await request({
    op: "query",
    query: "needle-page",
    kind: "file",
    scope: fixture,
    sortBy: "name",
    sortDirection: "asc",
    cursor: firstPage.nextCursor,
    limit: 1
  });
  if (
    firstPage.hasMore !== true ||
    firstPage.totalMatches !== 3 ||
    !firstPage.nextCursor ||
    firstPage.results?.length !== 1 ||
    secondPage.results?.length !== 1 ||
    firstPage.results[0]?.path === secondPage.results[0]?.path ||
    firstPage.results[0]?.name.localeCompare(secondPage.results[0]?.name) >= 0
  ) {
    throw new Error("Paged name search did not preserve the complete sorted result set");
  }
  const imageFilterResult = await request({
    op: "query",
    query: "needle",
    kind: "file",
    scope: fixture,
    categories: ["image"],
    extensions: ["png"],
    limit: 10
  });
  if (
    imageFilterResult.results?.length !== 1 ||
    imageFilterResult.results[0]?.name !== "needle-photo.png"
  ) {
    throw new Error("Combined category and extension filters returned incorrect results");
  }
  const multiCategoryResult = await request({
    op: "query",
    query: "needle",
    kind: "file",
    scopes: [nested],
    categories: ["document", "code"],
    limit: 10
  });
  if (
    !multiCategoryResult.results?.some((result) => result.name === "Needle-file.txt") ||
    !multiCategoryResult.results?.some((result) => result.name === "needle-script.ts") ||
    multiCategoryResult.results?.some((result) => result.name === "needle-photo.png")
  ) {
    throw new Error("Multi-category OR filter returned incorrect results");
  }
  const scopedResult = await request({
    op: "query",
    query: "shared",
    kind: "all",
    scopes: [scoped],
    limit: 10
  });
  if (
    scopedResult.results?.length !== 1 ||
    scopedResult.results[0]?.name !== "shared-inside.log"
  ) {
    throw new Error("Scope boundary filter leaked results from a similarly named directory");
  }
  const regexResult = await request({
    op: "query",
    query: "^Needle-file\\.txt$",
    kind: "file",
    scope: fixture,
    regex: true,
    caseSensitive: true,
    limit: 10
  });
  if (
    regexResult.results?.length !== 1 ||
    regexResult.results[0]?.name !== "Needle-file.txt"
  ) {
    throw new Error("Case-sensitive regular expression filter returned incorrect results");
  }
  const executableCatalog = await request({
    op: "executableCatalog",
    limit: 100
  });
  if (
    !executableCatalog.results?.some(
      (result) => result.name === "portable-tool.exe" && result.isDirectory === false
    )
  ) {
    throw new Error("Executable catalog did not include the portable application fixture");
  }

  const livePath = path.join(fixture, "live-change-probe.txt");
  events.length = 0;
  await writeFile(livePath, "live watcher probe", "utf8");
  await waitForEvent((message) => message.event === "indexChanged");
  const liveCreated = await request({
    op: "query",
    query: "live-change-probe",
    kind: "file",
    scope: fixture,
    limit: 10
  });
  if (!liveCreated.results?.some((result) => result.name === "live-change-probe.txt")) {
    throw new Error("Live watcher did not add the new file to search results");
  }
  events.length = 0;
  await rm(livePath, { force: true });
  await waitForEvent((message) => message.event === "indexChanged");
  const liveDeleted = await request({
    op: "query",
    query: "live-change-probe",
    kind: "file",
    scope: fixture,
    limit: 10
  });
  if (liveDeleted.results?.length !== 0) {
    throw new Error("Live watcher did not remove the deleted file from search results");
  }

  await request({ op: "contentIndex", scope: fixture });
  await waitForEvent(
    (message) => message.event === "contentStatus" && message.status?.state === "ready"
  );
  const contentStatus = await request({
    op: "contentStatus",
    scope: fixture
  });
  if (
    contentStatus.status?.state !== "ready" ||
    contentStatus.status?.filesIndexed < 1
  ) {
    throw new Error("Persisted content index status was not restored correctly");
  }
  const contentResult = await request({
    op: "contentQuery",
    query: "stable-content-needle",
    scope: fixture,
    limit: 10
  });
  if (!contentResult.results?.some((result) => result.name === "Needle-file.txt")) {
    throw new Error("Content index smoke test did not find the fixture content");
  }
  const liveContentPath = path.join(nested, "live-content-change.txt");
  events.length = 0;
  await writeFile(liveContentPath, "dynamic-content-keyword-added", "utf8");
  await waitForEvent(
    (message) =>
      message.event === "indexChanged" &&
      message.contentScopes?.some(
        (scope) => normalizeWindowsPath(scope) === normalizeWindowsPath(fixture)
      )
  );
  const liveContentCreated = await request({
    op: "contentQuery",
    query: "dynamic-content-keyword-added",
    scope: fixture,
    limit: 10
  });
  if (!liveContentCreated.results?.some((result) => result.name === "live-content-change.txt")) {
    throw new Error("Live content index did not add the changed text file");
  }
  events.length = 0;
  await rm(liveContentPath, { force: true });
  await waitForEvent(
    (message) =>
      message.event === "indexChanged" &&
      message.contentScopes?.some(
        (scope) => normalizeWindowsPath(scope) === normalizeWindowsPath(fixture)
      )
  );
  const liveContentDeleted = await request({
    op: "contentQuery",
    query: "dynamic-content-keyword-added",
    scope: fixture,
    limit: 10
  });
  if (liveContentDeleted.results?.length !== 0) {
    throw new Error("Live content index did not remove the deleted text file");
  }
  const contentRegexResult = await request({
    op: "contentQuery",
    query: String.raw`cdriveshiftai\s+stable-content-(?:needle|missing)`,
    scope: fixture,
    regex: true,
    caseSensitive: false,
    limit: 10
  });
  if (
    contentRegexResult.results?.length !== 1 ||
    contentRegexResult.results[0]?.name !== "Needle-file.txt" ||
    !contentRegexResult.results[0]?.preview.includes("〔CDriveShiftAI stable-content-needle〕")
  ) {
    throw new Error("Content regular expression search returned incorrect results");
  }
  let invalidRegexRejected = false;
  try {
    await request({
      op: "contentQuery",
      query: "(unclosed",
      scope: fixture,
      regex: true,
      limit: 10
    });
  } catch (error) {
    invalidRegexRejected = /正则表达式无效/.test(String(error));
  }
  if (!invalidRegexRejected) {
    throw new Error("Invalid content regular expression was not rejected clearly");
  }
  await request({ op: "quit" });
  console.log(
    JSON.stringify(
      {
        nameMatches: nameResult.results.length,
        pagedNameTotal: firstPage.totalMatches,
        combinedFilterMatches: imageFilterResult.results.length,
        multiCategoryMatches: multiCategoryResult.results.length,
        scopedMatches: scopedResult.results.length,
        regexMatches: regexResult.results.length,
        executableCatalogMatches: executableCatalog.results.length,
        liveCreateMatches: liveCreated.results.length,
        liveDeleteMatches: liveDeleted.results.length,
        contentMatches: contentResult.results.length,
        liveContentCreateMatches: liveContentCreated.results.length,
        liveContentDeleteMatches: liveContentDeleted.results.length,
        contentRegexMatches: contentRegexResult.results.length,
        invalidRegexRejected,
        persistedContentDocuments: contentStatus.status.filesIndexed,
        result: "ok"
      },
      null,
      2
    )
  );
} finally {
  if (!child.killed) child.kill();
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  await rm(fixture, { recursive: true, force: true });
  await rm(indexState, { recursive: true, force: true });
}
