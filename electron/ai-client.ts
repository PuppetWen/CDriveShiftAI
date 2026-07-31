import type {
  AiConnectionInput,
  AiModelInfo,
  AiModelListResult,
  AiProtocol,
  AiProviderId
} from "./types";

export interface ResolvedAiConnection {
  provider: AiProviderId;
  protocol: AiProtocol;
  baseUrl: string;
  model?: string;
  apiKey?: string;
}

interface TextRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

const nonChatModelPattern =
  /(embedding|rerank|whisper|transcri|tts|speech|audio|image|stable-diffusion|flux|video|moderation|bge[-_/]|e5[-_/])/i;
const providerIds = new Set<AiProviderId>([
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "moonshot",
  "zhipu",
  "dashscope",
  "siliconflow",
  "volcengine",
  "tencent-hunyuan",
  "baidu-qianfan",
  "minimax",
  "openrouter",
  "mistral",
  "groq",
  "xai",
  "ollama",
  "lmstudio",
  "custom"
]);

function endpoint(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

function responseError(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (record.error && typeof record.error === "object") {
    const error = record.error as Record<string, unknown>;
    if (typeof error.message === "string") return error.message;
  }
  if (typeof record.error === "string") return record.error;
  return "";
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

async function checkedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw new Error(`无法连接 AI 服务：${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await readBody(response);
  if (!response.ok) {
    const detail = responseError(body);
    throw new Error(
      `AI 服务返回 ${response.status}${detail ? `：${detail.slice(0, 400)}` : ""}`
    );
  }
  return body;
}

function openAiHeaders(apiKey?: string): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  };
}

function anthropicHeaders(apiKey?: string): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(apiKey ? { "x-api-key": apiKey } : {})
  };
}

function geminiHeaders(apiKey?: string): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    ...(apiKey ? { "x-goog-api-key": apiKey } : {})
  };
}

function cleanModel(
  raw: Record<string, unknown>,
  protocol: AiProtocol
): AiModelInfo | undefined {
  const rawId =
    typeof raw.id === "string"
      ? raw.id
      : typeof raw.name === "string"
        ? raw.name
        : typeof raw.model === "string"
          ? raw.model
          : "";
  const id = protocol === "gemini" ? rawId.replace(/^models\//, "") : rawId;
  if (!id || id.length > 512) return undefined;
  if (protocol !== "anthropic" && protocol !== "gemini" && nonChatModelPattern.test(id)) {
    return undefined;
  }
  const displayName =
    typeof raw.display_name === "string"
      ? raw.display_name
      : typeof raw.displayName === "string"
        ? raw.displayName
        : id;
  return {
    id,
    name: displayName,
    provider:
      typeof raw.owned_by === "string"
        ? raw.owned_by
        : typeof raw.type === "string"
          ? raw.type
          : undefined,
    description: typeof raw.description === "string" ? raw.description.slice(0, 300) : undefined,
    createdAt:
      typeof raw.created_at === "string"
        ? raw.created_at
        : typeof raw.created === "number"
          ? new Date(raw.created * 1000).toISOString()
          : undefined
  };
}

function uniqueModels(models: AiModelInfo[]): AiModelInfo[] {
  return [
    ...new Map(models.map((model) => [model.id.toLocaleLowerCase(), model])).values()
  ].sort((first, second) =>
    first.name.localeCompare(second.name, "zh-CN", {
      numeric: true,
      sensitivity: "base"
    })
  );
}

export function validateAiConnection(input: AiConnectionInput): ResolvedAiConnection {
  if (
    !["openai-compatible", "anthropic", "gemini"].includes(input.protocol) ||
    !providerIds.has(input.provider)
  ) {
    throw new Error("AI 厂商或接口协议无效");
  }
  const rawUrl = input.baseUrl.trim();
  if (!rawUrl || rawUrl.length > 2_048) throw new Error("请填写有效的 API Base URL");
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("API Base URL 格式无效");
  }
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error("AI 服务地址只允许 HTTP 或 HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("请不要把账号或密钥写在 URL 中");
  }
  const apiKey =
    typeof input.apiKey === "string" && input.apiKey.trim()
      ? input.apiKey.trim()
      : undefined;
  if (apiKey && apiKey.length > 65_536) throw new Error("API Key 长度异常");
  const model =
    typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;
  if (model && model.length > 512) throw new Error("模型 ID 长度异常");
  return {
    provider: input.provider,
    protocol: input.protocol,
    baseUrl: rawUrl.replace(/\/+$/, ""),
    model,
    apiKey
  };
}

export async function discoverAiModels(
  connection: ResolvedAiConnection
): Promise<AiModelListResult> {
  const started = performance.now();
  let rawModels: Array<Record<string, unknown>> = [];

  if (connection.protocol === "gemini") {
    const body = (await checkedFetch(
      endpoint(connection.baseUrl, "models?pageSize=1000"),
      { method: "GET", headers: geminiHeaders(connection.apiKey) },
      20_000
    )) as { models?: Array<Record<string, unknown>> };
    rawModels = (body.models ?? []).filter((model) => {
      const methods = model.supportedGenerationMethods;
      return (
        !Array.isArray(methods) ||
        methods.some((method) => String(method).toLocaleLowerCase() === "generatecontent")
      );
    });
  } else {
    const suffix =
      connection.provider === "siliconflow"
        ? "models?type=text&sub_type=chat"
        : connection.protocol === "anthropic"
          ? "models?limit=100"
          : "models";
    const body = (await checkedFetch(
      endpoint(connection.baseUrl, suffix),
      {
        method: "GET",
        headers:
          connection.protocol === "anthropic"
            ? anthropicHeaders(connection.apiKey)
            : openAiHeaders(connection.apiKey)
      },
      20_000
    )) as {
      data?: Array<Record<string, unknown>>;
      models?: Array<Record<string, unknown>>;
    };
    rawModels = body.data ?? body.models ?? [];
  }

  const models = uniqueModels(
    rawModels
      .map((model) => cleanModel(model, connection.protocol))
      .filter((model): model is AiModelInfo => Boolean(model))
  );
  if (models.length === 0) {
    throw new Error("服务已连接，但没有返回可用于文本对话的模型");
  }
  return {
    models,
    latencyMs: Math.max(0, performance.now() - started)
  };
}

function extractOpenAiText(body: unknown): string {
  const response = body as {
    choices?: Array<{
      text?: string;
      message?: { content?: string | Array<{ type?: string; text?: string }> };
    }>;
  };
  const choice = response.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }
  return typeof choice?.text === "string" ? choice.text.trim() : "";
}

function extractAnthropicText(body: unknown): string {
  const response = body as { content?: Array<{ type?: string; text?: string }> };
  return (response.content ?? [])
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function extractGeminiText(body: unknown): string {
  const response = body as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return (response.candidates?.[0]?.content?.parts ?? [])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

export async function completeAiText(
  connection: ResolvedAiConnection,
  request: TextRequest,
  timeoutMs = 45_000
): Promise<string> {
  if (!connection.model) throw new Error("请先选择模型");
  let body: unknown;
  if (connection.protocol === "anthropic") {
    body = await checkedFetch(
      endpoint(connection.baseUrl, "messages"),
      {
        method: "POST",
        headers: anthropicHeaders(connection.apiKey),
        body: JSON.stringify({
          model: connection.model,
          max_tokens: request.maxTokens ?? 256,
          system: request.system,
          messages: [{ role: "user", content: request.user }]
        })
      },
      timeoutMs
    );
    const text = extractAnthropicText(body);
    if (text) return text;
  } else if (connection.protocol === "gemini") {
    const model = connection.model.replace(/^models\//, "");
    body = await checkedFetch(
      endpoint(connection.baseUrl, `models/${encodeURIComponent(model)}:generateContent`),
      {
        method: "POST",
        headers: geminiHeaders(connection.apiKey),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: "user", parts: [{ text: request.user }] }],
          generationConfig: { maxOutputTokens: request.maxTokens ?? 256 }
        })
      },
      timeoutMs
    );
    const text = extractGeminiText(body);
    if (text) return text;
  } else {
    body = await checkedFetch(
      endpoint(connection.baseUrl, "chat/completions"),
      {
        method: "POST",
        headers: openAiHeaders(connection.apiKey),
        body: JSON.stringify({
          model: connection.model,
          stream: false,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user }
          ]
        })
      },
      timeoutMs
    );
    const text = extractOpenAiText(body);
    if (text) return text;
  }
  throw new Error("AI 服务返回成功，但没有可读取的文本内容");
}
