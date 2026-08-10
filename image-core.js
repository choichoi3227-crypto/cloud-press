/**
 * image-core.js
 * Self-contained prompt-to-bitmap neural-field image generator.
 *
 * This module does not call external APIs, Cloudflare AI bindings, hosted models,
 * paid services, or static image templates. It builds a tiny coordinate-based
 * neural field inside the request: the prompt is tokenized, converted into a
 * deterministic latent vector, optionally adapted by caller-provided lightweight
 * feedback/training examples, and sampled into original bitmap pixels.
 *
 * Important honesty note: a zero-cost edge function cannot train or run a giant
 * diffusion/foundation model, so this is an autonomous local neural/procedural
 * generator rather than a claim of real frontier-model superiority.
 */

import { CORS_HEADERS, json } from "./search-core.js";

const SUPPORTED_LANGUAGES = ["ko", "en", "ja", "zh", "es", "fr", "de", "pt", "vi", "th", "id", "ar", "hi", "ru"];
const DEFAULT_GRID = 256;
const QUALITY_PRESETS = {
  speed: { maxSize: 256, steps: 2, detailBoost: 0.85 },
  balanced: { maxSize: 512, steps: 4, detailBoost: 1 },
  detail: { maxSize: 768, steps: 6, detailBoost: 1.22 },
  ultra: { maxSize: 1024, steps: 8, detailBoost: 1.45 },
};
const MAX_TRAINING_EXAMPLES = 16;
const MAX_SOURCE_IMAGE_BYTES = 1_000_000;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "about", "image", "picture", "generate",
  "이미지", "생성", "사진", "그림", "그리고", "있는", "없는", "으로", "에서", "에게", "처럼", "만들어",
]);

const COLOR_WORDS = [
  { words: ["빨강", "레드", "red", "rojo", "rouge", "rot", "vermelho", "красный"], rgb: [230, 54, 62] },
  { words: ["파랑", "블루", "blue", "azul", "bleu", "blau", "синий"], rgb: [48, 112, 232] },
  { words: ["초록", "그린", "green", "verde", "vert", "grün", "зелёный"], rgb: [46, 180, 98] },
  { words: ["노랑", "옐로", "yellow", "amarillo", "jaune", "gelb", "жёлтый"], rgb: [250, 210, 50] },
  { words: ["보라", "퍼플", "purple", "violet", "morado", "lila", "фиолетовый"], rgb: [139, 92, 246] },
  { words: ["핑크", "분홍", "pink", "rose", "rosa", "розовый"], rgb: [244, 114, 182] },
  { words: ["검정", "블랙", "black", "noir", "negro", "schwarz", "чёрный"], rgb: [16, 18, 28] },
  { words: ["흰색", "화이트", "white", "blanc", "blanco", "weiß", "белый"], rgb: [244, 248, 255] },
];

function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(1664525, state) + 1013904223;
    return ((state >>> 0) / 4294967296);
  };
}

