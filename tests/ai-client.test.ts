import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  completeAiText,
  discoverAiModels,
  validateAiConnection
} from "../electron/ai-client";

let baseUrl = "";
const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  response.setHeader("content-type", "application/json");
  const url = request.url ?? "";

  if (request.method === "GET" && url === "/openai/models") {
    expect(request.headers.authorization).toBe("Bearer openai-key");
    response.end(
      JSON.stringify({
        data: [
          { id: "chat-alpha", object: "model", owned_by: "fixture" },
          { id: "text-embedding-test", object: "model", owned_by: "fixture" }
        ]
      })
    );
    return;
  }
  if (request.method === "POST" && url === "/openai/chat/completions") {
    response.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "OpenAI 测试成功" } }]
      })
    );
    return;
  }
  if (request.method === "GET" && url === "/anthropic/models?limit=100") {
    expect(request.headers["x-api-key"]).toBe("anthropic-key");
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    response.end(
      JSON.stringify({
        data: [{ id: "claude-fixture", display_name: "Claude Fixture", type: "model" }]
      })
    );
    return;
  }
  if (request.method === "POST" && url === "/anthropic/messages") {
    response.end(JSON.stringify({ content: [{ type: "text", text: "Claude 测试成功" }] }));
    return;
  }
  if (request.method === "GET" && url === "/gemini/models?pageSize=1000") {
    expect(request.headers["x-goog-api-key"]).toBe("gemini-key");
    response.end(
      JSON.stringify({
        models: [
          {
            name: "models/gemini-fixture",
            displayName: "Gemini Fixture",
            supportedGenerationMethods: ["generateContent"]
          },
          {
            name: "models/embedding-fixture",
            supportedGenerationMethods: ["embedContent"]
          }
        ]
      })
    );
    return;
  }
  if (
    request.method === "POST" &&
    url === "/gemini/models/gemini-fixture:generateContent"
  ) {
    response.end(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Gemini 测试成功" }] } }]
      })
    );
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: { message: `Unknown fixture route: ${url}` } }));
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

describe("AI provider client", () => {
  it("discovers and tests an OpenAI-compatible model", async () => {
    const connection = validateAiConnection({
      provider: "custom",
      protocol: "openai-compatible",
      baseUrl: `${baseUrl}/openai`,
      apiKey: "openai-key",
      model: "chat-alpha"
    });
    const result = await discoverAiModels(connection);
    expect(result.models.map((model) => model.id)).toEqual(["chat-alpha"]);
    await expect(
      completeAiText(connection, { system: "system", user: "test" })
    ).resolves.toBe("OpenAI 测试成功");
  });

  it("discovers and tests an Anthropic model", async () => {
    const connection = validateAiConnection({
      provider: "anthropic",
      protocol: "anthropic",
      baseUrl: `${baseUrl}/anthropic`,
      apiKey: "anthropic-key",
      model: "claude-fixture"
    });
    const result = await discoverAiModels(connection);
    expect(result.models[0]).toMatchObject({
      id: "claude-fixture",
      name: "Claude Fixture"
    });
    await expect(
      completeAiText(connection, { system: "system", user: "test" })
    ).resolves.toBe("Claude 测试成功");
  });

  it("filters Gemini models by generateContent support and tests the selected model", async () => {
    const connection = validateAiConnection({
      provider: "gemini",
      protocol: "gemini",
      baseUrl: `${baseUrl}/gemini`,
      apiKey: "gemini-key",
      model: "gemini-fixture"
    });
    const result = await discoverAiModels(connection);
    expect(result.models.map((model) => model.id)).toEqual(["gemini-fixture"]);
    await expect(
      completeAiText(connection, { system: "system", user: "test" })
    ).resolves.toBe("Gemini 测试成功");
  });

  it("rejects non-HTTP URLs and credentials embedded in URLs", () => {
    expect(() =>
      validateAiConnection({
        provider: "custom",
        protocol: "openai-compatible",
        baseUrl: "file:///C:/secret"
      })
    ).toThrow("只允许 HTTP 或 HTTPS");
    expect(() =>
      validateAiConnection({
        provider: "custom",
        protocol: "openai-compatible",
        baseUrl: "https://user:password@example.com/v1"
      })
    ).toThrow("不要把账号或密钥写在 URL");
  });
});
