import {
  readableStreamFromReader,
  readerFromStreamReader,
} from "https://deno.land/std@0.224.0/streams/mod.ts";
import { readLines } from "https://deno.land/std@0.224.0/io/read_lines.ts";

// --- 配置区域 ---

// 辅助函数：从环境变量获取配置，若不存在则使用默认值
function getEnv(key: string, defaultValue: string): string {
  return Deno.env.get(key) ?? defaultValue;
}

// 配置变量
const UPSTREAM_URL = getEnv("UPSTREAM_URL", "https://chat.z.ai/api/chat/completions");
const DEFAULT_KEY = getEnv("DEFAULT_KEY", "sk-your-key");
const UPSTREAM_TOKEN = getEnv("UPSTREAM_TOKEN", "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjMxNmJjYjQ4LWZmMmYtNGExNS04NTNkLWYyYTI5YjY3ZmYwZiIsImVtYWlsIjoiR3Vlc3QtMTc1NTg0ODU4ODc4OEBndWVzdC5jb20ifQ.PktllDySS3trlyuFpTeIZf-7hl8Qu1qYF3BxjgIul0BrNux2nX9hVzIjthLXKMWAf9V0qM8Vm_iyDqkjPGsaiQ");
const MODEL_NAME = getEnv("MODEL_NAME", "GLM-4.5");
const PORT = parseInt(getEnv("PORT", "8080"), 10);
const DEBUG_MODE = getEnv("DEBUG_MODE", "true") === "true";
const DEFAULT_STREAM = getEnv("DEFAULT_STREAM", "true") === "true";

// 思考内容处理策略 ("strip": 去除<details>标签; "think": 转为<think>标签; "raw": 保留原样)
const THINK_TAGS_MODE: "strip" | "think" | "raw" = "raw";

// 伪装前端头部
const X_FE_VERSION = "prod-fe-1.0.70";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0";
const SEC_CH_UA = "\"Not;A=Brand\";v=\"99\", \"Microsoft Edge\";v=\"139\", \"Chromium\";v=\"139\"";
const SEC_CH_UA_MOB = "?0";
const SEC_CH_UA_PLAT = "\"Windows\"";
const ORIGIN_BASE = "https://chat.z.ai";

// 匿名token开关
const ANON_TOKEN_ENABLED = true;

// --- 类型定义 ---

interface Message {
  role: string;
  content: string;
}

interface OpenAIRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

interface UpstreamRequest {
  stream: boolean;
  model: string;
  messages: Message[];
  params: Record<string, unknown>;
  features: Record<string, unknown>;
  background_tasks?: Record<string, boolean>;
  chat_id?: string;
  id?: string;
  mcp_servers?: string[];
  model_item?: {
    id: string;
    name: string;
    owned_by: string;
  };
  tool_servers?: string[];
  variables?: Record<string, string>;
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface Delta {
  role?: string;
  content?: string;
}

interface Choice {
  index: number;
  message?: Message;
  delta?: Delta;
  finish_reason?: string;
}

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
}

interface UpstreamError {
  detail: string;
  code: number;
}

interface UpstreamData {
  type: string;
  data: {
    delta_content: string;
    edit_content?: string;
    phase: string;
    done: boolean;
    usage?: Usage;
    error?: UpstreamError;
    inner?: {
      error?: UpstreamError;
    };
  };
  error?: UpstreamError;
}

// --- 辅助函数 ---

// Debug日志函数
function debugLog(message: string, ...args: unknown[]) {
  if (DEBUG_MODE) {
    console.log(`[DEBUG] ${message}`, ...args);
  }
}

