import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..");
const executable = path.join(workspace, "release-ready", "win-unpacked", "CDriveShiftAI.exe");
const dataDirectory = path.join(
  workspace,
  ".cdriveshiftai-data",
  "test-temp",
  "packaged-search-state"
);
const query = "CDriveShiftAI-state-smoke";
const smokeMainShortcut = "CommandOrControl+Alt+Shift+F9";
const smokeQuickSearchShortcut = "CommandOrControl+Alt+Shift+F10";
const propertiesTarget = path.join(workspace, "package.json");
const renameSource = path.join(dataDirectory, "properties-rename-before.txt");
const renameTarget = path.join(dataDirectory, "properties-rename-after.txt");
const rollbackSource = path.join(dataDirectory, "rollback-source");
const sourceDrive = path.parse(workspace).root.toLocaleUpperCase();
const migrationTestDrive = await (async () => {
  for (const root of ["F:\\", "G:\\", "H:\\", "D:\\"]) {
    if (root.toLocaleUpperCase() === sourceDrive) continue;
    try {
      await access(root);
      return root;
    } catch {
      // Try the next fixed drive.
    }
  }
  throw new Error("A second writable drive is required for the migration round-trip smoke test");
})();
const rollbackDestinationBase = path.join(
  migrationTestDrive,
  `.cdriveshiftai-test-${process.pid}`
);
const rollbackDestination = path.join(
  rollbackDestinationBase,
  path.basename(rollbackSource)
);
const rollbackFixture = path.join(rollbackDestination, "fixture.txt");
let pathPropertiesVerified = false;
let propertyRenameVerified = false;
let shortcutRegistrationVerified = false;
let shortcutConflictVerified = false;
let quickSearchWindowVerified = false;
let quickSearchFeatureParityVerified = false;
let migrationRecordDeletionVerified = false;
let rollbackDestinationCleanupVerified = false;
let migrationReapplyVerified = false;
let migrationRoundTripVerified = false;
let basicSettingsAutoSaveVerified = false;
let shortcutBlurAutoSaveVerified = false;
let mouseShortcutConfigurationVerified = false;
let aiSettingsAutoSaveVerified = false;
let windowBoundsRestoredVerified = false;
let expectedWindowBounds;
await rm(dataDirectory, { recursive: true, force: true });
await mkdir(dataDirectory, { recursive: true });
await writeFile(renameSource, "CDriveShiftAI property rename smoke", "utf8");
await mkdir(rollbackDestination, { recursive: true });
await writeFile(rollbackFixture, "rollback destination cleanup smoke", "utf8");
await symlink(rollbackDestination, rollbackSource, "junction");
await writeFile(
  path.join(dataDirectory, "cdriveshiftai-state.json"),
  JSON.stringify({
    settings: {
      globalShortcut: smokeMainShortcut,
      quickSearchShortcut: smokeQuickSearchShortcut
    },
    migrations: [
      {
        id: "migration-delete-smoke",
        source: "C:\\Smoke\\Source",
        destination: "E:\\Smoke\\Source",
        stage: "rolled-back",
        totalBytes: 4096,
        copiedBytes: 4096,
        migrationCount: 1,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        warnings: []
      },
      {
        id: "migration-rollback-smoke",
        source: rollbackSource,
        destination: rollbackDestination,
        stage: "linked",
        linkType: "junction",
        totalBytes: 34,
        copiedBytes: 34,
        migrationCount: 1,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        warnings: []
      }
    ]
  }),
  "utf8"
);

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchJson(url, attempts = 80) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw lastError ?? new Error(`Unable to fetch ${url}`);
}

async function fetchPage(debugPort, attempts = 100) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const pages = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`, 1);
      const page = pages.find((candidate) => candidate.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw lastError ?? new Error("Electron page target was unavailable");
}

async function fetchQuickSearchPage(debugPort, attempts = 120) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const pages = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`, 1);
      const quickPage = pages.find(
        (candidate) =>
          candidate.type === "page" &&
          candidate.url?.includes("mode=quick-search") &&
          candidate.webSocketDebuggerUrl
      );
      if (quickPage) return quickPage;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw lastError ?? new Error("Quick-search utility target was unavailable");
}

