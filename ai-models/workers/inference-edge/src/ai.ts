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
  /** (선택) LoRA 파인튜닝 이름. TEXT_MODEL이 "-lora" 기반 모델일 때 함께 지정. */
  TEXT_LORA?: string;
  /** (선택) 프로필 JSON: {"quality":{"model":"@cf/...-lora","lora":"finetune이름"}, ...} — 아래 DEFAULT_TEXT_PROFILES 참고. */
  TEXT_PROFILES?: string;
  /** 요청에 profile/mode가 없을 때 쓸 프로필 이름 (기본 "quality"). */
  TEXT_PROFILE_DEFAULT?: string;
}

/**
 * 텍스트 프로필 = (Workers AI 기반 모델, LoRA 파인튜닝 이름) 쌍.
 * LoRA 지원 기반 모델은 Workers AI 카탈로그의 "LoRA" 태그 모델뿐이다(최신 대형 모델은 미지원).
 *  - quality : Gemma 7B  (한국어 토크나이저가 3개 중 가장 낫다)
 *  - general : Mistral 7B Instruct v0.2 (범용·영어 강점)
 *  - fast    : Gemma 2B  (가장 가벼워 같은 무료 한도로 가장 많이 생성)
 * lora 어댑터가 계정에 없으면(아직 업로드 전) 자동으로 기반 모델로 폴백한다(응답의 lora=null로 구분).
 */
export interface TextProfile { model: string; lora?: string }
export const DEFAULT_TEXT_PROFILES: Record<string, TextProfile> = {
  quality: { model: "@cf/google/gemma-7b-it-lora", lora: "cp-gemma7b" },
  general: { model: "@cf/mistral/mistral-7b-instruct-v0.2-lora", lora: "cp-mistral7b" },
  fast: { model: "@cf/google/gemma-2b-it-lora", lora: "cp-gemma2b" },
};
// FastAPI 서버의 mode(fast|thinking)와 호환: fast→fast, thinking→quality
const MODE_TO_PROFILE: Record<string, string> = { fast: "fast", thinking: "quality" };

const SYSTEM_PROMPT =
  "You are a helpful assistant for Cloud Press. Answer clearly and concisely in the same language as the user's message.";

export class AiUnavailableError extends Error {
  constructor(public readonly kind: "quota" | "model" | "finetune" | "other", message: string) {
    super(message);
  }
}

/** Workers AI 오류를 분류한다. 무료 한도 초과는 메시지에 'neurons'/'allocation'/'limit' 등이 들어간다. */
export function classifyAiError(err: unknown): AiUnavailableError {
  const msg = String((err as any)?.message ?? err);
  if (/neuron|allocation|quota|rate limit|too many requests|4006/i.test(msg)) {
    return new AiUnavailableError("quota", msg);
  }
  if (/finetune|fine-tune|lora.*(not found|unknown|missing)|adapter/i.test(msg)) {
    return new AiUnavailableError("finetune", msg);
  }
  if (/no such model|model.*not found|deprecat|5007|unknown model/i.test(msg)) {
    return new AiUnavailableError("model", msg);
  }
  return new AiUnavailableError("other", msg);
}

export function imageModel(env: AiEnv): string {
  return env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
}
export function textProfiles(env: AiEnv): Record<string, TextProfile> {
  if (!env.TEXT_PROFILES) return DEFAULT_TEXT_PROFILES;
  try {
    const parsed = JSON.parse(env.TEXT_PROFILES);
    return parsed && typeof parsed === "object" ? { ...DEFAULT_TEXT_PROFILES, ...parsed } : DEFAULT_TEXT_PROFILES;
  } catch {
    return DEFAULT_TEXT_PROFILES;
  }
}

/**
 * 어떤 모델/LoRA로 생성할지 결정한다. 우선순위:
 *  1) 요청의 profile  2) 요청의 mode(fast|thinking)  3) TEXT_MODEL(+TEXT_LORA) 직접 지정  4) TEXT_PROFILE_DEFAULT
 * TEXT_MODEL을 명시하면 프로필보다 우선하는 "고정 모델" 모드가 된다(요청의 profile/mode가 없을 때).
 */
export function resolveText(env: AiEnv, sel?: { profile?: string; mode?: string }): TextProfile & { name: string } {
  const profiles = textProfiles(env);
  const wanted = sel?.profile && profiles[sel.profile] ? sel.profile : sel?.mode ? MODE_TO_PROFILE[sel.mode] : undefined;
  if (wanted && profiles[wanted]) return { name: wanted, ...profiles[wanted] };
  if (env.TEXT_MODEL) return { name: "custom", model: env.TEXT_MODEL, lora: env.TEXT_LORA || undefined };
  const def = env.TEXT_PROFILE_DEFAULT && profiles[env.TEXT_PROFILE_DEFAULT] ? env.TEXT_PROFILE_DEFAULT : "quality";
  return { name: def, ...profiles[def] };
}

export function textModel(env: AiEnv): string {
  return resolveText(env).model;
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
  profile?: string;
  mode?: string;
}

/**
 * LoRA 기반 모델(-lora)의 채팅 템플릿(Gemma, Mistral)은 system 역할을 지원하지 않으므로
 * 시스템 지시를 첫 user 메시지 앞에 합친다. 학습 때 쓴 형식(system 없음)과도 일치한다.
 */
export function buildInputs(p: TextParams, target: TextProfile, stream: boolean) {
  const isLora = /-lora$/.test(target.model);
  const messages = isLora
    ? [{ role: "user", content: `${SYSTEM_PROMPT}\n\n${p.prompt}` }]
    : [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: p.prompt },
      ];
  return {
    messages,
    max_tokens: p.max_tokens,
    temperature: p.temperature,
    ...(target.lora ? { lora: target.lora } : {}),
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

/** LoRA 어댑터를 아직 올리지 않았거나 이름이 틀리면 기반 모델로 한 번 재시도한다(응답의 lora=null). */
async function runWithLoraFallback(
  env: AiEnv, p: TextParams, target: TextProfile, stream: boolean
): Promise<{ out: any; used: TextProfile }> {
  try {
    return { out: await env.AI!.run(target.model, buildInputs(p, target, stream)), used: target };
  } catch (err) {
    const e = classifyAiError(err);
    if (e.kind === "finetune" && target.lora) {
      console.warn(`LoRA "${target.lora}" unavailable, falling back to base model:`, e.message);
      const base: TextProfile = { model: target.model };
      return { out: await env.AI!.run(base.model, buildInputs(p, base, stream)), used: base };
    }
    throw err;
  }
}

export async function generateText(
  env: AiEnv, p: TextParams
): Promise<{ model: string; text: string; usage: Record<string, number>; profile: string; lora: string | null }> {
  if (!env.AI) throw new AiUnavailableError("other", "AI binding not configured");
  const target = resolveText(env, p);
  const model = target.model;
  try {
    const { out, used } = await runWithLoraFallback(env, p, target, false);
    const text = String(extractText(out) ?? "");
    const u = out?.usage;
    return {
      model: model.split("/").pop() ?? model,
      profile: target.name,
      lora: used.lora ?? null,
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
  const target = resolveText(env, p);
  const model = target.model;
  let upstream: ReadableStream<Uint8Array>;
  let usedLora: string | null = target.lora ?? null;
  try {
    const r = await runWithLoraFallback(env, p, target, true);
    upstream = r.out as ReadableStream<Uint8Array>;
    usedLora = r.used.lora ?? null;
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
      profile: target.name,
      lora: usedLora,
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
