/**
 * Nano-Tech Artist 단계 1 cGAN Generator의 엣지(Worker) 추론 구현.
 * 추론 서버가 죽었을 때의 폴백 용도. 의존성 없음, 순수 TypeScript.
 *
 * 가중치: training/nano-tech-artist/export_edge_weights.py 가 만든 바이너리(BN 접힘, fp16)를
 * KV(CACHE_KV, 키 `edge-weights:nta:v1`)에서 읽어 isolate 메모리에 캐시한다.
 *
 * 비용: 약 1억 MAC(CPU 약 0.2초). 무료 플랜(CPU 10ms)에서는 불가 → 기본 비활성, 유료 플랜에서 EDGE_LIVE=1로만 사용.
 *
 * 백엔드: native(직접 루프) 또는 vgpu(edgeVgpu.ts, vgpu_core.js ISA 커널). env.EDGE_BACKEND로 선택.
 */
import { Env } from "../env";
import { vgpuLayer } from "./edgeVgpu";

export const EDGE_WEIGHTS_KEY = "edge-weights:nta:v1";

const COLORS = ["red", "blue", "green", "yellow", "purple", "black"];
const SHAPES = ["circle", "square", "triangle"];

interface LayerMeta {
  cin: number; cout: number; k: number; stride: number; pad: number;
  act: "relu" | "tanh"; w_off: number; b_off: number;
}
interface Layer extends LayerMeta { w: Float32Array; b: Float32Array }
interface Net { noiseDim: number; condDim: number; layers: Layer[] }

let cached: Net | null = null;

function f16ToF32(h: number): number {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + m / 1024);
}

export function parseWeights(buf: ArrayBuffer): Net {
  const dv = new DataView(buf);
  const hlen = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen)));
  const base = 4 + hlen;
  const n = (buf.byteLength - base) >> 1;
  const all = new Float32Array(n);
  for (let i = 0; i < n; i++) all[i] = f16ToF32(dv.getUint16(base + i * 2, true));
  const layers: Layer[] = header.layers.map((m: LayerMeta) => ({
    ...m,
    w: all.subarray(m.w_off, m.w_off + m.cin * m.cout * m.k * m.k),
    b: all.subarray(m.b_off, m.b_off + m.cout),
  }));
  return { noiseDim: header.noise_dim, condDim: header.cond_dim, layers };
}

export async function loadNet(env: Pick<Env, "CACHE_KV">): Promise<Net | null> {
  if (cached) return cached;
  const buf = await env.CACHE_KV.get(EDGE_WEIGHTS_KEY, "arrayBuffer");
  if (!buf) return null;
  cached = parseWeights(buf);
  return cached;
}

/** ConvTranspose2d (+bias) — x: (cin,h,w) → (cout, (h-1)*s - 2p + k, ...). weight: (cin,cout,k,k). */
function convT(x: Float32Array, h: number, w: number, L: Layer): { y: Float32Array; h: number; w: number } {
  const { cin, cout, k, stride, pad } = L;
  const oh = (h - 1) * stride - 2 * pad + k;
  const ow = (w - 1) * stride - 2 * pad + k;
  const y = new Float32Array(cout * oh * ow);
  for (let co = 0; co < cout; co++) y.fill(L.b[co], co * oh * ow, (co + 1) * oh * ow);
  for (let ci = 0; ci < cin; ci++) {
    for (let iy = 0; iy < h; iy++) {
      for (let ix = 0; ix < w; ix++) {
        const v = x[(ci * h + iy) * w + ix];
        if (v === 0) continue;
        for (let co = 0; co < cout; co++) {
          const wbase = ((ci * cout + co) * k) * k;
          const ybase = co * oh * ow;
          for (let ky = 0; ky < k; ky++) {
            const oy = iy * stride - pad + ky;
            if (oy < 0 || oy >= oh) continue;
            for (let kx = 0; kx < k; kx++) {
              const ox = ix * stride - pad + kx;
              if (ox < 0 || ox >= ow) continue;
              y[ybase + oy * ow + ox] += v * L.w[wbase + ky * k + kx];
            }
          }
        }
      }
    }
  }
  return { y, h: oh, w: ow };
}

