import { Env } from "../env";

/**
 * 추론 서버(FastAPI, Cloudflare 바깥에 호스팅됨)로 요청을 프록시한다.
 * 이 함수가 이 저장소에서 유일하게 "실제 모델 연산이 일어나는 곳"과 통신하는 지점이다.
 * Worker 자신은 어떤 텐서 연산도 수행하지 않는다.
 */
export async function callInferenceServer(
  env: Env,
  path: string,
  body: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const res = await fetch(`${env.INFERENCE_SERVER_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": env.INTERNAL_API_KEY,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    // 추론 서버가 꺼져 있거나 네트워크 오류인 경우 (예: Colab 세션만 있고 상시 서버 미배포 상태)
    return {
      ok: false,
      status: 503,
      data: { error: "inference_server_unreachable" },
    };
  }
}
