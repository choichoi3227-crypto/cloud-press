# cloud-press-deploy — GitHub 자동 배포 플러그인 스펙

## 1. 이 기능이 실제로 하는 일 (그리고 왜 위험한지)

관리자 화면에서 GitHub 저장소 URL을 입력하면, 서버가 해당 코드를 가져와 최종적으로 실행 경로(테마/플러그인 디렉토리, 또는 별도 서비스)에 반영하는 기능입니다. 이건 본질적으로 **"원격 코드를 프로덕션 서버에 자동으로 들여오는 파이프라인"**이며, 잘못 설계하면 다음과 같은 사고로 이어질 수 있습니다.

- 저장소 URL이 조작되거나 탈취되면 임의 코드가 그대로 실행됨 (RCE)
- 검토 없이 자동 반영되면, 실수로 커밋된 버그나 악성 코드가 즉시 프로덕션에 배포됨
- 승인자가 1명뿐이면 그 계정 하나가 뚫리는 순간 전체가 뚫림

**따라서 이 플러그인은 "완전 자동"이 아니라 "가져오기는 자동, 반영은 수동 다중 승인 후"로 설계합니다.** 이건 사용자와 이미 합의된 원칙입니다.

## 2. 전체 흐름

```
관리자가 저장소 URL 등록
        │
        ▼
① 화이트리스트 검사 (등록된 owner/repo만 허용)
        │
        ▼
② GitHub API로 최신 커밋/릴리스 정보 조회
        │
        ▼
③ 코드를 스테이징 디렉토리에 다운로드 (실행 경로가 아닌 격리된 곳)
        │
        ▼
④ 정적 검사 (파일 목록/확장자/용량 확인, 위험 패턴 스캔)
        │
        ▼
⑤ 관리자 알림 발송 ("새 배포 대기 중" — 이메일/관리자 화면 배지)
        │
        ▼
⑥ 관리자 N명이 각자 검토 후 승인 버튼 클릭 (최소 승인 인원수 충족 전까지 대기)
        │
        ▼
⑦ 승인 인원 충족 시에만 스테이징 → 실제 경로로 원자적 교체(atomic swap)
        │
        ▼
⑧ 배포 로그 기록, cp_model_deployed 훅 발생 (11번 문서의 자동 업데이트 노트 생성과 연결)
```

## 3. 화이트리스트

```php
// 관리자 화면(설정 > Cloud Press 배포)에서만 추가/삭제 가능. wp_options에 저장.
$whitelist = [
    'choichoi3227-crypto/cloud-press', // owner/repo 형식만 허용
];

function cp_deploy_is_whitelisted(string $owner, string $repo): bool {
    $whitelist = get_option('cp_deploy_whitelist', []);
    return in_array("{$owner}/{$repo}", $whitelist, true);
}
```

- 화이트리스트 자체를 추가/수정하는 것도 **관리자 다중 승인 대상**입니다 (그렇지 않으면 화이트리스트를 몰래 바꿔서 안전장치를 우회할 수 있음).
- URL에서 `owner/repo`만 추출하고, 브랜치/태그는 별도 화이트리스트(`main`, `release/*` 패턴 등)로 제한합니다. 임의 브랜치를 허용하면 화이트리스트가 무의미해집니다.

## 4. 다중 승인 워크플로

**정책**: 최소 2인의 서로 다른 관리자 승인 필요 (요청 등록자 본인은 승인자 수에 포함되지 않음 — "셀프 승인" 방지).

```php
// includes/class-cp-deploy-approval.php (개요)

class CP_Deploy_Approval {
    const MIN_APPROVALS = 2;

    public static function request_deploy(string $repo_url, int $requested_by): int {
        $deploy_id = wp_insert_post([
            'post_type'   => 'cp_deploy_request',
            'post_status' => 'pending', // 커스텀 상태: pending -> approved -> deployed / rejected
            'post_author' => $requested_by,
            'meta_input'  => [
                'repo_url'    => $repo_url,
                'approvals'   => [], // 승인한 관리자 user_id 배열
                'staged_path' => '',
            ],
        ]);

        self::notify_admins_new_request($deploy_id);
        return $deploy_id;
    }

    public static function approve(int $deploy_id, int $approver_id): bool {
        $requested_by = get_post_field('post_author', $deploy_id);
        if ((int) $requested_by === $approver_id) {
            return false; // 셀프 승인 금지
        }

        $approvals = get_post_meta($deploy_id, 'approvals', true) ?: [];
        if (in_array($approver_id, $approvals, true)) {
            return false; // 중복 승인 방지
        }
        $approvals[] = $approver_id;
        update_post_meta($deploy_id, 'approvals', $approvals);

        if (count($approvals) >= self::MIN_APPROVALS) {
            self::execute_deploy($deploy_id);
        }
        return true;
    }

    private static function execute_deploy(int $deploy_id): void {
        // 스테이징 경로 -> 실제 경로로 원자적 교체 (아래 6절)
        // 성공 시 post_status를 'deployed'로, 실패 시 'failed'로 갱신하고 관리자에게 알림
    }
}
```

