/**
 * 무료 플랜 안전 폴백: 오프라인에서 미리 생성한 이미지 뱅크에서 한 장을 골라 반환한다.
 * 요청당 하는 일은 KV 읽기 1회 + 문자열 슬라이스뿐이라 CPU가 거의 들지 않는다(무료 한도 10ms 대비 충분).
 * 뱅크 생성: training/nano-tech-artist/build_edge_bank.py → wrangler kv bulk put
 */
import { Env } from "../env";

export const BANK_KEY = (color: string, shape: string) => `edge-bank:nta:v1:${color}:${shape}`;

export async function bankPick(
  env: Env, color: string, shape: string
): Promise<{ model: string; image_base64: string; format: "png" } | null> {
  // cacheTtl: 같은 PoP에서 KV 재조회를 줄여 무료 KV 읽기 한도(일 10만)를 아낀다.
  const text = await env.CACHE_KV.get(BANK_KEY(color, shape), { type: "text", cacheTtl: 3600 });
  if (!text) return null;
  // 줄 수 세기 → 무작위 줄 선택 → 해당 구간만 슬라이스 (split 없이 최소 연산)
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  let pick = Math.floor(Math.random() * n);
  let start = 0;
  while (pick-- > 0) start = text.indexOf("\n", start) + 1;
  let end = text.indexOf("\n", start);
  if (end === -1) end = text.length;
  const b64 = text.slice(start, end);
  if (!b64) return null;
  return { model: "nano-tech-artist-edge-bank", image_base64: b64, format: "png" };
}
