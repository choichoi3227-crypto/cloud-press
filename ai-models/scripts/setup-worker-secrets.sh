#!/usr/bin/env bash
#
# setup-worker-secrets.sh
#
# Cloudflare Worker에 필요한 시크릿을 대화형으로 설정합니다.
# `wrangler secret put`은 값을 표준입력으로 받고 절대 파일에 평문으로 남기지 않으므로,
# 이 스크립트도 값을 변수에 담아두지 않고 즉시 wrangler로 파이프합니다.
#
# 사용법:
#   cd workers/api-gateway
#   ../../scripts/setup-worker-secrets.sh
#
# 사전 준비: `npx wrangler login` 을 먼저 실행해 Cloudflare 계정에 인증되어 있어야 합니다.

set -euo pipefail

if [ ! -f "wrangler.toml" ]; then
  echo "오류: workers/api-gateway 디렉토리에서 실행해 주세요 (wrangler.toml을 찾을 수 없습니다)." >&2
  exit 1
fi

echo "=== Cloud Press Worker 시크릿 설정 ==="
echo ""
echo "다음 4개의 시크릿을 순서대로 설정합니다. 이미 값을 갖고 있다면 직접 입력하고,"
echo "새로 만들어야 한다면 Enter만 눌러 자동 생성된 값을 사용할 수 있습니다."
echo ""

generate_secret() {
  openssl rand -hex 32
}

set_secret() {
  local name="$1"
  local description="$2"
  local suggest_generate="$3" # "yes" | "no"

  echo "----------------------------------------"
  echo "[$name]"
  echo "$description"

  local value=""
  if [ "$suggest_generate" = "yes" ]; then
    read -r -p "값을 직접 입력하려면 입력, 자동 생성하려면 그냥 Enter: " value || true
    if [ -z "$value" ]; then
      value=$(generate_secret)
      echo "자동 생성된 값: $value"
      echo "이 값을 wp-config.php의 해당 상수에도 동일하게 넣어야 합니다 (아래 출력 참고)."
    fi
  else
    read -r -s -p "값을 입력하세요 (화면에 표시되지 않습니다): " value || true
    echo ""
  fi

  if [ -z "$value" ]; then
    echo "값이 비어 있어 건너뜁니다: $name" >&2
    return
  fi

  printf '%s' "$value" | npx wrangler secret put "$name"
  echo ""
}

set_secret "INTERNAL_API_KEY" \
  "Worker <-> 추론 서버 간 내부 인증 키. 추론 서버의 INTERNAL_API_KEY 환경변수와 동일해야 합니다." \
  "yes"

set_secret "ADMIN_SECRET" \
  "WordPress cloud-press-connector가 사용자 API 키를 발급받을 때 쓰는 키. wp-config.php의 CP_WORKER_ADMIN_SECRET과 동일해야 합니다." \
  "yes"

set_secret "DEPLOY_PROXY_KEY" \
  "WordPress cloud-press-deploy가 GitHub 프록시를 호출할 때 쓰는 키. wp-config.php의 CP_DEPLOY_PROXY_KEY와 동일해야 합니다." \
  "yes"

set_secret "GITHUB_TOKEN" \
  "GitHub Personal Access Token (repo 읽기 권한만 부여). https://github.com/settings/tokens 에서 발급하세요." \
  "no"

echo "=== 완료 ==="
echo ""
echo "설정된 시크릿 목록 확인:"
npx wrangler secret list

echo ""
echo "다음으로 할 일:"
echo "  1. 자동 생성된 값들을 wp-config.php의 대응 상수에 그대로 붙여넣으세요."
echo "  2. php scripts/wp-config-check.php 로 wp-config.php 설정이 올바른지 확인하세요."
echo "  3. wrangler.toml의 DEPLOY_REPO_WHITELIST 값이 실제 배포 대상 저장소와 일치하는지 확인하세요."