- 승인 UI는 관리자 화면(`wp-admin`)에서만 접근 가능하며, 매 승인 액션은 nonce + `current_user_can('manage_options')` 권한 체크를 거칩니다.
- 등록자 본인이 승인자 수에 포함되지 않도록 강제합니다 (위 코드의 셀프 승인 금지 로직).
- 모든 승인/반려 행위는 타임스탬프와 함께 로그로 남깁니다 (감사 추적용).

## 5. 코드를 가져오는 방법: GitHub API + Cloudflare 경유

사용자 요청에 있던 "GitHub + Cloudflare 둘 다 이용, Cloudflare를 통해 경유"를 다음과 같이 구현합니다.

- WordPress 서버가 GitHub에 직접 요청하는 대신, **Cloudflare Worker에 별도의 경량 엔드포인트(`/internal/github-proxy`)를 하나 추가**하여 그 경유지로 삼습니다.
- 장점: (1) GitHub API 호출 시 필요한 토큰을 Worker의 시크릿으로만 보관해 WordPress 서버에는 두지 않아도 됨, (2) Cloudflare의 캐싱/rate-limit을 그대로 활용해 GitHub API 호출량 절약, (3) WordPress 서버의 아웃바운드 IP가 노출되지 않음.

```typescript
// workers/api-gateway/src/routes/githubProxy.ts (신규, 기존 라우트와 별개)
// 이 라우트는 /v1/* 와 분리된 /internal/* 네임스페이스를 쓰고,
// WordPress 서버의 고정 시크릿(X-Deploy-Proxy-Key)으로만 인증한다.
// 텍스트/이미지 생성 API의 사용자용 인증(D1 api_keys)과는 완전히 별개의 인증 체계.

githubProxy.get("/repo-info/:owner/:repo", async (c) => {
  const { owner, repo } = c.req.param();
  if (!isWhitelisted(owner, repo, c.env)) {
    return c.json({ error: "repo_not_whitelisted" }, 403);
  }
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/main`, {
    headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, "User-Agent": "cloud-press-deploy" },
  });
  return c.json(await res.json());
});
```

Worker 쪽에도 화이트리스트 검사를 이중으로 넣어(WordPress 쪽 검사가 우회되더라도 Worker가 한 번 더 막음), 방어를 한 계층 더 추가합니다.

## 6. 스테이징과 원자적 교체

```
/var/www/cloud-press/
├── live/            <- 실제 서비스 중인 코드 (심볼릭 링크)
├── releases/
│   ├── 2026-09-06-a1b2c3/   <- 스테이징 다운로드 위치, 검토/승인 대상
│   └── 2026-09-01-9f8e7d/   <- 이전 배포본 (롤백용으로 보관)
```

- 다운로드는 항상 `releases/<날짜>-<커밋해시>/`라는 새 디렉토리에 받습니다. **`live`가 가리키는 실제 서비스 경로에는 승인 완료 전까지 절대 손대지 않습니다.**
- 승인이 완료되면 `live` 심볼릭 링크를 새 릴리스 디렉토리로 원자적으로(symlink swap) 교체합니다. 이렇게 하면 배포 도중 파일이 반쯤 바뀐 상태로 요청이 들어오는 문제가 없습니다.
- 이전 릴리스는 최소 N개(예: 5개) 보관해 문제가 생기면 즉시 이전 심볼릭 링크로 되돌릴 수 있게 합니다(원클릭 롤백).

## 7. 정적 검사 (4단계)

승인자가 검토하기 전에 명백히 위험한 것들을 자동으로 걸러 알림에 표시합니다 (승인 자체를 자동으로 막지는 않되, 승인 화면에 경고를 노출).

- 실행 파일 확장자(`.exe`, `.sh`가 예상 밖 위치에 있는 경우 등) 존재 여부
- 파일 총 용량이 비정상적으로 큰 경우
- `eval(`, `base64_decode(` + `eval(` 조합처럼 흔히 악성 PHP 웹셸에 쓰이는 패턴 (참고용 경고일 뿐, 이 검사를 통과했다고 안전이 보장되는 것은 아니므로 반드시 사람이 검토)

## 8. 배포 대상物은 무엇인가 (범위 제한)

이 플러그인이 자동으로 가져와 반영하는 대상은 **`cloud-press` 리포지토리 중 WordPress 관련 코드(테마/플러그인 자체의 업데이트)로 한정**합니다. `training/`, `inference-server/`, `workers/`처럼 모델 학습·추론·API 게이트웨이 코드는 이 플러그인의 배포 대상이 아닙니다 — 그쪽은 기존 방식대로(Colab 노트북 실행, `wrangler deploy`, 추론 서버 재배포) 별도로 관리합니다. 하나의 자동화 파이프라인이 API 서버 코드까지 건드리게 하면 위험 범위가 지나치게 커집니다.

## 9. 디렉토리 구조

```
wordpress/cloud-press-deploy/
├── cloud-press-deploy.php        # 플러그인 진입점
└── includes/
    ├── class-cp-deploy-whitelist.php
    ├── class-cp-deploy-approval.php   # 다중 승인 워크플로
    ├── class-cp-deploy-fetcher.php    # Worker 경유 GitHub 조회/다운로드
    ├── class-cp-deploy-stager.php     # 스테이징 + 원자적 교체
    ├── class-cp-deploy-scanner.php    # 정적 검사
    └── admin/
        └── deploy-review-page.php     # 관리자 승인 화면
```
