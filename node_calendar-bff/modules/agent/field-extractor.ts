import type { AgentUserPreference } from "./agent.types";
import { AgentUpstreamError } from "./agent.errors";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export interface AgentFieldExtraction {
  duration?: string;
  totalMinutes?: number;
  deadline?: string;
  deadlineText?: string;
  deadlineIso?: string;
}

interface ExtractFieldsContext {
  nowIso: string;
  userPreference: AgentUserPreference;
  clarificationJson?: unknown;
}

interface DeepSeekChatCompletion {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
  }>;
}

function readFetchCauseCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return "";
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDeepSeekNetworkMessage(error: unknown): string {
  const causeCode = readFetchCauseCode(error);
  const detail = causeCode ? `${readErrorMessage(error)} (${causeCode})` : readErrorMessage(error);
  if (causeCode === "UND_ERR_CONNECT_TIMEOUT") {
    return `字段抽取请求 DeepSeek 连接超时：${detail}。请检查 Node 进程网络、代理/VPN 或稍后重试。`;
  }
  return `字段抽取请求 DeepSeek 失败：${detail}。请检查 Node 进程网络、代理/VPN 或 DeepSeek 服务可用性。`;
}

function normalizeExtraction(value: unknown): AgentFieldExtraction {
  const result = value as Partial<AgentFieldExtraction>;
  const deadlineFromField =
    typeof result.deadline === "string" &&
    !Number.isNaN(Date.parse(result.deadline))
      ? result.deadline
      : "";
  const deadlineFromIso =
    typeof result.deadlineIso === "string" &&
    !Number.isNaN(Date.parse(result.deadlineIso))
      ? result.deadlineIso
      : "";
  const deadlineIso = (deadlineFromField || deadlineFromIso).trim();
  const deadlineText =
    typeof result.deadlineText === "string" ? result.deadlineText.trim() : "";
  const rawDeadline =
    typeof result.deadline === "string" ? result.deadline.trim() : "";
  const totalMinutes = Number(result.totalMinutes);

  return {
    duration: typeof result.duration === "string" ? result.duration.trim() : "",
    totalMinutes:
      Number.isFinite(totalMinutes) && totalMinutes > 0
        ? Math.round(totalMinutes)
        : undefined,
    deadline: deadlineIso || rawDeadline,
    deadlineText: deadlineText || (deadlineIso ? rawDeadline : ""),
    deadlineIso,
  };
}

function buildFieldExtractionPrompt(): string {
  return [
    "你是字段转换器。只输出一个 JSON object，禁止解释，禁止推理文本。",
    "把中文日程需求转换成 Python 校验用硬字段。",
    "输出结构必须是：",
    JSON.stringify({ duration: "", totalMinutes: 0, deadline: "", deadlineText: "", deadlineIso: "" }),
    "规则：",
    "1. 优先使用 context.clarificationJson；没有则用 input。",
    "2. duration 保留原文；totalMinutes 换算成分钟数字。例：14个小时=840，十个小时=600，两个半小时=150，30分钟=30。模糊/缺失=null。",
    "3. deadlineText 保留截止时间原文。",
    "4. deadline/deadlineIso 必须基于 context.nowIso 和 timezone 计算 ISO 8601。例：nowIso=2026-08-14T10:00:00+08:00 时，下周五晚上七点=2026-08-21T19:00:00+08:00。",
    "5. 模糊词（一会、马上、尽快、抽空、随便、看情况、不知道、无明确时间）不能通过，deadline 写原文，deadlineIso 为空。",
    "6. 日期无钟点：上午=12:00，下午/傍晚/晚上=18:00，截止/之前=23:59。",
  ].join("\n");
}

function parseJsonObject(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("DeepSeek field conversion returned blank content");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(
        `DeepSeek field conversion returned non-JSON content: ${trimmed.slice(0, 300)}`,
      );
    }
    return JSON.parse(match[0]);
  }
}

async function requestDeepSeekFieldConversion(
  model: string,
  apiKey: string,
  input: string,
  context: ExtractFieldsContext,
  attempt: number,
): Promise<{ content: string; rawText: string; finishReason: string; reasoningPreview: string }> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "system",
        content: [
          buildFieldExtractionPrompt(),
          "",
          `attempt=${attempt}`,
          "立即输出 JSON，不要分析过程。",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          input,
          context,
          requiredConversion: {
            durationToTotalMinutes: true,
            deadlineTextToIso: true,
          },
        }),
      },
    ],
    temperature: 0,
    max_tokens: 2400,
    thinking: { type: "disabled" },
    stream: false,
  };

  if (attempt <= 2) {
    body.response_format = { type: "json_object" };
  }

  let response: Response;
  try {
    response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new AgentUpstreamError(formatDeepSeekNetworkMessage(error), {
      upstream: "deepseek",
      statusCode: 502,
      causeCode: readFetchCauseCode(error),
      cause: error,
    });
  }

  const rawText = await response.text();
  if (!response.ok) {
    throw new AgentUpstreamError(
      `DeepSeek field conversion failed: HTTP ${response.status} ${rawText}`,
      {
        upstream: "deepseek",
        statusCode: response.status >= 500 ? 502 : 400,
      },
    );
  }

  const data = JSON.parse(rawText) as DeepSeekChatCompletion;
  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content || "",
    rawText,
    finishReason: choice?.finish_reason || "",
    reasoningPreview: choice?.message?.reasoning_content?.slice(0, 300) || "",
  };
}

export async function extractAgentFieldsWithDeepSeek(
  input: string,
  context: ExtractFieldsContext,
): Promise<AgentFieldExtraction> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

  if (!apiKey) {
    return normalizeExtraction(context.clarificationJson);
  }

  let lastRawText = "";
  let lastFinishReason = "";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await requestDeepSeekFieldConversion(
      model,
      apiKey,
      input,
      context,
      attempt,
    );
    lastRawText = result.rawText;
    lastFinishReason = result.finishReason;

    if (result.content.trim()) {
      const normalized = normalizeExtraction(parseJsonObject(result.content));
      console.log("[DeepSeek Field Conversion] converted fields:", normalized);
      return normalized;
    }

    console.warn("[DeepSeek Field Conversion] Empty content, retrying:", {
      attempt,
      finishReason: result.finishReason,
      reasoningPreview: result.reasoningPreview,
      rawResponse: result.rawText.slice(0, 1200),
    });
  }

  throw new Error(
    [
      "LLM 字段转换失败：模型没有返回可解析内容，请重试。",
      `finish_reason=${lastFinishReason || "unknown"}`,
      `raw=${lastRawText.slice(0, 1200)}`,
    ].join(" "),
  );
}
