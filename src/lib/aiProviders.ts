import type { AiProtocol, AiProviderId } from "../types";

export interface AiProviderPreset {
  id: AiProviderId;
  group: "国际厂商" | "国内厂商" | "聚合平台" | "本地模型" | "自定义";
  name: string;
  shortName: string;
  protocol: AiProtocol;
  baseUrl: string;
  requiresKey: boolean;
  description: string;
  color: string;
}

export const aiProviderPresets: AiProviderPreset[] = [
  {
    id: "openai",
    group: "国际厂商",
    name: "OpenAI",
    shortName: "OA",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    requiresKey: true,
    description: "GPT 系列与 OpenAI API",
    color: "#35d4ad"
  },
  {
    id: "anthropic",
    group: "国际厂商",
    name: "Anthropic Claude",
    shortName: "AN",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    requiresKey: true,
    description: "原生 Models 与 Messages API",
    color: "#d9a879"
  },
  {
    id: "gemini",
    group: "国际厂商",
    name: "Google Gemini",
    shortName: "GE",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    requiresKey: true,
    description: "原生 models.list 与 generateContent",
    color: "#6298ff"
  },
  {
    id: "mistral",
    group: "国际厂商",
    name: "Mistral AI",
    shortName: "MI",
    protocol: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    requiresKey: true,
    description: "Mistral OpenAI 兼容服务",
    color: "#ff9a55"
  },
  {
    id: "groq",
    group: "国际厂商",
    name: "Groq",
    shortName: "GQ",
    protocol: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    requiresKey: true,
    description: "低延迟 OpenAI 兼容推理",
    color: "#f56a63"
  },
  {
    id: "xai",
    group: "国际厂商",
    name: "xAI",
    shortName: "xAI",
    protocol: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    requiresKey: true,
    description: "Grok 系列 OpenAI 兼容服务",
    color: "#d9e0e7"
  },
  {
    id: "deepseek",
    group: "国内厂商",
    name: "DeepSeek",
    shortName: "DS",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    requiresKey: true,
    description: "DeepSeek 官方开放平台",
    color: "#5b8cff"
  },
  {
    id: "moonshot",
    group: "国内厂商",
    name: "Moonshot / Kimi",
    shortName: "KM",
    protocol: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    requiresKey: true,
    description: "Kimi 官方 OpenAI 兼容接口",
    color: "#706dff"
  },
  {
    id: "zhipu",
    group: "国内厂商",
    name: "智谱 GLM",
    shortName: "GLM",
    protocol: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    requiresKey: true,
    description: "智谱 BigModel 开放平台",
    color: "#4f79f7"
  },
  {
    id: "dashscope",
    group: "国内厂商",
    name: "阿里云百炼 / 通义千问",
    shortName: "QW",
    protocol: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    requiresKey: true,
    description: "DashScope OpenAI 兼容接口",
    color: "#786bff"
  },
  {
    id: "volcengine",
    group: "国内厂商",
    name: "火山方舟 / 豆包",
    shortName: "DB",
    protocol: "openai-compatible",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    requiresKey: true,
    description: "火山方舟 Ark API",
    color: "#4587ff"
  },
  {
    id: "tencent-hunyuan",
    group: "国内厂商",
    name: "腾讯混元",
    shortName: "HY",
    protocol: "openai-compatible",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    requiresKey: true,
    description: "混元 OpenAI 兼容接口",
    color: "#4ba7ff"
  },
  {
    id: "baidu-qianfan",
    group: "国内厂商",
    name: "百度千帆 / 文心",
    shortName: "BD",
    protocol: "openai-compatible",
    baseUrl: "https://qianfan.baidubce.com/v2",
    requiresKey: true,
    description: "千帆 ModelBuilder V2",
    color: "#4169e9"
  },
  {
    id: "minimax",
    group: "国内厂商",
    name: "MiniMax",
    shortName: "MM",
    protocol: "openai-compatible",
    baseUrl: "https://api.minimaxi.com/v1",
    requiresKey: true,
    description: "MiniMax OpenAI 兼容服务",
    color: "#f07d56"
  },
  {
    id: "siliconflow",
    group: "聚合平台",
    name: "SiliconFlow 硅基流动",
    shortName: "SF",
    protocol: "openai-compatible",
    baseUrl: "https://api.siliconflow.cn/v1",
    requiresKey: true,
    description: "国内多模型聚合与推理平台",
    color: "#37cf9b"
  },
  {
    id: "openrouter",
    group: "聚合平台",
    name: "OpenRouter",
    shortName: "OR",
    protocol: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
    description: "国际多厂商模型聚合平台",
    color: "#a77bff"
  },
  {
    id: "ollama",
    group: "本地模型",
    name: "Ollama",
    shortName: "OL",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    requiresKey: false,
    description: "本机 Ollama OpenAI 兼容服务",
    color: "#e8eef2"
  },
  {
    id: "lmstudio",
    group: "本地模型",
    name: "LM Studio",
    shortName: "LM",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    requiresKey: false,
    description: "本机 LM Studio 推理服务",
    color: "#38c7dd"
  },
  {
    id: "custom",
    group: "自定义",
    name: "自定义兼容服务",
    shortName: "API",
    protocol: "openai-compatible",
    baseUrl: "",
    requiresKey: false,
    description: "可填写自建网关、局域网或其他兼容地址",
    color: "#95a7b4"
  }
];

export const aiProviderGroups = [
  "国际厂商",
  "国内厂商",
  "聚合平台",
  "本地模型",
  "自定义"
] as const;

export function getAiProvider(id: AiProviderId): AiProviderPreset {
  return (
    aiProviderPresets.find((provider) => provider.id === id) ??
    aiProviderPresets[aiProviderPresets.length - 1]
  );
}
