# CDriveShiftAI 全功能测试报告

生成时间：2026-08-06

## 一、测试目标
- 执行项目现有单元测试与所有烟雾测试脚本。
- 发现并修复阻塞功能验证的缺陷，不移除现有功能。
- 每条测试记录包含覆盖功能与测试用例。

## 二、测试环境
- 工作目录：`E:\DevelopmentTools\AIDevelop\CDriveShiftAI`
- 平台：Windows（本地）
- 引擎：Node + Electron + Chrome 自动化脚本

## 三、测试记录（按执行顺序）

1. `npm run test`
   - 功能：全量单元测试（核心模块、服务层、辅助工具、类型脚本）
   - 用例：Vitest 全量运行（13 个测试文件 / 46 条用例）
   - 结果：全部通过

2. `npm run test:indexer`
   - 功能：索引器检索能力
   - 用例：名字匹配、分页、复合过滤、作用域过滤、正则搜索、目录创建/删除场景、内容搜索、持久化内容文档
   - 结果：全部通过

3. `npm run test:force-delete`
   - 功能：强制删除与相关进程终止
   - 用例：进程托管、目标移除、返回值校验、删除后清理
   - 结果：全部通过

4. `npm run test:index-cache`
   - 功能：索引缓存生命周期
   - 用例：缓存模式启动、增量重建、重启后增量恢复、手动刷新
   - 结果：全部通过

5. `npm run test:packaged-index-cache`
   - 功能：打包模式下缓存可复用性
   - 用例：启动后缓存读取、二次启动复用、状态与条目数量校验
   - 结果：全部通过

6. `npm run test:background-cpu`
   - 功能：后台任务 CPU 行为
   - 用例：初始、前台重建索引、再次降噪三阶段资源监控
   - 结果：全部通过

7. `npm run test:search-performance`
   - 功能：搜索性能
   - 用例：子串、完整词、模糊匹配查询时延与返回条数
   - 结果：全部通过

8. `npm run test:app-performance`
   - 功能：应用启动与资源占用
   - 用例：UI 可用耗时、索引可用时延、空闲与运行时 CPU/内存、工作进程与索引器活跃性
   - 结果：全部通过

9. `npm run test:tray-performance`
   - 功能：托盘驻留与资源收缩
   - 用例：启动后托盘化场景内存/CPU、子进程裁剪、启动最小化后可恢复
   - 结果：全部通过

10. `npm run test:clean-exit`
    - 功能：优雅退出机制
    - 用例：退出耗时、EPIPE 异常、残留进程
    - 结果：全部通过

11. `npm run test:auto-update`
    - 功能：便携版自动更新主流程
    - 用例：版本更新、替换目标文件、补丁文件与运行时产物清理
    - 结果：全部通过

12. `npm run test:auto-update-rejection`
    - 功能：更新校验失败回退
    - 用例：伪造包校验触发拒绝、主程序版本保持不变
    - 结果：全部通过

13. `npm run test:auto-update-rollback`
    - 功能：启动阶段回滚流程
    - 用例：非法启动副本触发回滚、恢复旧版本、清理失败替换
    - 结果：全部通过

14. `npm run test:installed-update`
    - 功能：已安装版更新流程
    - 用例：安装路径保留、数据保留、备份包清理、安装器副作用检查
    - 结果：全部通过

15. `npm run test:portable`
    - 功能：便携版打包与数据目录分离
    - 用例：单文件启动、数据目录与可执行同目录、环境目录写入
    - 结果：全部通过

16. `npm run test:ownership-state`
    - 功能：归属地图扫描状态持久化
    - 用例：扫描记录恢复、扫描模式不重复运行、历史记录回填
    - 结果：全部通过

17. `npm run test:ownership-map`
    - 功能：归属地图扫描与展示
    - 用例：分类统计、跨盘归属样本、错误计数、分类数量
    - 结果：全部通过

18. `npm run test:analysis-state`
    - 功能：分析结果持久化与恢复
    - 用例：分析入库、上次分析恢复、删除后持久化清理、重启后二次验证
    - 首次结果：首次失败（页面目标连接失败）
    - 修复后结果：全部通过

19. `npm run test:search-state`
    - 功能：搜索、设置、快搜与快捷键/迁移状态
    - 用例：搜索历史与书签、文件夹归属、导航恢复、设置自动保存（系统/AI）、快捷键冲突与历史迁移回放
    - 结果：全部通过