// 获取匿名token
async function getAnonymousToken(): Promise<string | null> {
  try {
    const headers = new Headers({
      "User-Agent": BROWSER_UA,
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "X-FE-Version": X_FE_VERSION,
      "sec-ch-ua": SEC_CH_UA,
      "sec-ch-ua-mobile": SEC_CH_UA_MOB,
      "sec-ch-ua-platform": SEC_CH_UA_PLAT,
      "Origin": ORIGIN_BASE,
      "Referer": `${ORIGIN_BASE}/`,
    });
    const response = await fetch(`${ORIGIN_BASE}/api/v1/auths/`, { headers });
    if (!response.ok) {
      throw new Error(`anon token status=${response.status}`);
    }
    const body = await response.json();
    if (!body.token) {
      throw new Error("anon token empty");
    }
    return body.token;
  } catch (error) {
    debugLog("Failed to get anonymous token:", error.message);
    return null;
  }
}

// 转换 "thinking" 内容
function transformThinking(s: string): string {
  s = s.replace(/<summary>[\s\S]*?<\/summary>/gs, ""); // 去 <summary>…</summary>
  s = s.replaceAll("</thinking>", "").replaceAll("<Full>", "").replaceAll("</Full>", "");
  s = s.trim();

  switch (THINK_TAGS_MODE) {
    case "think":
      s = s.replace(/<details[^>]*>/g, "<think>").replaceAll("</details>", "</think>");
      break;
    case "strip":
      s = s.replace(/<details[^>]*>/g, "").replaceAll("</details>", "");
      break;
  }

  s = s.startsWith("> ") ? s.substring(2) : s;
  s = s.replaceAll("\n> ", "\n");
  return s.trim();
}

// 通用的CORS头部
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Credentials": "true",
};


// --- API 处理函数 ---

