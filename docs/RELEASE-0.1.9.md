# CDriveShiftAI 0.1.9 修复与验证

本地交付位于 `release-v0.1.9/`：安装包 `CDriveShiftAI-x64.exe`、便携包 `CDriveShiftAI-x64-portable.exe` 和 SHA-512 清单 `update-manifest.json`。本次未发布到 GitHub。

## 更新检查 403

同一 Windows 系统代理 `PROXY 127.0.0.1:7890` 下实测 GitHub Release API 返回 403，响应的匿名 API 额度上限为 60，剩余为 0。代理已生效；浏览器可以访问 GitHub 页面不代表匿名 REST API 仍有额度。

现在在 API 不可用时，读取 GitHub 官方最新 Release 重定向，再从具体版本读取更新清单。下载地址绑定该版本，继续验证文件大小和 SHA-512；并发检查共享请求，限流后等待冷却。无需新增 GitHub Token。

真实 Electron 网络验证：API 限流时，经现有代理成功检出官方 v0.1.8。

## 强制删除

确认了一处可复现原因：提升权限删除把 Windows 目录中的所有可执行程序当作受保护进程，因此普通 PowerShell 即使真实占用目标也被跳过。

- 改为复核 PID、启动时间、名称、程序位置、关键进程状态，允许处理已确认的普通终端占用。
- 支持停止可停止、独占一个进程且不是关键系统服务的第三方服务；再次验证服务与进程的关联。存在运行中的依赖服务或共享进程时不停止。
- 对目录短暂非空增加重试，保留实际失败子路径；有新占用者时要求重新预检，避免误结束无关进程。
- 新增“AI 分析占用原因”，发送目标路径、真实检测的进程和失败信息，不读取文件正文。分析结果按纯文本显示，不执行 AI 生成的命令；刷新名单后确认，才执行删除。
- 保留关键系统目录、系统进程、应用自身及迁移事务保护。驱动或内核锁仍可能阻止在线删除，失败时显示原因，不能保证任何文件都能立即删除。

## 多关键词搜索

文件夹、文件名称及文件内容均支持：输入时实时搜索，回车提交为标签，点击标签编辑，单独移除标签，选择“全部关键词”或“任一关键词”。支持最多 32 个标签、中文输入法、模糊/整词/正则搜索、全局排序分页、书签和独立窗口状态恢复。旧书签的空格分词语义保留；清空查询后旧请求不能回写结果。

## 验证

- 前端、Electron TypeScript 检查及生产构建通过。
- 更新相关 16 项测试通过；删除相关 93 项测试通过；AI 证据边界和输出处理测试通过。
- 真实独占文件锁、PowerShell 当前目录锁、深层目录、中文长路径、只读文件测试通过，同时确认外部 junction 和硬链接目标未被修改。
- 原生 Rust 12 项测试通过；新索引程序对真实文件、文件夹、中文正文、AND/OR 和分页的端到端测试通过。
- 浏览器交互测试覆盖标签输入、编辑、匹配模式、书签、独立窗口恢复、清空查询竞态，以及删除确认、AI 分析和失败处理。
- 解包程序和便携包均完成隔离数据目录下的启动、正常退出测试。
- 全量 Vitest：326 通过、3 跳过、1 失败。失败为已有的 `migration.test.ts` / `preserves explicit NTFS directory access permissions`，单独复跑仍失败；本轮未改迁移代码。本机继承 ACL 与既有权限回退的逐条校验不兼容，未在本次扩大修改范围。
- 当前会话未提升权限创建真实 Windows 服务，服务停用决策和调用路由使用替身验证；未调用用户的真实 AI 服务产生测试请求。

## 构建环境

使用 `E:\Environment\node\24.21.0`、现有 Rust 1.99、NDK clang-cl 和已有 xwin SDK。新增 `scripts/build-native-local.ps1`（PowerShell 5.1、UTF-8 BOM），原生构建缓存 `.cache/cargo`，临时目录 `.task-tmp/native-build`。不覆盖现有工具版本，不改永久环境变量。

原生索引可重复构建：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-native-local.ps1 -Project indexer
```

SDK 默认复用邻项目 `EnvNexusAI/.devtools/xwin-sdk`，可用 `-SdkRoot` 指定其他已存在的 SDK；缺少依赖时显式使用 `-AllowDownloads` 下载到项目缓存。打包使用项目 `.cache/electron-builder` 和 `.task-tmp/repair-verification`，本次构建选择 winCodeSign 1.1.0、NSIS 1.2.1 工具组件，不进行代码签名。

部分本次临时产物的限定路径清理被自动审批拒绝（仅返回 `blocked by policy`），未绕过：`.task-tmp/update-network-check.cjs`、`.task-tmp/update-network-profile`、`.task-tmp/update-check-main`、`.test-tmp/delete-engine/ModuleAnalysisCache`、`.test-tmp/search-keywords-qhRxZg`；最终清理 `.task-tmp/repair-verification`、`.test-tmp/force-delete-guidance-D3dxGY` 和发布目录中 `.icon-ico`、`builder-debug.yml` 的操作也被同样拒绝，故保留测试证据与这些中间产物。用户原有 `scripts/build-native.ps1` 修改和 `review-artifacts/` 均保留。
