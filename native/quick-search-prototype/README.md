# Windows 原生搜索

这是 Win32/Rust 搜索窗口。正式版使用 `--hosted` 启动界面，通过 JSON Lines 调用主进程的搜索服务，共用索引、游标和书签。界面进程无需加载 Electron、WebView 或 Node。独立验证模式使用专用索引目录。

名称搜索支持多目录、类型、多选类别、扩展名、大小、修改日期、普通匹配、整词、模糊、正则、路径匹配、区分大小写及升降序排序。附加关键词每行一项，和主输入一起按「任意命中」查询。大小填写字节数，修改日期填写本地日期 `YYYY-MM-DD`。

全文搜索需要一个绝对目录。选择「全文搜索」，填写目录并点击「建立全文索引」，即可搜索关键词或正则并显示命中预览。名称和全文独立使用引擎游标；虚拟列表各持有当前页，名称最多 120 条，全文最多 80 条。快速输入只排队最后一次查询。取消和切换模式会清除待发搜索并忽略旧结果。当前协议没有取消已发送请求的命令，所以已发请求和后台全文建库会自行结束。

## 本机离线运行

在仓库根目录，把已经存在的 Rust、MSVC 和 Windows SDK 路径传给当前 PowerShell 进程。示例使用本机工具，不做全局设置。在其他开发机应替换路径。

```powershell
$project = (Get-Location).Path
$env:CARGO_HOME = Join-Path $project '.cache\cargo'
$env:RUSTUP_HOME = 'E:\Environment\rust\1.99.0\rustup'
$env:TEMP = Join-Path $project '.task-tmp\native-build'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$msvc = 'E:\Environment\msvc\14.44.35229\VC\Tools\MSVC\14.44.35207'
$sdk = 'E:\DevelopmentTools\AIDevelop\EnvNexusAI\.devtools\xwin-sdk'
$env:PATH = "$msvc\bin\Hostx64\x64;$env:PATH"
$env:LIB = "$msvc\lib\x64;$sdk\crt\lib\x86_64;$sdk\sdk\lib\ucrt\x86_64;$sdk\sdk\lib\um\x86_64"
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = "$msvc\bin\Hostx64\x64\link.exe"
& 'E:\Environment\rust\1.99.0\cargo\bin\cargo.exe' +1.99.0 build --offline --locked --release --manifest-path native/quick-search-prototype/Cargo.toml
```

先用一小段目录验证；`--root '*'` 允许索引整个本机，首次需要扫描。在 `--data` 下安全使用独立的 `native-quick-search-prototype` 子目录。

```powershell
& .\native\quick-search-prototype\target\release\cshift-quick-search-prototype.exe `
  --indexer .\native\indexer\target\release\cshift-indexer.exe `
  --root (Join-Path $project 'native\indexer\src') `
  --data (Join-Path $project '.task-tmp\native-search')
```

## 验证

```powershell
& 'E:\Environment\node\24.21.0\node.exe' native/quick-search-prototype/smoke.mjs
& 'E:\Environment\node\24.21.0\node.exe' native/quick-search-prototype/smoke-hosted.mjs
& 'E:\Environment\node\24.21.0\node.exe' native/quick-search-prototype/smoke-actions.mjs
```

烟测在隔离目录里比较直接索引器 IPC 与原型发出的名称及全文请求，包括多关键词 OR、大小和日期边界、扩展名、正则、模糊、路径、中文与分页。随后由外部 Win32 消息实际驱动同一窗口，检查高级筛选、全文建库和分页、取消以及切回名称搜索。`--probe <JSON 查询数组>` 走同一请求路径输出搜索页，可包含 `query`、`contentIndex` 与 `contentQuery`。

托管烟测使用模拟主进程启动实际 Win32 窗口，验证可见性、伸缩、搜索筛选、索引就绪重查和退出。原生搜索与完整界面共用书签。常用文件操作从原生窗口发起，由主进程统一处理。使用「完整搜索」可管理书签文件夹和使用其余高级操作。