// 模型列表处理
function handleModels(): Response {
  const responseData = {
    object: "list",
    data: [
      {
        id: MODEL_NAME,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "z.ai",
      },
      {
        id: `${MODEL_NAME}-search`,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "z.ai",
      },
      {
        id: `${MODEL_NAME}-thinking-search`,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "z.ai",
      },
      {
        id: `${MODEL_NAME}-thinking`,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "z.ai",
      },
    ],
  };
  return new Response(JSON.stringify(responseData), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// 调用上游 API
async function callUpstream(
  upstreamReq: UpstreamRequest,
  refererChatId: string,
  authToken: string,
): Promise<Response> {
  const reqBody = JSON.stringify(upstreamReq);
  debugLog("Calling upstream API:", UPSTREAM_URL);
  debugLog("Upstream request body:", reqBody);

  const headers = new Headers({
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "User-Agent": BROWSER_UA,
    "Authorization": `Bearer ${authToken}`,
    "Accept-Language": "zh-CN",
    "sec-ch-ua": SEC_CH_UA,
    "sec-ch-ua-mobile": SEC_CH_UA_MOB,
    "sec-ch-ua-platform": SEC_CH_UA_PLAT,
    "X-FE-Version": X_FE_VERSION,
    "Origin": ORIGIN_BASE,
    "Referer": `${ORIGIN_BASE}/c/${refererChatId}`,
  });

  return await fetch(UPSTREAM_URL, {
    method: "POST",
    headers,
    body: reqBody,
  });
}

// --- REFACTORED V5: handleStreamResponse (With explicit encoding) ---
async function handleStreamResponse(
  upstreamReq: UpstreamRequest,
  chatId: string,
  authToken: string,
): Promise<Response> {
  const upstreamResponsePromise = callUpstream(upstreamReq, chatId, authToken);

  // *** FIX: 创建一个 TextEncoder 实例，后续所有字符串编码都用它 ***
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const upstreamResponse = await upstreamResponsePromise;

        if (!upstreamResponse.ok || !upstreamResponse.body) {
          const errorBody = await upstreamResponse.text();
          debugLog(`Upstream error: ${upstreamResponse.status}`, errorBody);
          // 确保在出错时关闭流
          try { controller.close(); } catch {}
          return;
        }

        const firstChunk: OpenAIResponse = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: MODEL_NAME,
          choices: [{ index: 0, delta: { role: "assistant" } }],
        };

        // *** FIX: 在推入队列前，将字符串编码为 Uint8Array ***
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(firstChunk)}\n\n`));
        debugLog("First chunk sent to client.");

        const denoReader = readerFromStreamReader(upstreamResponse.body.getReader());

        for await (const line of readLines(denoReader)) {
          if (!line.startsWith("data: ")) continue;

          const dataStr = line.substring(6);
          if (!dataStr || dataStr === "[DONE]") continue; // 增加对 [DONE] 字符串的过滤

          let upstreamData: UpstreamData;
          try {
            upstreamData = JSON.parse(dataStr);
          } catch {
            debugLog("Failed to parse SSE data:", dataStr);
            continue;
          }

          const err = upstreamData.error || upstreamData.data.error || upstreamData.data.inner?.error;
          if (err) {
            debugLog(`Upstream error in stream: code=${err.code}, detail=${err.detail}`);
            break;
          }

          if (upstreamData.data.delta_content) {
            let out = upstreamData.data.delta_content;
            if (upstreamData.data.phase === "thinking") {
              out = transformThinking(out);
            }
            if (out) {
              const chunk: OpenAIResponse = {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: MODEL_NAME,
                choices: [{ index: 0, delta: { content: out } }],
              };
              // *** FIX: 在推入队列前，将字符串编码为 Uint8Array ***
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
          }
          
          // ... 您其他的 edit_content 逻辑保持不变 ...
          if (upstreamData.data.edit_content && upstreamData.data.phase === "answer") {
            const out = upstreamData.data.edit_content;
            const parts = out.split('</details>');
            if (parts.length > 1) {
              const content = parts[1];
              if (content) {
                debugLog("Sending plain content from EditContent:", content);
                const chunk: OpenAIResponse = {
                  id: `chatcmpl-${Date.now()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: MODEL_NAME,
                  choices: [{
                    index: 0,
                    delta: { content: content },
                  }],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
            }
          }

          if (upstreamData.data.done || upstreamData.data.phase === "done") {
            debugLog("Stream end signal received in data.");
            break;
          }
        }

        debugLog("Loop finished, sending final chunks.");
        const endChunk: OpenAIResponse = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: MODEL_NAME,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };

        // *** FIX: 在推入队列前，将字符串编码为 Uint8Array ***
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        
      } catch (error) {
        // 捕获更广泛的错误，例如上游连接被重置
        debugLog("An error occurred during streaming, connection likely closed by client or upstream.", error.message);
      } finally {
        // 确保无论发生什么，流都会被关闭
        try { controller.close(); } catch {}
        debugLog("Stream closed.");
      }
    },
    cancel(reason) {
      debugLog("Stream explicitly canceled by runtime.", reason);
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

// 处理非流式响应
async function handleNonStreamResponse(
    upstreamReq: UpstreamRequest,
    chatId: string,
    authToken: string,
): Promise<Response> {
    const upstreamResponse = await callUpstream(upstreamReq, chatId, authToken);

    if (!upstreamResponse.ok || !upstreamResponse.body) {
        const errorBody = await upstreamResponse.text();
        debugLog(`Upstream error: ${upstreamResponse.status}`, errorBody);
        return new Response("Upstream error", { status: 502, headers: corsHeaders });
    }

    let fullContent = "";
    let finalUsage: Usage | undefined = undefined;

    // --- FIX START ---
    // 正确地将 Web Stream 转换为 Deno Reader 以便 readLines 使用
    const denoReader = readerFromStreamReader(upstreamResponse.body.getReader());
    for await (const line of readLines(denoReader)) {
    // --- FIX END ---
        if (!line.startsWith("data: ")) continue;

        const dataStr = line.substring(6);
        if (!dataStr) continue;

        let upstreamData: UpstreamData;
        try {
            upstreamData = JSON.parse(dataStr);
        } catch {
            continue;
        }

        if (upstreamData.data.delta_content) {
            let out = upstreamData.data.delta_content;
            if (upstreamData.data.phase === "thinking") {
                out = transformThinking(out);
            }
            if (out) {
                fullContent += out;
            }
        }

        if (upstreamData.data.usage) {
            finalUsage = upstreamData.data.usage;
        }

        if (upstreamData.data.done || upstreamData.data.phase === "done") {
            debugLog("Non-stream collection finished.");
            break;
        }
    }

    const response: OpenAIResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: MODEL_NAME,
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: fullContent,
                },
                finish_reason: "stop",
            },
        ],
        usage: finalUsage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    return new Response(JSON.stringify(response), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}