20. `npm run test:visual`
    - 功能：关键界面视觉与交互回归（概览）
    - 用例：概览、设置、搜索、迁移、分析、归属图、AI 设置、多主题快速切换、关键控件布局与交互截图
    - 首次结果：首次失败（无 app root 渲染）
    - 修复后结果：全部通过

21. `node scripts/visual-smoke.mjs "file:///E:/DevelopmentTools/AIDevelop/CDriveShiftAI/dist/index.html?view=search"`
    - 功能：搜索视图可视化回归分支（直接 dist 回放）
    - 用例：搜索视图加载、搜索列宽恢复、搜索模式切换、搜索相关控件快照
    - 结果：通过（`searchSizeColumn: true`）

22. `node scripts/visual-smoke.mjs "file:///E:/DevelopmentTools/AIDevelop/CDriveShiftAI/dist/index.html?view=settings"`
    - 功能：设置视图可视化回归分支（直接 dist 回放）
    - 用例：设置页加载、侧边栏相关控件渲染、设置项快照
    - 结果：通过

23. `node scripts/visual-smoke.mjs "file:///E:/DevelopmentTools/AIDevelop/CDriveShiftAI/dist/index.html?view=ownership-map"`
    - 功能：归属地图视图可视化回归分支（直接 dist 回放）
    - 用例：归属地图加载、上下文菜单、分布图区域与卡片交互快照
    - 结果：通过

24. `node scripts/visual-smoke.mjs "file:///E:/DevelopmentTools/AIDevelop/CDriveShiftAI/dist/index.html?view=analyze"`
    - 功能：分析视图可视化回归分支（直接 dist 回放）
    - 用例：分析页加载、AI 相关切换按钮、清空结果后的状态
    - 结果：通过

25. `node scripts/visual-smoke.mjs "file:///E:/DevelopmentTools/AIDevelop/CDriveShiftAI/dist/index.html?view=migrate"`
    - 功能：迁移视图可视化回归分支（直接 dist 回放）
    - 用例：迁移页加载、阶段展示、迁移历史与状态区域渲染
    - 结果：通过

## 四、发现的缺陷与修复

1. `scripts/visual-smoke.mjs`
   - 问题：当 `dist/index.html` 作为回退入口时，Chrome 文件协议下无法加载模块脚本，页面 `#root` 无子节点导致超时。
   - 现象：`document.getElementById("root")?.children.length` 一直为 0。
   - 修复：
     - 增加 `--allow-file-access-from-files`
     - 增加 `resolvePreviewUrl`，无 Vite 服务时回退到 `dist/index.html`。
     - 统一通过 `fetchPageTarget` 选择有 `webSocketDebuggerUrl` 的 page 目标。
   - 结果：`test:visual` 与各 `view` 参数可稳定通过。

2. `scripts/smoke-analysis-persistence.mjs`
   - 问题：启动阶段直接一次性取 `json/list` 后查 `page` 目标，偶发性取到无 `webSocketDebuggerUrl` 的项导致误判。
   - 现象：`Electron page target was unavailable`、`fetch failed ECONNREFUSED` 间歇出现。
   - 修复：为 `type === "page"` 且有 `webSocketDebuggerUrl` 的目标加入重试循环；连接失败时捕获并继续重试。
   - 结果：`test:analysis-state` 可稳定通过。

## 五、结论
- 当前工作树下，项目现有测试脚本与单元测试在完整回归中均通过。
- 修改仅涉及测试脚本的稳定性与环境兼容性，不涉及业务功能删减。

## 六、最终全量复测（当前状态）

- 复测命令组合（均通过）：`test`, `test:indexer`, `test:force-delete`, `test:index-cache`, `test:packaged-index-cache`, `test:background-cpu`, `test:search-performance`, `test:app-performance`, `test:tray-performance`, `test:clean-exit`, `test:auto-update`, `test:auto-update-rejection`, `test:auto-update-rollback`, `test:installed-update`, `test:portable`, `test:ownership-state`, `test:ownership-map`, `test:analysis-state`, `test:search-state`, `test:visual`
- 额外视图验证命令（均通过）：`node scripts/visual-smoke.mjs` 结合 `?view=search|settings|ownership-map|analyze|migrate`