export type Backend = "native" | "vgpu";

export function forward(
  net: Net, noise: Float32Array, cond: Float32Array, backend: Backend = "native"
): { data: Float32Array; size: number } {
  let x: Float32Array = new Float32Array(noise.length + cond.length);
  x.set(noise, 0);
  x.set(cond, noise.length);
  let h = 1, w = 1;
  for (const L of net.layers) {
    if (backend === "vgpu") {
      // 활성화(ReLU/Tanh)까지 ISA 커널 안에서 처리된다.
      const r = vgpuLayer(x, h, w, L);
      x = r.y; h = r.h; w = r.w;
      continue;
    }
    const r = convT(x, h, w, L);
    x = r.y; h = r.h; w = r.w;
    if (L.act === "relu") { for (let i = 0; i < x.length; i++) if (x[i] < 0) x[i] = 0; }
    else { for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i]); }
  }
  return { data: x, size: h }; // (3,h,w), 값 범위 [-1,1]
}

// ---- 시드 가능한 가우시안 난수 (mulberry32 + Box-Muller) ----
function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gaussianNoise(n: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const u = Math.max(rnd(), 1e-12), v = rnd();
    const r = Math.sqrt(-2 * Math.log(u));
    out[i] = r * Math.cos(2 * Math.PI * v);
    if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * v);
  }
  return out;
}

// ---- 최소 PNG 인코더 (비압축 deflate stored 블록) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
export function encodePng(rgb: Uint8Array, size: number): Uint8Array {
  const rowLen = size * 3 + 1;
  const raw = new Uint8Array(rowLen * size);
  for (let y = 0; y < size; y++) raw.set(rgb.subarray(y * size * 3, (y + 1) * size * 3), y * rowLen + 1);
  // zlib: 헤더 78 01 + stored 블록들 + adler32
  const blocks: number[] = [];
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let p = 0; p < raw.length; p += 65535) {
    const len = Math.min(65535, raw.length - p);
    const final = p + len >= raw.length ? 1 : 0;
    parts.push(new Uint8Array([final, len & 255, len >> 8, ~len & 255, (~len >> 8) & 255]), raw.subarray(p, p + len));
  }
  let a = 1, b = 0;
  for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
  const ad = new Uint8Array(4);
  new DataView(ad.buffer).setUint32(0, ((b << 16) | a) >>> 0);
  parts.push(ad);
  void blocks;
  const z = new Uint8Array(parts.reduce((s, q) => s + q.length, 0));
  let o = 0;
  for (const q of parts) { z.set(q, o); o += q.length; }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size); dv.setUint32(4, size);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit, RGB
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const cs = [sig, chunk("IHDR", ihdr), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(cs.reduce((s, q) => s + q.length, 0));
  o = 0;
  for (const q of cs) { png.set(q, o); o += q.length; }
  return png;
}

export function toBase64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function tensorToPng(data: Float32Array, size: number): Uint8Array {
  const rgb = new Uint8Array(size * size * 3);
  const plane = size * size;
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      const v = Math.min(1, Math.max(-1, data[c * plane + i]));
      rgb[i * 3 + c] = Math.round(((v + 1) / 2) * 255);
    }
  }
  return encodePng(rgb, size);
}

/** 폴백 진입점. 가중치가 KV에 없으면 null. */
export async function edgeGenerate(
  env: Pick<Env, "CACHE_KV" | "EDGE_BACKEND">, color: string, shape: string, seed?: number
): Promise<{ model: string; image_base64: string; format: "png" } | null> {
  const net = await loadNet(env);
  if (!net) return null;
  const cond = new Float32Array(net.condDim);
  cond[COLORS.indexOf(color)] = 1;
  cond[COLORS.length + SHAPES.indexOf(shape)] = 1;
  const noise = gaussianNoise(net.noiseDim, seed ?? (Math.random() * 2 ** 32) >>> 0);
  const backend: Backend = env.EDGE_BACKEND === "vgpu" ? "vgpu" : "native";
  const { data, size } = forward(net, noise, cond, backend);
  return { model: `nano-tech-artist-edge-fallback-${backend}`, image_base64: toBase64(tensorToPng(data, size)), format: "png" };
}