// 主请求处理函数
async function mainHandler(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);

  // CORS 预检请求
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (pathname === "/v1/models") {
    return handleModels();
  }

  if (pathname === "/v1/chat/completions") {
    debugLog("Received chat completions request");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      debugLog("Missing or invalid Authorization header");
      return new Response("Missing or invalid Authorization header", { status: 401, headers: corsHeaders });
    }

    const apiKey = authHeader.substring(7);
    if (apiKey !== DEFAULT_KEY) {
      debugLog("Invalid API key:", apiKey);
      return new Response("Invalid API key", { status: 401, headers: corsHeaders });
    }
    debugLog("API key validated");
    
    let openAIRequest: OpenAIRequest;
    try {
      openAIRequest = await req.json();
    } catch (e) {
      debugLog("Invalid JSON:", e.message);
      return new Response("Invalid JSON", { status: 400, headers: corsHeaders });
    }

    // 如果客户端未指定 stream，使用默认值
    if (openAIRequest.stream === undefined) {
      openAIRequest.stream = DEFAULT_STREAM;
      debugLog(`Stream not specified, using default: ${DEFAULT_STREAM}`);
    }

    const now = Date.now();
    const chatId = `${now}-${Math.floor(now/1000)}`;
    const msgId = `${now}`;

    const upstreamReq: UpstreamRequest = {
        stream: true, // 总是从上游请求流式数据
        chat_id: chatId,
        id: msgId,
        model: "0727-360B-API", // 上游实际模型ID
        messages: openAIRequest.messages,
        params: {},
        features: {
          "enable_thinking": openAIRequest.model?.includes('-thinking'),
        },
        background_tasks: {
          "title_generation": false,
          "tags_generation": false,
        },
        model_item: { id: "0727-360B-API", name: "GLM-4.5", owned_by: "openai" },
        variables: {
          "{{USER_NAME}}": "User",
          "{{USER_LOCATION}}": "Unknown",
          "{{CURRENT_DATETIME}}": new Date().toISOString().replace('T', ' ').substring(0, 19),
        },
        mcp_servers: openAIRequest.model?.includes('-search') ? [ 'deep-web-search' ] : [],
    };

    let authToken = UPSTREAM_TOKEN;
    if (ANON_TOKEN_ENABLED) {
        const anonToken = await getAnonymousToken();
        if (anonToken) {
            authToken = anonToken;
            debugLog(`Using anonymous token: ${anonToken.substring(0, 10)}...`);
        } else {
            debugLog("Failed to get anonymous token, falling back to fixed token.");
        }
    }

    if (openAIRequest.stream) {
        return handleStreamResponse(upstreamReq, chatId, authToken);
    } else {
        return handleNonStreamResponse(upstreamReq, chatId, authToken);
    }
  }

  return new Response("Not Found", { status: 404, headers: corsHeaders });
}


// --- 服务器启动 ---
console.log(`OpenAI compatible API server starting on port ${PORT}`);
console.log(`Model: ${MODEL_NAME}`);
console.log(`Upstream: ${UPSTREAM_URL}`);
console.log(`Debug mode: ${DEBUG_MODE}`);
console.log(`Default stream: ${DEFAULT_STREAM}`);

Deno.serve({ port: PORT }, mainHandler);
