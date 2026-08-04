# CDriveShiftAI

[简体中文](README.zh-CN.md) · [Changelog](CHANGELOG.md) · [Releases](https://github.com/PuppetWen/CDriveShiftAI/releases)

CDriveShiftAI is a Windows desktop application for finding, understanding, and safely relocating data across local drives. It combines a first-party file-name index, directory-scoped full-text search, application ownership analysis, and transactional cross-drive migration while preserving the original path through a Windows symbolic link or directory junction.

The search engine is developed specifically for CDriveShiftAI and does **not** call or bundle Everything.

Current release: **0.0.6**

## Download

Download the latest installer or portable build from [GitHub Releases](https://github.com/PuppetWen/CDriveShiftAI/releases/latest).

| Package | Intended use |
| --- | --- |
| `CDriveShiftAI-x64.exe` | Installer with a selectable installation directory and in-place upgrades |
| `CDriveShiftAI-x64-portable.exe` | Single-file portable build that keeps application data beside the executable |

Local builds also produce `release-ready\win-unpacked\CDriveShiftAI.exe`. Run that unpacked executable when temporary extraction by the single-file portable wrapper is undesirable.

Requirements:

- Windows 10 or Windows 11, x64
- NTFS is recommended for the fastest initial index and link-based migration
- Administrator privileges may be required to read MFT metadata, access protected paths, or create symbolic links

The current binaries are not signed with a commercial Authenticode certificate, so Windows SmartScreen may display an “Unknown publisher” warning.

## What it does

- Searches file and folder names across all local drives.
- Builds a local full-text index for directories explicitly selected by the user.
- Determines whether a directory is an application installation, application data, cache, user data, development data, or a protected system component.
- Correlates directories with installed applications, including applications installed on another drive.
- Moves a directory to another drive and preserves its original path with a symbolic link or junction.
- Records each migration and supports restore, repeated migration, and recovery after interruption.
- Provides five complete visual themes shared by the main window, quick-search window, dialogs, menus, tooltips, and progress views.

## Whole-computer name search

CDriveShiftAI automatically discovers fixed and removable local drives and builds a persistent metadata index:

- NTFS volumes use MFT metadata when available.
- Other file systems, unavailable MFT access, and restricted volumes fall back to a multithreaded directory walker.
- A full rebuild normally runs only on first use, the first launch after a Windows restart, cache corruption, manual refresh, or when the last full refresh is more than 24 hours old.
- Windows recursive file-system notifications keep additions, deletions, renames, and moves synchronized after the initial build.
- A memory-mapped, compact metadata layout avoids keeping several complete copies of millions of paths in memory.
- Heavy indexing work pauses cooperatively while the application is hidden or minimized, then resumes from its current stage when the UI returns.

### Query modes

Name search supports four modes for any query, not only predefined terms:

- **Contains** — the query appears as a continuous substring.
- **Whole word** — the query must form a complete word or name segment.
- **Fuzzy** — tolerates partial or approximate input.
- **Regular expression** — supports advanced patterns and includes templates and inline guidance for users who do not already know regex syntax.

Filters can be combined by drive, file type, extension, size, modified date, full path, and case sensitivity. Conditions within one group use OR; different groups use AND. Sorting is available by relevance, name, path, type, size, or modified time.

Search, filtering, and sorting are executed against the complete result set in the native backend. Results use cursor-based pagination and load automatically near the end of the list, so a query is not limited to the first 800 matches. The UI virtualizes long lists to keep scrolling and memory use stable. Live index changes are deduplicated and reinserted according to the active sort order.

Result tables provide:

- Resizable columns whose widths are remembered.
- File type, size, and modified time for every result.
- Background folder-size calculation with an explicit `>= calculated size` marker when access or time limits prevent a complete total.
- Double-click open behavior and per-row shortcuts for opening, ownership analysis, and safe migration.
- A themed context menu with Open, Show in File Explorer, Open with, Search inside, Analyze ownership, Safe migration, Copy path/name, Copy to, Find same name, Filter by extension, Rename, Properties, and Move to Recycle Bin.
- Saved searches that preserve the query, mode, filters, and sorting. Saved searches can be organized into folders and restored with one click.
- Automatic persistence of the current query, filters, sort order, selected result, content-search scope, and layout across page switches and application restarts.

## Directory-scoped content search

Content search only reads directories explicitly selected by the user; it never scans every file body on the computer by default.

- Uses a local SQLite FTS5 trigram index for Chinese text and arbitrary text fragments.
- Supports common text, source code, configuration, log, CSV, JSON, XML, and script formats.
- Shows file size and modified time in results.
- Uses an independent database for each selected directory and supports manual refresh.
- Skips binary files, reparse points, inaccessible entries, and files larger than 8 MB.
- Skips dependency and generated directories such as `node_modules`, `.git`, `dist`, `build`, `target`, caches, and virtual environments.

These exclusions affect only file-body indexing. File and folder **name search** still includes those paths.

## Disk ownership map and AI analysis

The ownership map scans drive roots, `Program Files`, `ProgramData`, the current user profile, and AppData locations. It classifies entries as application installations, application data, cache, system components, user data, development data, or unresolved directories.

Local analysis correlates:

- Windows uninstall registry entries
- AppX/MSIX package metadata
- Application names, publishers, and installation locations
- App Paths and portable application evidence
- Directory structure, top-level items, extension distribution, file count, and size
- Known AppData, cache, package-manager, development, and system-directory patterns

The correlation is not restricted by drive letter. For example, an application installed on `F:` can still be identified as the owner of data stored on `C:`.

Each result includes evidence, confidence, purpose, likely origin, and migration risk. Results are saved and reused until the user explicitly analyzes again or the source directory has changed enough to make the saved result unreliable.

### Optional AI providers

AI is a secondary judgment layer and is disabled by default. Supported protocols include:

- OpenAI-compatible APIs: OpenAI, DeepSeek, Moonshot/Kimi, Zhipu GLM, Alibaba Cloud Model Studio, Volcengine Ark, Tencent Hunyuan, Baidu Qianfan, MiniMax, SiliconFlow, OpenRouter, Mistral, Groq, xAI, and custom compatible endpoints
- Anthropic Messages API
- Google Gemini Models and GenerateContent APIs
- Local OpenAI-compatible services such as Ollama and LM Studio

Configuration flow:

1. Select a provider.
2. Enter or edit the Base URL and API key.
3. Fetch the available models from the provider.
4. Select a model.
5. Send a minimal test conversation.
6. Save the verified configuration.

If a compatible provider does not expose a model-list endpoint, its published model ID can be entered manually and verified with the test conversation. Changing the URL, key, or model invalidates the previous test.

Privacy mode sends only redacted metadata by default and never sends file bodies. API keys remain in the Electron main process and are encrypted through `safeStorage`; the renderer can only see whether a key has been saved.

## Safe cross-drive migration

Migration accepts a source directory on any local drive and a destination base directory on a different drive. The destination uses the source folder name directly instead of reproducing the complete source hierarchy:

```text
Source:           C:\Users\Example\AppData\Local\SampleCache
Destination base: E:\MovedData
Actual data:      E:\MovedData\SampleCache
Original path:    C:\Users\Example\AppData\Local\SampleCache
                  -> symbolic link or junction -> E:\MovedData\SampleCache
```

The transaction is performed in this order:

1. Validate the source, destination space, protected paths, and reparse points.
2. Copy to a temporary directory with multithreaded Robocopy.
3. Compare file count, directory count, and total bytes.
4. Atomically rename the original directory beside the source.
5. Create a directory symbolic link, falling back to a Windows directory junction when necessary.
6. Verify that the original path resolves to the destination.
7. Delete the verified old copy from the source drive to release space.
8. Persist the migration record.

If the application exits during a transaction, the next run inspects the unfinished state and attempts recovery. Restore copies the complete data back, verifies it, removes the link, and deletes the no-longer-needed destination copy. A history entry can move between **Restore** and **Migrate again**, with a migration counter tracking repeated operations.

### Safety boundaries

- Drive roots, the Windows directory, System Volume Information, the Recycle Bin, default/public user profiles, and critical Microsoft data are blocked.
- Application installation subdirectories can be analyzed but are marked high risk for migration.
- Source reparse points are not followed, preventing loops and out-of-scope copies.
- Source and destination drives must differ.
- The destination must retain an additional 3% or at least 512 MB of free space.
- AI output cannot override hard local path protections.

Prefer an application's built-in Move command or reinstall workflow for its installation directory. Services, drivers, databases, synchronizers, and self-updaters may use resolved physical paths even when the application itself works through a symbolic link.

## Themes and interaction effects

CDriveShiftAI includes five complete themes:

- **Pixel Lake** — pixel-art sky, lake, distant hills, terrain accents, and stepped interaction feedback.
- **Future Hub** — holographic perspective grids, scanning light, HUD rings, and data nodes.
- **Moonlit Crystal** — bright frosted glass, contour lines, and restrained ambient light.
- **Ember Hive** — dark orange industrial HUD, honeycomb geometry, faceted controls, and energy-style progress effects.
- **Warm Ivory** — warm paper-like surfaces, terracotta accents, soft cards, and low-distraction motion.

Themes apply consistently to the main window, standalone quick-search window, tray and context menus, tooltips, property dialogs, migration progress, and update progress. The quick-search title bar includes a compact theme switcher that shares and persists the selection with the main window.

Animations remain responsive during interaction, reduce their frame rate while idle or unfocused, stop when minimized, and respect Windows reduced-motion preferences.

## Global shortcuts, mouse activation, and tray mode

- Global shortcuts can be configured independently for the main window and standalone quick search.
- New shortcuts are test-registered before saving. Conflicts with another CDriveShiftAI action, Windows, or another application remain visible as an inline error instead of interrupting unrelated settings.
- Quick search can also be opened by holding the mouse Back, Forward, or Middle button for a configurable 0.5–10 seconds, or the feature can be disabled.
- Mouse activation uses passive Windows Raw Input and does not block normal short clicks in other applications.
- Settings save automatically when a field loses focus or a selection is completed, then take effect immediately.
- Closing to the notification area releases the Chromium renderer and GPU surfaces while retaining the native index watcher, tray menu, and global shortcuts.

## Data location and privacy

CDriveShiftAI does not store its persistent data in `%APPDATA%\CDriveShiftAI`.

The development workspace stores configuration, caches, logs, migration history, name indexes, and content indexes in:

```text
<project root>\.cdriveshiftai-data
```

Runtime selection follows these rules:

1. `CDRIVESHIFTAI_DATA_DIR`, when set to an absolute path.
2. The portable executable directory from `PORTABLE_EXECUTABLE_DIR`.
3. The repository root when running a build from this project's `release-ready` directory.
4. A `.cdriveshiftai-data` directory beside the installed application.

Choose a writable, non-system installation directory when using the installer. Migration history is persisted across restarts and is not cleared when the application exits.

The single-file portable package is wrapped by NSIS and may briefly extract application files to the Windows temporary directory before launch. Use the unpacked build if the runtime must not perform that temporary extraction.

Local diagnostic logs are rotated by date, automatically cleaned, and redact API keys, authorization tokens, search queries, and file contents. The Settings page can open the log directory or export a diagnostic report containing system information, path-permission checks, updater/index status, summarized migration stages, and crash-file metadata.

## Automatic updates

- The main window checks the official GitHub Release on startup and whenever it is restored from the tray or minimized state; it does not continuously poll while idle in the tray.
- Update checks, manifests, and downloads use Electron's Windows system network session, including system proxy and PAC settings, with direct access as fallback.
- The status dot is green when the current version is up to date and red when a newer release is available. The themed tooltip shows both versions.
- Release notes are displayed inside the application before updating.
- Installed builds update silently in the existing installation directory. Portable builds replace the executable at its original path.
- Interrupted downloads resume from the existing byte count and retry automatically up to three times.
- The main application and the standalone update helper both validate file size and SHA-512; invalid packages are rejected.
- The previous application is backed up on the same drive before replacement. The package and backup are deleted only after the new version starts and reports the expected version; otherwise the old version is restored.
- Progress UI shows downloaded bytes, speed, retry count, validation, backup, replacement, relaunch, and cleanup stages.
- Reinstalling preserves the user's previous desktop-shortcut choice and installed location.

## Performance model

- The first window frame is displayed before full-disk index startup.
- Drive discovery, file-system type, and capacity queries are combined and briefly cached.
- Non-home routes are loaded on demand.
- Native indexing uses a lower Windows process priority during cache loading and full builds, then returns to normal search priority.
- Dynamic refresh events are batched before re-querying a visible search, while hidden and tray-idle sessions do not poll or run dynamic UI searches.
- Large directory changes use shared reads and batched persistence so foreground queries remain responsive.
- Canvas and CSS background effects reduce work while idle and stop while minimized.
- A clean tray exit closes the index communication pipe before waiting for the native process, preventing shutdown-time `EPIPE` errors.

## Development

### Prerequisites

- Windows 10/11 x64
- Node.js 20 or newer
- Rust 1.75 or newer
- Visual Studio 2022 C++ build tools
- Windows SDK

The native build script searches standard Windows SDK locations and can also use an existing adjacent xwin SDK workspace.

### Run locally

```powershell
npm install
npm run dev
```

### Validate and build

```powershell
npm run lint
npm test
npm run build:native
npm run test:native
npm run test:indexer
npm run build:app
npm run dist:all
```

Additional smoke tests cover cache reuse, packaged search state, background CPU, tray idle performance, clean exit, ownership persistence, installed and portable updates, update rejection, and rollback. See `package.json` for the complete command list.

Build artifacts are written to `release-ready`.

## Project structure

```text
electron/              Electron main process, IPC, secure storage, analysis, migration, and updater orchestration
native/indexer/        Rust multi-drive name index, file-system change tracking, and content index
native/updater/        Rust update helper for verified replacement and rollback
src/                   React UI, search logic, shared components, and five visual themes
scripts/               Native build, packaging, release-manifest, and smoke-test scripts
tests/                 Path-protection and application behavior tests
docs/                  Architecture and security design notes
```

The implementation design is documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (Chinese).

## License

CDriveShiftAI is released under the [MIT License](LICENSE).