async function runApplication(debugPort, verifyRestored) {
  const child = spawn(
    executable,
    [`--remote-debugging-port=${debugPort}`, "--no-first-run"],
    {
      env: {
        ...process.env,
        CDRIVESHIFTAI_DATA_DIR: dataDirectory
      },
      stdio: "ignore",
      windowsHide: true
    }
  );

  let socket;
  try {
    const page = await fetchPage(debugPort);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message));
      else callback.resolve(message.result);
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const response = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
      return response.result?.value;
    };
    const waitFor = async (expression, attempts = 100) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await evaluate(expression)) return;
        await wait(100);
      }
      throw new Error(`Timed out waiting for ${expression}`);
    };
    const clickText = async (label) => {
      const clicked = await evaluate(`(() => {
        const button = [...document.querySelectorAll("button")]
          .find((item) => item.textContent?.trim() === ${JSON.stringify(label)});
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`);
      if (!clicked) throw new Error(`Button not found: ${label}`);
    };

    await send("Runtime.enable");
    await waitFor('document.querySelector(".app-shell") !== null');
    if (!verifyRestored) {
      await evaluate(`(() => {
        window.moveTo(180, 120);
        window.resizeTo(1280, 760);
        return true;
      })()`);
      await wait(450);
      expectedWindowBounds = await evaluate(`({
        x: window.screenX,
        y: window.screenY,
        width: window.outerWidth,
        height: window.outerHeight
      })`);
    } else {
      const bounds = await evaluate(`({
        left: window.screenX,
        top: window.screenY,
        width: window.outerWidth,
        height: window.outerHeight
      })`);
      if (
        !expectedWindowBounds ||
        Math.abs((bounds?.left ?? 0) - expectedWindowBounds.x) > 16 ||
        Math.abs((bounds?.top ?? 0) - expectedWindowBounds.y) > 16 ||
        Math.abs((bounds?.width ?? 0) - expectedWindowBounds.width) > 16 ||
        Math.abs((bounds?.height ?? 0) - expectedWindowBounds.height) > 16
      ) {
        throw new Error(
          `Main window bounds were not restored: ${JSON.stringify(bounds)}`
        );
      }
      windowBoundsRestoredVerified = true;
    }
    if (!verifyRestored) {
      const shortcutChecks = await evaluate(`Promise.all([
        window.cDriveShiftAI.checkGlobalShortcut(
          ${JSON.stringify(smokeMainShortcut)},
          "main"
        ),
        window.cDriveShiftAI.checkGlobalShortcut(
          ${JSON.stringify(smokeQuickSearchShortcut)},
          "quick-search"
        ),
        window.cDriveShiftAI.checkGlobalShortcut(
          ${JSON.stringify(smokeMainShortcut)},
          "quick-search"
        )
      ])`);
      if (
        shortcutChecks?.[0]?.available !== true ||
        shortcutChecks?.[0]?.active !== true ||
        shortcutChecks?.[1]?.available !== true ||
        shortcutChecks?.[1]?.active !== true
      ) {
        throw new Error(
          `Default global shortcuts were not registered: ${JSON.stringify(shortcutChecks)}`
        );
      }
      if (shortcutChecks?.[2]?.available !== false) {
        throw new Error("Duplicate CDriveShiftAI shortcut was not reported as a conflict");
      }
      shortcutRegistrationVerified = true;
      shortcutConflictVerified = true;
      await evaluate('window.cDriveShiftAI.testGlobalShortcut("quick-search")');
      const quickPage = await fetchQuickSearchPage(debugPort, 160);
      quickSearchWindowVerified = Boolean(quickPage?.webSocketDebuggerUrl);
      const quickSocket = new WebSocket(quickPage.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        quickSocket.addEventListener("open", resolve, { once: true });
        quickSocket.addEventListener("error", reject, { once: true });
      });
      let quickRequestId = 0;
      const quickPending = new Map();
      quickSocket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        const callback = quickPending.get(message.id);
        if (!callback) return;
        quickPending.delete(message.id);
        if (message.error) callback.reject(new Error(message.error.message));
        else callback.resolve(message.result);
      });
      const quickSend = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++quickRequestId;
          quickPending.set(id, { resolve, reject });
          quickSocket.send(JSON.stringify({ id, method, params }));
        });
      await quickSend("Runtime.enable");
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const response = await quickSend("Runtime.evaluate", {
          expression: `Boolean(
            document.querySelector(".standalone-search-page") &&
            document.querySelectorAll(".search-mode-switch button").length === 2 &&
            document.querySelector(".search-bookmark-strip") &&
            document.querySelector(".search-input-wrap input") &&
            Boolean(document.querySelector(".search-mode-switch button strong"))
          )`,
          returnByValue: true
        });
        if (response.result?.value === true) {
          quickSearchFeatureParityVerified = true;
          break;
        }
        await wait(100);
      }
      quickSocket.close();
      if (!quickSearchFeatureParityVerified) {
        throw new Error("Quick-search utility did not load the shared full search workspace");
      }
      const beforeDelete = await evaluate("window.cDriveShiftAI.listMigrations()");
      if (
        beforeDelete?.length !== 2 ||
        !beforeDelete.some((record) => record.id === "migration-delete-smoke") ||
        !beforeDelete.some((record) => record.id === "migration-rollback-smoke")
      ) {
        throw new Error("Isolated migration record was not restored for deletion test");
      }
      const deleted = await evaluate(
        'window.cDriveShiftAI.deleteMigrations(["migration-delete-smoke"])'
      );
      const afterDelete = await evaluate("window.cDriveShiftAI.listMigrations()");
      if (
        deleted !== 1 ||
        afterDelete?.length !== 1 ||
        afterDelete[0]?.id !== "migration-rollback-smoke"
      ) {
        throw new Error("Migration record batch deletion did not persist");
      }
      migrationRecordDeletionVerified = true;
      const rollbackRecord = await evaluate(
        'window.cDriveShiftAI.rollbackMigration("migration-rollback-smoke")'
      );
      const restoredStat = await lstat(rollbackSource);
      const restoredFixture = await readFile(
        path.join(rollbackSource, "fixture.txt"),
        "utf8"
      );
      let destinationExists = true;
      try {
        await lstat(rollbackDestination);
      } catch {
        destinationExists = false;
      }
      if (
        rollbackRecord?.stage !== "rolled-back" ||
        restoredStat.isSymbolicLink() ||
        restoredFixture !== "rollback destination cleanup smoke" ||
        destinationExists
      ) {
        throw new Error(
          `Rollback did not restore a physical source and delete the destination: ${JSON.stringify(
            rollbackRecord
          )}`
        );
      }
      rollbackDestinationCleanupVerified = true;
      await evaluate(
        'window.cDriveShiftAI.navigateApp({ view: "history" })'
      );
      await waitFor('document.querySelector(".history-page") !== null');
      const historySelected = await evaluate(`(() => {
        const input = document.querySelector(".history-select input");
        if (!(input instanceof HTMLInputElement)) return false;
        input.click();
        return true;
      })()`);
      if (!historySelected) {
        throw new Error("History-selection checkbox was unavailable");
      }
      await evaluate('window.cDriveShiftAI.reapplyMigration("migration-rollback-smoke")');
      await waitFor(
        'window.cDriveShiftAI.listMigrations().then((records) => records.some((record) => record.id === "migration-rollback-smoke" && record.stage === "linked" && record.migrationCount === 2))',
        300
      );
      const reappliedRecord = (
        await evaluate("window.cDriveShiftAI.listMigrations()")
      ).find((record) => record.id === "migration-rollback-smoke");
      const reappliedSourceStat = await lstat(rollbackSource);
      const reappliedFixture = await readFile(
        path.join(rollbackSource, "fixture.txt"),
        "utf8"
      );
      const reappliedDestinationStat = await lstat(rollbackDestination);
      if (
        reappliedRecord?.id !== "migration-rollback-smoke" ||
        reappliedRecord?.stage !== "linked" ||
        reappliedRecord?.migrationCount !== 2 ||
        !reappliedSourceStat.isSymbolicLink() ||
        !reappliedDestinationStat.isDirectory() ||
        reappliedFixture !== "rollback destination cleanup smoke"
      ) {
        throw new Error(
          `Reapply did not reuse the record and destination: ${JSON.stringify(
            reappliedRecord
          )}`
        );
      }
      migrationReapplyVerified = true;
      const secondRollback = await evaluate(
        'window.cDriveShiftAI.rollbackMigration("migration-rollback-smoke")'
      );
      const secondRestoreStat = await lstat(rollbackSource);
      let secondDestinationExists = true;
      try {
        await lstat(rollbackDestination);
      } catch {
        secondDestinationExists = false;
      }
      if (
        secondRollback?.stage !== "rolled-back" ||
        secondRollback?.migrationCount !== 2 ||
        secondRestoreStat.isSymbolicLink() ||
        secondDestinationExists
      ) {
        throw new Error(
          `Second rollback did not preserve the migration count: ${JSON.stringify(
            secondRollback
          )}`
        );
      }
      migrationRoundTripVerified = true;
      await evaluate(
        'window.cDriveShiftAI.deleteMigrations(["migration-rollback-smoke"])'
      );
      await evaluate(
        'window.cDriveShiftAI.navigateApp({ view: "settings" })'
      );
      await waitFor('document.querySelector(".settings-page") !== null');
      const activateSettingsModule = async (buttonIndex) => {
        const activated = await evaluate(
          `((index) => {
            const moduleButtons = document.querySelectorAll(".settings-module-nav button");
            const button = moduleButtons[index];
            if (!(button instanceof HTMLButtonElement)) return false;
            button.click();
            return true;
          })(${buttonIndex})`
        );
        if (!activated) {
          throw new Error(`Settings module index ${buttonIndex} was unavailable`);
        }
      };
      const systemModuleActivated = await evaluate(`(() => {
        const moduleButtons = document.querySelectorAll(".settings-module-nav button");
        const button = moduleButtons[2];
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`);
      if (!systemModuleActivated) {
        throw new Error("Settings system module selector was unavailable");
      }
      await waitFor('document.querySelector(".shortcut-recorder input") !== null');
      const shortcutCaptured = await evaluate(`(() => {
        const input = document.querySelector(".shortcut-recorder input");
        if (!(input instanceof HTMLInputElement)) return false;
        input.focus();
        input.dispatchEvent(new KeyboardEvent("keydown", {
          key: "F11",
          ctrlKey: true,
          altKey: true,
          shiftKey: true,
          bubbles: true
        }));
        return true;
      })()`);
      if (!shortcutCaptured) {
        throw new Error("Shortcut recorder was unavailable for blur-save test");
      }
      await wait(80);
      await evaluate('document.querySelector(".shortcut-recorder input")?.blur()');
      await waitFor(
        'window.cDriveShiftAI.getSettings().then((settings) => settings.globalShortcut === "CommandOrControl+Alt+Shift+F11")'
      );
      const savedShortcut = await evaluate(
        'window.cDriveShiftAI.checkGlobalShortcut("CommandOrControl+Alt+Shift+F11", "main")'
      );
      if (savedShortcut?.active !== true) {
        throw new Error("Shortcut blur-save did not register the new accelerator");
      }
      shortcutBlurAutoSaveVerified = true;

      const mouseButtonChanged = await evaluate(`(() => {
        const select = document.querySelector(".mouse-shortcut-controls select");
        if (!(select instanceof HTMLSelectElement)) return false;
        select.value = "forward";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);
      if (!mouseButtonChanged) {
        throw new Error("Mouse shortcut button selector was unavailable");
      }
      await waitFor(
        'window.cDriveShiftAI.getSettings().then((settings) => settings.mouseQuickSearchButton === "forward")'
      );
      const mouseHoldChanged = await evaluate(`(() => {
        const input = document.querySelector(".mouse-hold-input input");
        if (!(input instanceof HTMLInputElement)) return false;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value"
        )?.set;
        setter?.call(input, "1.5");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
        input.blur();
        return true;
      })()`);
      if (!mouseHoldChanged) {
        throw new Error("Mouse shortcut hold input was unavailable");
      }
      await waitFor(
        'window.cDriveShiftAI.getSettings().then((settings) => settings.mouseQuickSearchHoldMs === 1500)'
      );
      const mouseStatus = await evaluate(
        "window.cDriveShiftAI.getMouseShortcutStatus()"
      );
      if (
        mouseStatus?.available !== true ||
        mouseStatus?.button !== "forward" ||
        mouseStatus?.holdMs !== 1_500
      ) {
        throw new Error(
          `Mouse shortcut configuration did not reach the native listener: ${JSON.stringify(
            mouseStatus
          )}`
        );
      }
      mouseShortcutConfigurationVerified = true;

      await evaluate('window.cDriveShiftAI.navigateApp({ view: "settings", focus: "ai-settings" })');
      await waitFor('document.querySelector(".ai-settings") !== null');
      const pickerOpened = await evaluate(`(() => {
        const trigger = document.querySelector(".provider-picker-trigger");
        if (!(trigger instanceof HTMLButtonElement)) return false;
        trigger.click();
        return true;
      })()`);
      if (!pickerOpened) {
        throw new Error("AI provider picker was unavailable for autosave test");
      }
      await waitFor('document.querySelector(".provider-picker-popover") !== null');
      const providerSelected = await evaluate(`(() => {
        const option = [...document.querySelectorAll(".provider-picker-group > button")]
          .find((button) => button.querySelector("strong")?.textContent?.trim() === "Ollama");
        if (!(option instanceof HTMLButtonElement)) return false;
        option.click();
        return true;
      })()`);
      if (!providerSelected) {
        throw new Error("Ollama provider option was unavailable for autosave test");
      }
      await waitFor(
        'window.cDriveShiftAI.getSettings().then((settings) => settings.ai.provider === "ollama" && settings.ai.baseUrl === "http://127.0.0.1:11434/v1")'
      );
      const modelChanged = await evaluate(`(() => {
        const input = document.querySelector(".model-picker input");
        if (!(input instanceof HTMLInputElement)) return false;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value"
        )?.set;
        setter?.call(input, "smoke-local-model");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
        return true;
      })()`);
      if (!modelChanged) {
        throw new Error("AI model input was unavailable for blur-save test");
      }
      await wait(80);
      await evaluate('document.querySelector(".model-picker input")?.blur()');
      await waitFor(
        'window.cDriveShiftAI.getSettings().then((settings) => settings.ai.model === "smoke-local-model")'
      );
      await waitFor(
        'document.querySelector(".ai-autosave-status.saved") !== null'
      );
      if (
        await evaluate(
          'Boolean([...document.querySelectorAll("button")].find((button) => button.textContent?.includes("淇濆瓨 AI 閰嶇疆")))'
        )
      ) {
        throw new Error("Obsolete AI settings save button is still visible");
      }
      aiSettingsAutoSaveVerified = true;

      await activateSettingsModule(2);
      const setBooleanSetting = async (targetChecked) => {
        const applied = await evaluate(`(targetChecked => {
          const settingInputs = [...document.querySelectorAll(
            ".settings-system-stack .setting-row input[type='checkbox']"
          )];
          const minimizeToTrayInput = settingInputs.at(2);
          if (!(minimizeToTrayInput instanceof HTMLInputElement)) return false;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            if (minimizeToTrayInput.checked === Boolean(targetChecked)) return true;
            minimizeToTrayInput.click();
          }
          return minimizeToTrayInput.checked === Boolean(targetChecked);
        })(${targetChecked})`);
        if (!applied) {
          throw new Error(
            "Minimize-to-tray setting input could not be set to the expected value"
          );
        }
      };
      const setBooleanSettingAndWait = async (targetChecked) => {
        await setBooleanSetting(targetChecked);
        await waitFor(
          `window.cDriveShiftAI.getSettings().then((settings) => settings.minimizeToTray === ${Boolean(
            targetChecked
          )})`
        );
      };
      const minimizeToTrayChecked = await evaluate(`(() => {
        const settingInputs = [...document.querySelectorAll(
          ".settings-system-stack .setting-row input[type='checkbox']"
        )];
        const minimizeToTrayInput = settingInputs.at(2);
        if (!(minimizeToTrayInput instanceof HTMLInputElement)) return null;
        return minimizeToTrayInput.checked;
      })()`);
      if (minimizeToTrayChecked === null) {
        throw new Error("Minimize-to-tray setting input was not available");
      }
      if (minimizeToTrayChecked) {
        await setBooleanSettingAndWait(false);
      } else {
        await setBooleanSettingAndWait(true);
        await setBooleanSettingAndWait(false);
      }
      const toggled = true;
      if (!toggled) {
        throw new Error("Minimize-to-tray setting toggle was unavailable");
      }
      await waitFor(
        'window.cDriveShiftAI.getSettings().then((settings) => settings.minimizeToTray === false)'
      );
      if (
        await evaluate(
          'Boolean([...document.querySelectorAll("button")].find((button) => button.textContent?.includes("淇濆瓨鍩虹璁剧疆")))'
        )
      ) {
        throw new Error("Obsolete basic settings save button is still visible");
      }
      basicSettingsAutoSaveVerified = true;
    }
    const properties = await evaluate(
      `window.cDriveShiftAI.getPathProperties(${JSON.stringify(propertiesTarget)})`
    );
    if (
      properties?.path !== propertiesTarget ||
      properties?.name !== "package.json" ||
      properties?.isDirectory !== false ||
      properties?.extension !== "json" ||
      !(properties?.size > 0) ||
      properties?.readable !== true
    ) {
      throw new Error(`Path properties API returned invalid metadata: ${JSON.stringify(properties)}`);
    }
    pathPropertiesVerified = true;
    if (!verifyRestored) {
      const renamedPath = await evaluate(
        `window.cDriveShiftAI.renamePath(${JSON.stringify(renameSource)}, "properties-rename-after.txt")`
      );
      const renamedProperties = await evaluate(
        `window.cDriveShiftAI.getPathProperties(${JSON.stringify(renameTarget)})`
      );
      if (
        renamedPath !== renameTarget ||
        renamedProperties?.name !== "properties-rename-after.txt"
      ) {
        throw new Error("Property rename did not update the file-system path");
      }
      propertyRenameVerified = true;
    }
    await evaluate('window.cDriveShiftAI.navigateApp({ view: "search", focus: "search-input" })');
    await waitFor('document.querySelector(".search-page") !== null');

    if (verifyRestored) {
      await waitFor(
        `document.querySelector(".search-input-wrap input")?.value === ${JSON.stringify(query)}`
      );
      await waitFor('document.querySelector(".restored-search-state") !== null');
      await evaluate('document.querySelector(".search-bookmark-toggle")?.click()');
      await waitFor('document.querySelector(".search-bookmark-dropdown") !== null');
      await waitFor('document.querySelectorAll(".search-bookmark-chip").length === 1');
      await waitFor('document.querySelectorAll(".bookmark-folder-chip").length === 1');
      await waitFor('document.documentElement.dataset.effect === "calm"');
      return await evaluate(`Promise.all([
        window.cDriveShiftAI.listSearchBookmarks(),
        window.cDriveShiftAI.listSearchBookmarkFolders(),
        window.cDriveShiftAI.getUiLayout().then(
          (layout) => layout.searchRenamePosition
        ),
        Promise.resolve({
          effect: document.documentElement.dataset.effect,
          startupQuery: new URLSearchParams(location.search).get("effect"),
          initialBackground: getComputedStyle(document.documentElement).backgroundColor
        })
      ])`);
    }

    const changed = await evaluate(`(() => {
      const input = document.querySelector(".search-input-wrap input");
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, ${JSON.stringify(query)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    if (!changed) throw new Error("Search input was unavailable");
    const savedBookmark = await evaluate(`window.cDriveShiftAI.saveSearchBookmark({
      id: "search-bookmark-smoke",
      name: "鏃ュ織姝ｅ垯涔︾",
      mode: "content",
      query: "error\\\\s+[45]\\\\d{2}",
      filters: {
        kind: "all",
        scope: "*",
        scopes: [],
        categories: [],
        extensions: ["log", "txt"],
        caseSensitive: true,
        wholeWord: false,
        matchPath: false,
        regex: true,
        sortBy: "modified",
        sortDirection: "desc"
      },
      filterPanelOpen: true,
      extensionInput: "log, txt",
      datePreset: "week",
      contentScope: "E:\\\\Logs",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })`);
    if (savedBookmark?.id !== "search-bookmark-smoke") {
      throw new Error("Search bookmark API did not return the saved bookmark");
    }
    const savedFolder = await evaluate(`window.cDriveShiftAI.saveSearchBookmarkFolder({
      id: "search-folder-smoke",
      name: "鏃ュ織鎺掓煡",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })`);
    if (savedFolder?.id !== "search-folder-smoke") {
      throw new Error("Search bookmark folder API did not return the saved folder");
    }
    const movedBookmark = await evaluate(`window.cDriveShiftAI.saveSearchBookmark({
      ...${JSON.stringify(savedBookmark)},
      folderId: "search-folder-smoke"
    })`);
    if (movedBookmark?.folderId !== "search-folder-smoke") {
      throw new Error("Search bookmark was not moved into the folder");
    }
    await evaluate(`window.cDriveShiftAI.updateUiLayout({
      searchRenamePosition: { x: 418, y: 236 }
    })`);
    await evaluate('window.cDriveShiftAI.updateSettings({ effectMode: "calm" })');
      await wait(900);
      await evaluate('window.cDriveShiftAI.navigateApp({ view: "overview" })');
      await waitFor('document.querySelector(".overview-page") !== null');
    await evaluate('window.cDriveShiftAI.navigateApp({ view: "search", focus: "search-input" })');
    await waitFor(
      `document.querySelector(".search-input-wrap input")?.value === ${JSON.stringify(query)}`
    );
  } finally {
    socket?.close();
    if (child.exitCode == null) {
      const exited = once(child, "exit");
      child.kill();
      await Promise.race([exited, wait(3_000)]);
    }
    await wait(400);
  }
}

try {
  await runApplication(9241, false);
  const state = JSON.parse(
    await readFile(path.join(dataDirectory, "cdriveshiftai-state.json"), "utf8")
  );
  if (state.searchWorkspace?.query !== query) {
    throw new Error("Search workspace was not written to the project data state");
  }
  if (
    !expectedWindowBounds ||
    Math.abs(
      (state.uiLayout?.mainWindowBounds?.x ?? 0) - expectedWindowBounds.x
    ) > 16 ||
    Math.abs(
      (state.uiLayout?.mainWindowBounds?.y ?? 0) - expectedWindowBounds.y
    ) > 16 ||
    Math.abs(
      (state.uiLayout?.mainWindowBounds?.width ?? 0) -
        expectedWindowBounds.width
    ) > 16 ||
    Math.abs(
      (state.uiLayout?.mainWindowBounds?.height ?? 0) -
        expectedWindowBounds.height
    ) > 16
  ) {
    throw new Error(
      `Main window bounds were not persisted: ${JSON.stringify(
        state.uiLayout?.mainWindowBounds
      )}`
    );
  }
  if (
    state.searchBookmarks?.length !== 1 ||
    state.searchBookmarks[0]?.query !== String.raw`error\s+[45]\d{2}` ||
    state.searchBookmarks[0]?.filters?.regex !== true ||
    state.searchBookmarks[0]?.filters?.caseSensitive !== true ||
    state.searchBookmarks[0]?.contentScope !== "E:\\Logs" ||
    state.searchBookmarks[0]?.folderId !== "search-folder-smoke" ||
    state.searchBookmarkFolders?.length !== 1 ||
    state.searchBookmarkFolders[0]?.name !== "鏃ュ織鎺掓煡"
  ) {
    throw new Error("Search bookmark did not preserve the query and complete filter state");
  }
  const [restoredBookmarks, restoredFolders, restoredRenamePosition, startupTheme] =
    await runApplication(9242, true);
  if (
    restoredBookmarks?.length !== 1 ||
    restoredBookmarks[0]?.id !== "search-bookmark-smoke"
  ) {
    throw new Error("Search bookmark was not restored after restart");
  }
  if (
    restoredFolders?.length !== 1 ||
    restoredFolders[0]?.id !== "search-folder-smoke" ||
    restoredBookmarks[0]?.folderId !== restoredFolders[0]?.id
  ) {
    throw new Error("Search bookmark folder or its membership was not restored");
  }
  if (
    restoredRenamePosition?.x !== 418 ||
    restoredRenamePosition?.y !== 236
  ) {
    throw new Error("Rename window position was not restored after restart");
  }
  if (
    startupTheme?.effect !== "calm" ||
    startupTheme?.startupQuery !== "calm" ||
    startupTheme?.initialBackground !== "rgb(237, 244, 245)"
  ) {
    throw new Error(
      `Saved theme was not applied before the renderer initialized: ${JSON.stringify(startupTheme)}`
    );
  }
  console.log(
    JSON.stringify({
      result: "ok",
      query,
      persistedInsideProject: true,
      restoredAfterRestart: true,
      searchBookmarkRestored: true,
      bookmarkFolderRestored: true,
      renamePositionRestored: true,
      customPathPropertiesVerified: pathPropertiesVerified,
      propertyRenameVerified,
      regexAndFiltersPreserved: true,
      startupThemeAppliedBeforeReact: true,
      shortcutRegistrationVerified,
      shortcutConflictVerified,
      quickSearchWindowVerified,
      quickSearchFeatureParityVerified,
      migrationRecordDeletionVerified,
      rollbackDestinationCleanupVerified,
      migrationReapplyVerified,
      migrationRoundTripVerified,
      basicSettingsAutoSaveVerified,
      shortcutBlurAutoSaveVerified,
      mouseShortcutConfigurationVerified,
      aiSettingsAutoSaveVerified,
      windowBoundsRestoredVerified
    }, null, 2)
  );
} finally {
  await rm(dataDirectory, { recursive: true, force: true });
  await rm(rollbackDestinationBase, { recursive: true, force: true });
}
