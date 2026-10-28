import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  "version": "0.2.0",
  "summary": "多关键词按或关系合并结果，优化实时搜索和后台占用，支持键盘删词、Ctrl 多选、拖动框选与主题荧光焦点。",
  "sections": [
    {
      "title": "关键词输入",
      "items": [
        "输入框为空时按 Backspace 或 Delete 删除上一颗完整关键词，连续按键可继续删除；输入法组词时避免误删。",
        "输入框和标签编辑采用主题荧光效果，提示精简为“回车确认关键词，点击标签可编辑”。"
      ]
    },
    {
      "title": "结果选择",
      "items": [
        "名称与文件内容搜索结果支持 Ctrl 加左键增减选择和拖动框选。",
        "框选兼容虚拟列表与滚动，拖动结束后保留选择；隐藏窗口或结束拖动后停止框选处理。"
      ]
    },
    {
      "title": "更快的实时搜索",
      "items": [
        "恢复适用于多个关键词或关系的索引预筛，减少全量名称转换；分页只选取需要的结果并避免重复字符串分配。",
        "名称和内容搜索更快发起，连续输入合并为最新请求；输入法组词时暂停搜索，回车生成相同标签不重复查询。",
        "结果更新让位于输入操作，复用短期文件元数据，避免每次输入重复读取磁盘。"
      ]
    },
    {
      "title": "后台保持安静",
      "items": [
        "隐藏或最小化窗口取消查询和目录大小计算；保留原生索引后台暂停机制，不增加轮询。",
        "目录大小仅在停止输入后计算可见行，每批最多24项，限制自动统计时间与条目；显式属性查看保持较大统计预算。",
        "目录结果与文件元数据采用有界缓存，索引变化后失效；关闭主窗口时仍可继续使用可见的独立搜索窗口。"
      ]
    },
    {
      "title": "多关键词结果合并",
      "items": [
        "文件夹、文件名称和文件内容只需命中任意关键词即可显示，不再要求同时包含所有关键词。",
        "移除全部/任一切换，保留回车标签、点击编辑和实时搜索；旧书签与搜索状态自动使用或关系。",
        "在索引查询层合并、排序和分页，命中多个关键词的项目不会重复显示。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  "version": "0.2.0",
  "summary": "Combine keyword results with OR, improve live search and background efficiency, and add keyboard chip deletion, Ctrl selection, drag selection and themed focus glow.",
  "sections": [
    {
      "title": "Keyword input",
      "items": [
        "Press Backspace or Delete in an empty draft to remove the previous chip; IME composition never removes chips.",
        "Use a theme-aware glow for search and tag editing, with a shorter keyword hint."
      ]
    },
    {
      "title": "Result selection",
      "items": [
        "Ctrl-click toggles selected results and dragging draws a selection box in name and content search.",
        "Selection works across virtual rows and scrolling; drag handling stops when the gesture ends or the window is hidden."
      ]
    },
    {
      "title": "Faster live search",
      "items": [
        "Restore candidate signatures for OR queries and select only the needed page instead of repeatedly sorting every candidate.",
        "Dispatch live searches sooner, coalesce typing to the latest query, pause during IME composition and avoid repeating unchanged queries when committing chips.",
        "Prioritize input over result rendering and reuse short-lived file metadata to reduce disk access."
      ]
    },
    {
      "title": "Quiet background operation",
      "items": [
        "Cancel queries and directory sizing for hidden/minimized windows without adding polling.",
        "Size only visible folders after idle input, up to 24 per batch with a bounded automatic budget; explicit properties retain their larger scan budget.",
        "Keep caches bounded and invalidate them on index changes. A visible standalone search stays active when the main window closes."
      ]
    },
    {
      "title": "Combine keyword results",
      "items": [
        "Folder names, filenames, and file contents appear when any keyword matches.",
        "Remove the All/Any selector while keeping editable chips and live search. Saved searches also use OR.",
        "Combine, sort, and paginate in the index; items matching several keywords appear only once."
      ]
    }
  ]
};
