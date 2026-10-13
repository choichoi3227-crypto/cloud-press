/**
 * Workers AI 백엔드 — Cloudflare가 호스팅하는 실제 생성 AI 모델을 호출한다.
 * 무료 플랜: 하루 10,000 Neurons(모든 모델 합산, 00:00 UTC 초기화). 한도를 넘으면 호출이 실패하므로
 * 호출부에서 429로 변환해 클라이언트가 재시도/대체할 수 있게 한다.
 *
 * 모델 ID는 환경변수로 바꿀 수 있다 — Workers AI 카탈로그는 자주 바뀌므로(폐기 예정 모델 있음)
 * 코드를 고치지 않고 wrangler.toml [vars]에서 교체한다.
 */

export const DEFAULT_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
export const DEFAULT_TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

export interface AiEnv {
  AI?: { run(model: string, inputs: unknown): Promise<any> };
  IMAGE_MODEL?: string;
  TEXT_MODEL?: string;
}

const SYSTEM_PROMPT =
  "You are a helpful assistant for Cloud Press. Answer clearly and concisely in the same language as the user's message.";

export class AiUnavailableError extends Error {
  constructor(public readonly kind: "quota" | "model" | "other", message: string) {
    super(message);
  }
}

/** Workers AI 오류를 분류한다. 무료 한도 초과는 메시지에 'neurons'/'allocation'/'limit' 등이 들어간다. */
export function classifyAiError(err: unknown): AiUnavailableError {
  const msg = String((err as any)?.message ?? err);
  if (/neuron|allocation|quota|rate limit|too many requests|4006/i.test(msg)) {
    return new AiUnavailableError("quota", msg);
  }
  if (/no such model|model.*not found|deprecat|5007|unknown model/i.test(msg)) {
    return new AiUnavailableError("model", msg);
  }
  return new AiUnavailableError("other", msg);
}

export function imageModel(env: AiEnv): string {
  return env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
}
export function textModel(env: AiEnv): string {
  return env.TEXT_MODEL || DEFAULT_TEXT_MODEL;
}

/** 텍스트 프롬프트 → 이미지. FLUX.1 schnell은 {image: base64(JPEG)}를 돌려준다. */
export async function generateImage(
  env: AiEnv, prompt: string
): Promise<{ model: string; image_base64: string; format: "jpeg" }> {
  if (!env.AI) throw new AiUnavailableError("other", "AI binding not configured");
  const model = imageModel(env);
  try {
    const out = await env.AI.run(model, { prompt: prompt.slice(0, 2048) });
    const b64: unknown = out?.image ?? out?.result?.image;
    if (typeof b64 !== "string" || !b64) throw new Error("model returned no image");
    return { model: model.split("/").pop() ?? model, image_base64: b64, format: "jpeg" };
  } catch (err) {
    throw classifyAiError(err);
  }
}

export interface TextParams {
  prompt: string;
  max_tokens: number;
  temperature: number;
}

function buildInputs(p: TextParams, stream: boolean) {
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: p.prompt },
    ],
    max_tokens: p.max_tokens,
    temperature: p.temperature,
    ...(stream ? { stream: true } : {}),
  };
}

/** 모델마다 응답 모양이 달라(`response` 또는 OpenAI형 `choices`) 둘 다 처리한다. */
export function extractText(out: any): string {
  if (typeof out === "string") return out;
  return (
    out?.response ??
    out?.result?.response ??
    out?.choices?.[0]?.message?.content ??
    out?.choices?.[0]?.text ??
    ""
  );
}

export async function generateText(
  env: AiEnv, p: TextParams
): Promise<{ model: string; text: string; usage: Record<string, number> }> {
  if (!env.AI) throw new AiUnavailableError("other", "AI binding not configured");
  const model = textModel(env);
  try {
    const out = await env.AI.run(model, buildInputs(p, false));
    const text = String(extractText(out) ?? "");
    const u = out?.usage;
    return {
      model: model.split("/").pop() ?? model,
      text,
      usage: {
        prompt_tokens: u?.prompt_tokens ?? p.prompt.split(/\s+/).filter(Boolean).length,
        completion_tokens: u?.completion_tokens ?? text.split(/\s+/).filter(Boolean).length,
      },
    };
  } catch (err) {
    throw classifyAiError(err);
  }
}

/**
 * Workers AI의 SSE 스트림(`data: {"response":"..."}` 또는 OpenAI형 delta)을
 * FastAPI 서버와 같은 형식(`{"type":"chunk"|"done"|"error"}` + `[DONE]`)으로 변환한다.
 */
export async function streamText(env: AiEnv, p: TextParams): Promise<ReadableStream<Uint8Array>> {
  if (!env.AI) throw new AiUnavailableError("other", "AI binding not configured");
  const model = textModel(env);
  let upstream: ReadableStream<Uint8Array>;
  try {
    upstream = (await env.AI.run(model, buildInputs(p, true))) as ReadableStream<Uint8Array>;
  } catch (err) {
    throw classifyAiError(err);
  }
  const modelName = model.split("/").pop() ?? model;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const send = (c: TransformStreamDefaultController<Uint8Array>, o: unknown) =>
    c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));

  let buf = "";
  let completion = "";
  let finished = false;
  const finish = (c: TransformStreamDefaultController<Uint8Array>) => {
    if (finished) return;
    finished = true;
    send(c, {
      type: "done",
      model: modelName,
      usage: {
        prompt_tokens: p.prompt.split(/\s+/).filter(Boolean).length,
        completion_tokens: completion.split(/\s+/).filter(Boolean).length,
      },
    });
    c.enqueue(enc.encode("data: [DONE]\n\n"));
  };
  const handleLine = (line: string, c: TransformStreamDefaultController<Uint8Array>) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const data = t.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") return finish(c);
    try {
      const j = JSON.parse(data);
      const tok: string = j.response ?? j.choices?.[0]?.delta?.content ?? "";
      if (tok) {
        completion += tok;
        send(c, { type: "chunk", text: tok });
      }
    } catch {
      /* 일부 줄이 잘려 들어오면 무시 — 버퍼링으로 대부분 방지됨 */
    }
  };

  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) !== -1) {
          handleLine(buf.slice(0, i), c);
          buf = buf.slice(i + 1);
        }
      },
      flush(c) {
        if (buf) handleLine(buf, c);
        finish(c);
      },
    })
  );
}