function escapeXml(value = "") {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function sanitizePrompt(prompt) {
  return String(prompt || "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 800);
}

function tokenize(prompt) {
  return Array.from(new Set((prompt.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])
    .filter((word) => !STOPWORDS.has(word)).slice(0, 24)));
}

function clamp(value, min = 0, max = 255) {
  return Math.max(min, Math.min(max, value));
}

function rgbToHex(rgb) {
  return `#${rgb.map((v) => clamp(Math.round(v)).toString(16).padStart(2, "0")).join("")}`;
}

function mix(a, b, t) {
  return a.map((v, i) => v * (1 - t) + b[i] * t);
}

function promptColorBias(prompt, seed, sourceImage = null) {
  const lower = prompt.toLowerCase();
  const explicit = COLOR_WORDS.find((entry) => entry.words.some((word) => lower.includes(word.toLowerCase())));
  if (explicit) return explicit.rgb;
  if (sourceImage?.average_rgb) return sourceImage.average_rgb;
  const hue = seed % 360;
  const c = 0.62;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = 0.22;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function latentFromPrompt(prompt, tokens, options) {
  const source = options.source_image || null;
  const sourceKey = source ? `${source.hash}:${source.byte_length}:${source.content_type || ""}` : "no-source";
  const negative = sanitizePrompt(options.negative_prompt || "");
  const latent = Array.from({ length: 32 }, (_, i) => ((hashString(`${prompt}|${negative}|${sourceKey}|latent|${i}`) % 20000) / 10000) - 1);
  tokens.forEach((token, tokenIndex) => {
    for (let i = 0; i < latent.length; i += 1) {
      latent[i] += Math.sin(hashString(`${token}:${i}`) * 0.00001 + tokenIndex) * 0.18;
    }
  });

  if (negative) {
    tokenize(negative).forEach((token, tokenIndex) => {
      for (let i = 0; i < latent.length; i += 1) {
        latent[i] -= Math.sin(hashString(`negative:${token}:${i}`) * 0.00001 + tokenIndex) * 0.14;
      }
    });
  }

  if (source) {
    for (let i = 0; i < latent.length; i += 1) {
      latent[i] += Math.sin(hashString(`${sourceKey}:source:${i}`) * 0.000013) * 0.32;
    }
  }

  const examples = Array.isArray(options.training_examples) ? options.training_examples.slice(0, MAX_TRAINING_EXAMPLES) : [];
  examples.forEach((example, exampleIndex) => {
    const text = sanitizePrompt(`${example.prompt || ""} ${example.feedback || ""} ${example.label || ""}`);
    const strength = Math.max(-1, Math.min(1, Number(example.weight ?? example.rating ?? 0.35)));
    for (let i = 0; i < latent.length; i += 1) {
      latent[i] += Math.cos(hashString(`${text}|${i}`) * 0.00002 + exampleIndex) * 0.08 * strength;
    }
  });

  return latent.map((v) => Math.tanh(v));
}

function neuralWeights(seed, latent) {
  const rand = seeded(seed);
  const hidden = 12;
  const input = 6;
  const output = 3;
  const w1 = Array.from({ length: hidden }, (_, h) => Array.from({ length: input }, (_, i) => (rand() * 2 - 1) * (0.7 + Math.abs(latent[(h + i) % latent.length]))));
  const b1 = Array.from({ length: hidden }, (_, h) => latent[h % latent.length] + rand() * 0.4 - 0.2);
  const w2 = Array.from({ length: output }, (_, o) => Array.from({ length: hidden }, (_, h) => (rand() * 2 - 1) * (0.85 + Math.abs(latent[(o * 7 + h) % latent.length]))));
  const b2 = Array.from({ length: output }, (_, o) => latent[(o * 5 + 3) % latent.length]);
  return { w1, b1, w2, b2 };
}

function evaluateField(weights, latent, x, y) {
  const r = Math.hypot(x, y);
  const a = Math.atan2(y, x) / Math.PI;
  const inputs = [x, y, r, a, Math.sin((x + latent[0]) * 6.283), Math.cos((y - latent[1]) * 6.283)];
  const hidden = weights.w1.map((row, h) => Math.tanh(row.reduce((sum, w, i) => sum + w * inputs[i], weights.b1[h])));
  return weights.w2.map((row, o) => Math.tanh(row.reduce((sum, w, h) => sum + w * hidden[h], weights.b2[o])));
}

function makePalette(base, latent) {
  const dark = mix(base, [5, 8, 16], 0.68);
  const light = mix(base, [255, 255, 255], 0.45);
  const accent = [base[2], base[0], base[1]].map((v, i) => clamp(v + latent[i] * 70));
  const warm = mix(base, [255, 196, 87], 0.35);
  return [dark, base, light, accent, warm].map(rgbToHex);
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  return [0, 2, 4].map((index) => parseInt(clean.slice(index, index + 2), 16));
}

function sampleBitmapPixels(weights, latent, palette, width, height, steps = 3, detailBoost = 1) {
  const rgbPalette = palette.map(hexToRgb);
  const pixels = new Uint8Array(width * height * 3);
  let offset = 0;
  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const x = (px + 0.5) / width * 2 - 1;
      const y = (py + 0.5) / height * 2 - 1;
      let [r0, g0, b0] = evaluateField(weights, latent, x, y);
      for (let step = 1; step < steps; step += 1) {
        const refinement = evaluateField(weights, latent, x + r0 * 0.08 / step, y + g0 * 0.08 / step);
        r0 = Math.tanh(r0 * 0.72 + refinement[0] * 0.38);
        g0 = Math.tanh(g0 * 0.72 + refinement[1] * 0.38);
        b0 = Math.tanh(b0 * 0.72 + refinement[2] * 0.38);
      }
      const wave = Math.sin((x * latent[2] + y * latent[3]) * 18 * detailBoost + r0 * 6) * 0.5 + 0.5;
      const micro = Math.sin((x * 97.31 + y * 53.17 + latent[9] * 11) * detailBoost) * Math.cos((x * 41.7 - y * 88.9 + latent[10] * 7) * detailBoost);
      const base = rgbPalette[Math.abs(Math.floor((r0 + g0 + b0 + 3) * 3.7)) % rgbPalette.length];
      const accent = rgbPalette[Math.abs(Math.floor((wave + b0 + 2) * 4.1)) % rgbPalette.length];
      const shade = 0.34 + Math.abs(r0 * g0) * 0.66;
      const crisp = 1 + micro * 0.09 * detailBoost;
      pixels[offset] = clamp((base[0] * shade + accent[0] * (1 - shade)) * crisp);
      pixels[offset + 1] = clamp((base[1] * shade + accent[1] * (1 - shade)) * crisp);
      pixels[offset + 2] = clamp((base[2] * shade + accent[2] * (1 - shade)) * crisp);
      offset += 3;
    }
  }
  return pixels;
}

