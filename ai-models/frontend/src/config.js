// Cloud Press 프런트엔드 설정.
// 배포 환경에 맞춰 이 파일만 수정하면 됩니다 (Worker 도메인, 데모용 API 키).
//
// 주의: 이 API 키는 브라우저에 노출됩니다. 프로덕션에서는 프런트엔드 전용의
// 낮은 rate limit을 가진 "공개 데모 키"를 별도로 발급해 사용하세요
// (docs/06-cloudflare-worker-spec.md의 plan 개념 참조). 절대 관리자용/고한도 키를
// 여기에 넣지 마세요.
window.CLOUD_PRESS_CONFIG = {
  API_BASE_URL: "http://localhost:8787", // 배포 시 예: "https://api.yourdomain.com"
  DEMO_API_KEY: "demo-key-replace-me",
};
