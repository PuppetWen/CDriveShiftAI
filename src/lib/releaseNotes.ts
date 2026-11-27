import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  "version": "0.2.6",
  "summary": "修复指定盘符或文件夹后漏搜文件的问题，索引就绪后自动更新当前搜索。",
  "sections": [
    {
      "title": "指定搜索位置",
      "items": [
        "修复选择 C 盘等盘符，或所选文件夹路径以分隔符结尾时，名称搜索错误返回零条结果的问题。",
        "支持同时选择多个范围，并区分名称前缀相同的相邻文件夹。"
      ]
    },
    {
      "title": "索引准备期间",
      "items": [
        "索引未就绪时显示有限的实时搜索结果，并标明结果尚未完整。",
        "索引就绪后自动按当前关键词、位置和筛选重新查询，包括从上次会话恢复的搜索。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  "version": "0.2.6",
  "summary": "Fix missing results in selected drives and folders, and refresh the current search when the index is ready.",
  "sections": [
    {
      "title": "Search locations",
      "items": [
        "Fix empty name search results when a drive such as C: is selected or when a folder path ends with a separator.",
        "Multiple locations can be searched together while keeping similarly named sibling folders separate."
      ]
    },
    {
      "title": "Index startup",
      "items": [
        "Show limited live results while the index is preparing and label those results as incomplete.",
        "When the index becomes ready, rerun the current or restored search with its selected locations and filters."
      ]
    }
  ]
};
