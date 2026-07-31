import path from "node:path";
import type {
  AnalysisCategory,
  AnalysisRecommendation,
  AnalysisRisk,
  DirectoryInsight
} from "./types";

interface KnowledgeRule {
  names: string[];
  producedBy: string;
  purpose: string;
  howGenerated: string;
  category: AnalysisCategory;
  confidence: number;
  risk: AnalysisRisk;
  recommendation: AnalysisRecommendation;
  riskReason: string;
  evidence: string[];
}

const rules: KnowledgeRule[] = [
  {
    names: [".codex"],
    producedBy: "OpenAI Codex",
    purpose: "Codex CLI、桌面端与 app-server 的用户状态或项目级配置数据",
    howGenerated:
      "由 Codex 在登录、保存配置、创建会话、加载技能和运行任务时创建；用户目录下通常是 CODEX_HOME。",
    category: "application-data",
    confidence: 0.99,
    risk: "high",
    recommendation: "review",
    riskReason:
      "可能包含认证状态、配置、日志、会话、技能和本地数据库。迁移时必须退出 Codex，且不应把此目录当作普通缓存删除。",
    evidence: [
      "目录名与 Codex 默认状态目录 ~/.codex 精确匹配",
      "OpenAI 官方文档说明 CODEX_HOME 默认值为 ~/.codex"
    ]
  },
  {
    names: [".claude"],
    producedBy: "Anthropic Claude Code",
    purpose: "Claude Code 的用户配置、项目状态、命令或会话数据",
    howGenerated: "由 Claude Code 在初始化、保存配置和执行编码会话时创建。",
    category: "application-data",
    confidence: 0.96,
    risk: "high",
    recommendation: "review",
    riskReason: "可能包含认证、配置与活动会话数据；迁移前应彻底退出 Claude Code。",
    evidence: ["目录名与 Claude Code 的约定状态目录精确匹配"]
  },
  {
    names: [".cursor"],
    producedBy: "Cursor",
    purpose: "Cursor 编辑器的用户级配置、扩展、缓存或会话状态",
    howGenerated: "由 Cursor 安装、更新、加载扩展和使用工作区时创建。",
    category: "application-data",
    confidence: 0.95,
    risk: "medium",
    recommendation: "review",
    riskReason: "迁移时 Cursor 或扩展仍可能写入；应退出应用并在迁移后验证扩展与登录状态。",
    evidence: ["目录名与 Cursor 用户数据目录特征精确匹配"]
  },
  {
    names: [".vscode"],
    producedBy: "Visual Studio Code",
    purpose: "VS Code 的工作区配置、推荐扩展或用户级扩展数据",
    howGenerated: "由 VS Code 或工作区在保存设置、任务、调试配置和安装扩展时创建。",
    category: "development",
    confidence: 0.96,
    risk: "medium",
    recommendation: "review",
    riskReason: "项目内目录通常可随项目移动；用户目录下可能含大量扩展，应先退出 VS Code。",
    evidence: ["目录名与 VS Code 约定目录精确匹配"]
  },
  {
    names: [".ollama"],
    producedBy: "Ollama",
    purpose: "Ollama 的本地模型、清单、密钥与运行状态数据",
    howGenerated: "由 Ollama 拉取或运行本地模型时创建。",
    category: "application-data",
    confidence: 0.98,
    risk: "high",
    recommendation: "review",
    riskReason: "可能包含体积很大的模型和正在被服务占用的文件；迁移前必须停止 Ollama 服务。",
    evidence: ["目录名与 Ollama 用户数据目录精确匹配"]
  },
  {
    names: [".docker", "dockerdesktop"],
    producedBy: "Docker / Docker Desktop",
    purpose: "Docker 客户端配置、上下文、凭据辅助信息或 Docker Desktop 状态",
    howGenerated: "由 Docker CLI 或 Docker Desktop 初始化和运行容器环境时创建。",
    category: "application-data",
    confidence: 0.96,
    risk: "high",
    recommendation: "review",
    riskReason: "可能含凭据配置，且 Docker/WSL 后端可能持续占用数据；优先使用 Docker 自带的数据位置设置。",
    evidence: ["目录名与 Docker 客户端或 Docker Desktop 数据特征匹配"]
  },
  {
    names: [".npm", "_cacache", ".pnpm-store", ".yarn"],
    producedBy: "Node.js 包管理器",
    purpose: "npm、pnpm 或 Yarn 的软件包缓存、元数据与下载内容",
    howGenerated: "由包管理器安装、更新或缓存依赖时创建。",
    category: "development",
    confidence: 0.94,
    risk: "low",
    recommendation: "migrate",
    riskReason: "通常可重建，但迁移时不应同时运行包安装；部分配置可改用包管理器的缓存位置选项。",
    evidence: ["目录名与 Node.js 包管理器约定目录精确匹配"]
  },
  {
    names: ["node_modules"],
    producedBy: "Node.js 包管理器",
    purpose: "当前 JavaScript/TypeScript 项目的已安装依赖",
    howGenerated: "由 npm、pnpm、Yarn 或兼容工具执行依赖安装时生成。",
    category: "development",
    confidence: 0.99,
    risk: "low",
    recommendation: "migrate",
    riskReason: "可由锁文件重建；移动时应停止开发服务器、构建器和包管理器。",
    evidence: ["目录名 node_modules 是 Node.js 依赖目录标准名称"]
  },
  {
    names: [".gradle"],
    producedBy: "Gradle",
    purpose: "Gradle 构建缓存、下载的依赖、守护进程与构建状态",
    howGenerated: "由 Gradle、Android Studio 或其他 JVM 构建任务创建。",
    category: "development",
    confidence: 0.98,
    risk: "medium",
    recommendation: "review",
    riskReason: "大部分内容可重建，但迁移时必须停止 Gradle daemon 与 IDE 构建任务。",
    evidence: ["目录名与 Gradle 用户主目录精确匹配"]
  },
  {
    names: [".m2"],
    producedBy: "Apache Maven",
    purpose: "Maven 本地依赖仓库和用户配置",
    howGenerated: "由 Maven 或使用 Maven 的 IDE 下载依赖、安装本地构件时创建。",
    category: "development",
    confidence: 0.98,
    risk: "medium",
    recommendation: "review",
    riskReason: "仓库大多可重新下载，但 settings.xml 可能含私有仓库配置或凭据。",
    evidence: ["目录名与 Maven 本地仓库父目录精确匹配"]
  },
  {
    names: [".nuget"],
    producedBy: "NuGet / .NET",
    purpose: ".NET NuGet 包缓存、插件与用户级配置",
    howGenerated: "由 dotnet、NuGet 或 Visual Studio 还原和构建项目时创建。",
    category: "development",
    confidence: 0.98,
    risk: "medium",
    recommendation: "review",
    riskReason: "包缓存可重建，但配置可能含私有源；迁移时应停止 IDE 与 dotnet 构建进程。",
    evidence: ["目录名与 NuGet 用户数据目录精确匹配"]
  },
  {
    names: [".cargo", ".rustup"],
    producedBy: "Rust 工具链",
    purpose: "Cargo 包缓存、已安装工具或 Rustup 工具链",
    howGenerated: "由 Cargo、rustup 和 Rust 构建任务安装依赖或工具链时创建。",
    category: "development",
    confidence: 0.98,
    risk: "medium",
    recommendation: "review",
    riskReason: "可能被编译器、语言服务和包安装占用；迁移后需验证 CARGO_HOME/RUSTUP_HOME 与工具链。",
    evidence: ["目录名与 Rust 官方工具链约定目录精确匹配"]
  },
  {
    names: [".git"],
    producedBy: "Git",
    purpose: "当前仓库的版本历史、分支、对象数据库与仓库配置",
    howGenerated: "由 Git 初始化或克隆仓库时创建，并在每次版本控制操作中更新。",
    category: "development",
    confidence: 0.99,
    risk: "high",
    recommendation: "review",
    riskReason: "这是仓库历史而非缓存；损坏或遗漏会导致版本历史丢失，迁移时不能运行 Git 操作。",
    evidence: ["目录名 .git 是 Git 仓库元数据标准名称"]
  },
  {
    names: [".cache", "cache", "caches", "code cache", "gpu cache", "temp", "tmp"],
    producedBy: "上级应用或系统组件",
    purpose: "可重建的缓存或临时运行数据",
    howGenerated: "由上级应用在下载、渲染、编译或加速读取时创建。",
    category: "cache",
    confidence: 0.86,
    risk: "medium",
    recommendation: "review",
    riskReason: "通常可清理或重建，但必须先确认上级应用；活动应用可能持续写入。",
    evidence: ["目录名符合常见缓存或临时目录模式"]
  }
];