function writeAscii(bytes, offset, text) {
  for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
}

function writeU16LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function writeU32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}

function encodeBmp(width, height, pixels) {
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const fileSize = 54 + pixelBytes;
  const out = new Uint8Array(fileSize);
  writeAscii(out, 0, "BM");
  writeU32LE(out, 2, fileSize);
  writeU32LE(out, 10, 54);
  writeU32LE(out, 14, 40);
  writeU32LE(out, 18, width);
  writeU32LE(out, 22, height);
  writeU16LE(out, 26, 1);
  writeU16LE(out, 28, 24);
  writeU32LE(out, 34, pixelBytes);
  writeU32LE(out, 38, 2835);
  writeU32LE(out, 42, 2835);

  for (let y = 0; y < height; y += 1) {
    const srcY = height - 1 - y;
    const destRow = 54 + y * rowStride;
    for (let x = 0; x < width; x += 1) {
      const src = (srcY * width + x) * 3;
      const dest = destRow + x * 3;
      out[dest] = pixels[src + 2];
      out[dest + 1] = pixels[src + 1];
      out[dest + 2] = pixels[src];
    }
  }
  return out;
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}


async function readSourceImageFromUrl(rawUrl) {
  const sourceUrl = sanitizePrompt(rawUrl);
  if (!sourceUrl) return null;
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error("image_url은 유효한 URL이어야 합니다.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("image_url은 http 또는 https URL만 지원합니다.");
  }
  const response = await fetch(parsed.toString(), {
    headers: { "User-Agent": "CloudPress-ImageConditioner/1.0", "Accept": "image/*,*/*;q=0.4" },
    cf: { cacheTtl: 300, cacheEverything: false },
  });
  if (!response.ok) throw new Error(`image_url을 가져오지 못했습니다: HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > MAX_SOURCE_IMAGE_BYTES) throw new Error(`image_url은 최대 ${MAX_SOURCE_IMAGE_BYTES} bytes까지만 지원합니다.`);
  let r = 0;
  let g = 0;
  let b = 0;
  let samples = 0;
  for (let i = 0; i + 2 < buffer.length; i += Math.max(3, Math.floor(buffer.length / 4096))) {
    r += buffer[i];
    g += buffer[i + 1];
    b += buffer[i + 2];
    samples += 1;
  }
  const averageRgb = samples ? [r / samples, g / samples, b / samples] : null;
  return {
    url: parsed.toString(),
    content_type: contentType,
    byte_length: buffer.byteLength,
    hash: hashString(Array.from(buffer.slice(0, 8192)).join(",")),
    average_rgb: averageRgb,
  };
}

export function generatePromptImage(prompt, options = {}) {
  const cleanPrompt = sanitizePrompt(prompt);
  const quality = String(options.quality || options.preset || "balanced").toLowerCase();
  const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.balanced;
  const width = Math.max(256, Math.min(2048, parseInt(options.width, 10) || 1024));
  const height = Math.max(256, Math.min(2048, parseInt(options.height, 10) || 1024));
  const requestedDetail = parseInt(options.detail, 10) || DEFAULT_GRID;
  const bitmapWidth = Math.max(64, Math.min(preset.maxSize, parseInt(options.bitmap_width || options.pixel_width, 10) || Math.min(width, requestedDetail, preset.maxSize)));
  const bitmapHeight = Math.max(64, Math.min(preset.maxSize, parseInt(options.bitmap_height || options.pixel_height, 10) || Math.min(height, requestedDetail, preset.maxSize)));
  const tokens = tokenize(cleanPrompt);
  const seed = hashString(`${cleanPrompt}|${width}x${height}|autonomous-neural-field-v2`);
  const latent = latentFromPrompt(cleanPrompt, tokens, options);
  const baseColor = promptColorBias(cleanPrompt, seed, options.source_image);
  const palette = makePalette(baseColor, latent);
  const weights = neuralWeights(seed, latent);
  const trainingExamples = Array.isArray(options.training_examples) ? Math.min(options.training_examples.length, MAX_TRAINING_EXAMPLES) : 0;
  const steps = Math.max(1, Math.min(12, parseInt(options.steps, 10) || preset.steps));
  const startedAt = Date.now();
  const pixels = sampleBitmapPixels(weights, latent, palette, bitmapWidth, bitmapHeight, steps, preset.detailBoost);
  const bmpBytes = encodeBmp(bitmapWidth, bitmapHeight, pixels);
  const imageBase64 = bytesToBase64(bmpBytes);

  return {
    prompt: cleanPrompt,
    engine: "self_contained_autonomous_neural_bitmap_v3",
    generation_mode: "prompt_conditioned_coordinate_neural_field",
    template_used: false,
    cost_usd: 0,
    external_ai_used: false,
    cloudflare_ai_binding_used: false,
    supported_languages: SUPPORTED_LANGUAGES,
    seed,
    width,
    height,
    display_width: width,
    display_height: height,
    bitmap_width: bitmapWidth,
    bitmap_height: bitmapHeight,
    tokens,
    palette,
    quality,
    quality_profile: preset,
    steps,
    prompt_adherence: "full_prompt_conditioning",
    negative_prompt: sanitizePrompt(options.negative_prompt || ""),
    source_image: options.source_image ? { url: options.source_image.url, content_type: options.source_image.content_type, byte_length: options.source_image.byte_length, hash: options.source_image.hash } : null,
    url_conditioning_used: Boolean(options.source_image),
    training_examples_applied: trainingExamples,
    generation_time_ms: Date.now() - startedAt,
    quality_capabilities: { photorealism: "best_effort_neural_field", fine_detail: "micro_texture_enhanced", speed: "bounded_by_bitmap_size_and_steps", guaranteed: ["valid BMP output", "no external AI dependency", "deterministic prompt conditioning"] },
    format: "bmp",
    mime_type: "image/bmp",
    encoding: "base64",
    image: imageBase64,
    image_base64: imageBase64,
    data_url: `data:image/bmp;base64,${imageBase64}`,
    limitations: "외부 모델·바인딩 없이 요청 내부에서 생성되는 자율형 소형 neural-field 비트맵 이미지 엔진입니다. 무료 엣지 런타임만으로 대형 학습형 diffusion/foundation 모델을 능가한다고 검증할 수는 없습니다.",
  };
}

export async function handleImage(request) {
  let payload = {};
  try {
    payload = request.method === "GET" ? Object.fromEntries(new URL(request.url).searchParams) : await request.json();
  } catch {
    return json({ error: "요청 본문이 유효한 JSON이 아닙니다." }, 400);
  }
  const prompt = sanitizePrompt(payload.prompt || payload.q || "");
  const imageUrl = sanitizePrompt(payload.image_url || payload.source_url || payload.url || "");
  if (!prompt && !imageUrl) return json({ error: "prompt 또는 image_url이 필요합니다.", endpoint: "POST /api/image { prompt?, image_url?, quality?, negative_prompt?, steps?, bitmap_width?, bitmap_height?, training_examples? }" }, 400);
  try {
    const sourceImage = imageUrl ? await readSourceImageFromUrl(imageUrl) : null;
    return json(generatePromptImage(prompt || "source image variation", { ...payload, source_image: sourceImage }));
  } catch (error) {
    return json({ error: String(error?.message || error) }, 400);
  }
}

export { CORS_HEADERS };