function normalizeForMatch(targetPath: string): string {
  return targetPath.replace(/[\\/]+$/, "").toLocaleLowerCase();
}

function nameOf(targetPath: string): string {
  const trimmed = targetPath.replace(/[\\/]+$/, "");
  return path.win32.basename(trimmed) || trimmed;
}

function insightFromRule(targetPath: string, rule: KnowledgeRule): DirectoryInsight {
  return {
    path: targetPath,
    name: nameOf(targetPath),
    purpose: rule.purpose,
    producedBy: rule.producedBy,
    howGenerated: rule.howGenerated,
    category: rule.category,
    confidence: rule.confidence,
    risk: rule.risk,
    riskReason: rule.riskReason,
    source: "known-signature",
    evidence: rule.evidence,
    webSources: []
  };
}

export function inferKnownDirectory(targetPath: string): DirectoryInsight | undefined {
  const normalized = normalizeForMatch(targetPath);
  const name = nameOf(targetPath).toLocaleLowerCase();

  if (/^[a-z]:$/i.test(normalized)) {
    return {
      path: targetPath,
      name: `${normalized.toUpperCase()}\\`,
      purpose: "Windows 磁盘卷根目录，承载该卷上的系统、应用与用户数据",
      producedBy: "Windows 与已安装应用",
      howGenerated: "由磁盘分区和文件系统创建，内容由系统、应用及用户共同产生。",
      category: "system",
      confidence: 0.99,
      risk: "blocked",
      riskReason: "不能把整个磁盘根目录作为单个应用目录迁移；应选择其下明确的子目录。",
      source: "path-rule",
      evidence: ["路径是本地盘符根目录"],
      webSources: []
    };
  }

  const protectedRoots: Array<[RegExp, string, string]> = [
    [/\\windows$/i, "Microsoft Windows", "Windows 操作系统核心文件、组件存储、驱动与运行时数据"],
    [
      /\\program files(?: \(x86\))?$/i,
      "Windows 应用安装体系",
      "系统级应用的默认安装根目录，包含多个相互独立的应用"
    ],
    [
      /\\programdata$/i,
      "Windows 与已安装应用",
      "面向全体用户的共享应用配置、服务状态、缓存与数据库"
    ],
    [/\\users$/i, "Windows 用户配置体系", "本机用户配置文件与个人数据的容器目录"],
    [/\\system volume information$/i, "Microsoft Windows", "卷影复制、还原点和文件系统服务数据"],
    [/\\\$recycle\.bin$/i, "Microsoft Windows", "该卷的回收站系统数据"]
  ];
  const protectedRule = protectedRoots.find(([pattern]) => pattern.test(normalized));
  if (protectedRule) {
    return {
      path: targetPath,
      name: nameOf(targetPath),
      producedBy: protectedRule[1],
      purpose: protectedRule[2],
      howGenerated: "由 Windows 或系统级安装/服务机制创建并持续维护。",
      category: "system",
      confidence: 0.99,
      risk: "blocked",
      riskReason: "这是系统或共享容器目录，整体迁移会破坏 Windows、服务或多个应用。",
      source: "path-rule",
      evidence: ["路径与 Windows 约定系统目录精确匹配"],
      webSources: []
    };
  }

  const userFolder: Array<[RegExp, string]> = [
    [/\\desktop$/i, "用户桌面文件"],
    [/\\documents$/i, "用户文档"],
    [/\\downloads$/i, "用户下载内容"],
    [/\\pictures$/i, "用户图片"],
    [/\\videos$/i, "用户视频"],
    [/\\music$/i, "用户音乐"]
  ];
  const userMatch = userFolder.find(([pattern]) => pattern.test(normalized));
  if (userMatch) {
    return {
      path: targetPath,
      name: nameOf(targetPath),
      producedBy: "Windows 用户配置与用户本人",
      purpose: userMatch[1],
      howGenerated: "由 Windows 创建默认目录，内容主要由用户和应用保存。",
      category: "user-data",
      confidence: 0.98,
      risk: "low",
      riskReason: "数据通常可迁移，但建议优先使用 Windows“位置”功能迁移已知文件夹。",
      source: "path-rule",
      evidence: ["路径与 Windows 已知用户文件夹精确匹配"],
      webSources: []
    };
  }

  const rule = rules.find((item) => item.names.includes(name));
  return rule ? insightFromRule(targetPath, rule) : undefined;
}

export function recommendationForInsight(insight: DirectoryInsight): AnalysisRecommendation {
  if (insight.risk === "blocked") return "keep";
  if (insight.risk === "high") return "review";
  return insight.category === "cache" ? "review" : insight.risk === "low" ? "migrate" : "review";
}
