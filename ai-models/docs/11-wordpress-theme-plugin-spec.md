# WordPress 테마 & cloud-press-connector 플러그인 스펙

## 1. 역할 분리 원칙

- **테마(`cloud-press-theme`)**: 화면 구조, 스타일, SEO 마크업. 로직은 최소화.
- **플러그인(`cloud-press-connector`)**: 회원가입 후킹, Worker API 호출, 마이페이지 콘솔, 자동 페이지 생성 로직. 테마를 바꿔도 핵심 기능이 유지되도록 로직은 전부 플러그인에 둔다 (WordPress 모범 사례: 기능은 플러그인에, 표현은 테마에).

## 2. 회원가입 / 로그인

**결정**: 순수 WordPress 기본 회원가입을 그대로 사용합니다. 별도의 회원 테이블이나 외부 인증을 만들지 않고, `wp_users`/`wp_usermeta`를 그대로 서비스 계정으로 씁니다.

### 2.1 필요한 커스터마이징

기본 WordPress 회원가입은 관리자 화면 스타일이라 프런트엔드에 맞는 가입/로그인 폼이 필요합니다. `cloud-press-connector`가 다음을 제공합니다.

- 숏코드 `[cp_register_form]`, `[cp_login_form]` — 프런트엔드 어디서든 삽입 가능한 커스텀 폼
- `wp_ajax_nopriv_cp_register`, `wp_ajax_nopriv_cp_login` 액션 훅으로 AJAX 처리 (페이지 새로고침 없는 가입/로그인)
- 가입 시 `register_new_user()` WordPress 코어 함수를 그대로 사용 (커스텀 인증 로직을 만들지 않음 — 보안 사고 표면을 최소화)
- 가입 완료 시 사용자 meta에 `cp_api_key`를 자동 발급해 저장 (아래 3절 참조)

```php
// includes/class-cp-auth.php (개요)
add_shortcode('cp_register_form', 'cp_render_register_form');
add_action('wp_ajax_nopriv_cp_register', 'cp_handle_register');

function cp_handle_register() {
    check_ajax_referer('cp_register_nonce', 'nonce');

    $username = sanitize_user($_POST['username']);
    $email    = sanitize_email($_POST['email']);
    $password = $_POST['password']; // WordPress 코어가 해싱 처리

    $user_id = register_new_user($username, $email); // WP 코어 함수
    if (is_wp_error($user_id)) {
        wp_send_json_error(['message' => $user_id->get_error_message()]);
    }

    wp_set_password($password, $user_id);
    cp_issue_api_key_for_user($user_id); // 아래 3절

    wp_send_json_success(['message' => '가입이 완료되었습니다.']);
}
```

## 3. 사용자별 Worker API 키 발급

WordPress 로그인과 Worker의 API 키 인증은 별개 체계입니다 (`10-wordpress-architecture.md` 3절). 가입 시점에 각 사용자에게 Worker용 API 키를 자동 발급해서 연결합니다.

```php
function cp_issue_api_key_for_user(int $user_id): void {
    $raw_key = wp_generate_password(32, false); // 사용자에게 보여주지 않고 내부적으로만 사용
    $key_hash = hash('sha256', $raw_key);

    // Worker의 D1 api_keys 테이블에 등록하는 관리자 전용 엔드포인트 호출
    // (docs/06-cloudflare-worker-spec.md의 "POST /internal/keys" 참조 — 관리자 시크릿으로 인증)
    $response = wp_remote_post(CP_WORKER_ADMIN_URL . '/internal/keys', [
        'headers' => [
            'Content-Type'  => 'application/json',
            'X-Admin-Secret' => CP_WORKER_ADMIN_SECRET, // wp-config.php에 정의, .env 취급
        ],
        'body' => wp_json_encode([
            'key_hash'   => $key_hash,
            'owner_email' => get_userdata($user_id)->user_email,
            'plan'        => 'free',
        ]),
    ]);

    // raw_key는 WordPress 쪽에서만 보관 (사용자에게는 노출하지 않음 -
    // 마이페이지 콘솔은 이 키를 서버사이드에서만 사용해 Worker를 호출한다)
    update_user_meta($user_id, 'cp_worker_api_key', $raw_key);
}
```

**보안 원칙**: 이 API 키는 절대 브라우저(JS)로 내려보내지 않습니다. 마이페이지의 텍스트/이미지 생성 요청은 항상 WordPress 서버(PHP)가 사용자를 대신해 Worker를 호출하는 **서버사이드 프록시** 방식으로 처리합니다. (앞서 만든 정적 데모 프런트엔드는 브라우저에 데모용 공개 키를 노출하는 방식이었지만, 로그인 사용자 전용 마이페이지에서는 이 방식을 쓰지 않습니다 — 사용자별 키가 유출되면 그 사용자의 쿼터가 도용되기 때문입니다.)

## 4. 마이페이지 콘솔

로그인한 사용자가 Flash Texter / Nano-Tech Artist를 실제로 사용해보는 화면입니다.

- 숏코드 `[cp_mypage_console]` — 마이페이지 템플릿에 삽입
- AJAX 액션 `wp_ajax_cp_generate_text`, `wp_ajax_cp_generate_image` (로그인 사용자 전용, `wp_ajax_nopriv_*` 없음)
- PHP가 `get_user_meta($user_id, 'cp_worker_api_key', true)`로 키를 가져와 Worker를 호출하고, 결과만 JSON으로 브라우저에 반환

```php
add_action('wp_ajax_cp_generate_text', 'cp_handle_generate_text');

function cp_handle_generate_text() {
    if (!is_user_logged_in()) {
        wp_send_json_error(['message' => '로그인이 필요합니다.'], 401);
    }
    check_ajax_referer('cp_console_nonce', 'nonce');

    $user_id = get_current_user_id();
    $api_key = get_user_meta($user_id, 'cp_worker_api_key', true);
    $prompt  = sanitize_text_field($_POST['prompt']);

    $response = wp_remote_post(CP_WORKER_PUBLIC_URL . '/v1/text/generate', [
        'headers' => [
            'Content-Type'  => 'application/json',
            'Authorization' => 'Bearer ' . $api_key,
        ],
        'body' => wp_json_encode(['prompt' => $prompt, 'max_tokens' => 128]),
        'timeout' => 15,
    ]);

    if (is_wp_error($response)) {
        wp_send_json_error(['message' => 'API 서버에 연결할 수 없어요.'], 503);
    }

    $body = json_decode(wp_remote_retrieve_body($response), true);
    wp_send_json_success($body);
}
```

이 구조는 기존 Worker의 rate limit이 사용자별로 정확히 걸리게 하면서(각자 자기 키로만 요청), 키 자체는 노출되지 않는 이점이 있습니다.

## 5. 자동 페이지 추가 로직

"자동 페이지 추가"는 다음 두 가지 용도로 구현합니다.

### 5.1 모델 버전 변경 시 안내 페이지 자동 생성

`cloud-press-deploy` 플러그인이 새 모델 버전을 배포하면(`docs/12` 참조), `cloud-press-connector`가 이를 훅으로 받아 "업데이트 노트" 글(post)을 자동 생성합니다.

```php
add_action('cp_model_deployed', 'cp_create_update_post', 10, 2);

function cp_create_update_post(string $model_name, string $version): void {
    wp_insert_post([
        'post_type'    => 'post',
        'post_status'  => 'publish',
        'post_title'   => "{$model_name} {$version} 업데이트",
        'post_content' => cp_render_update_note_template($model_name, $version),
        'post_category' => [cp_get_or_create_category('업데이트 노트')],
    ]);
}
```

### 5.2 사용자 마이페이지 하위 페이지 자동 생성

사용자가 가입하면, 워드프레스 `page` 타입이 아니라 **하나의 마이페이지 템플릿 + 쿼리 파라미터**로 처리합니다 (사용자마다 실제 `wp_posts` row를 만들지 않음 — 수만 명이 가입하면 페이지 테이블이 불필요하게 비대해지는 것을 방지). 즉 "자동 페이지 추가"는 실제 페이지 엔티티 생성이 아니라, 라우팅 레벨에서 처리합니다.

```php
add_action('init', function () {
    add_rewrite_rule('^mypage/?$', 'index.php?cp_mypage=1', 'top');
});
add_filter('query_vars', function ($vars) {
    $vars[] = 'cp_mypage';
    return $vars;
});
add_action('template_redirect', function () {
    if (get_query_var('cp_mypage')) {
        if (!is_user_logged_in()) {
            wp_redirect(wp_login_url(home_url('/mypage/')));
            exit;
        }
        include CP_THEME_DIR . '/templates/mypage.php';
        exit;
    }
});
```

## 6. SEO 친화적 구성

플러그인이 직접 메타 태그를 다루기보다는, 검증된 접근 방식을 그대로 따릅니다.

- 테마의 `header.php`에서 각 템플릿(홈, 마이페이지, 업데이트 노트 글)별로 `<title>`, `<meta name="description">`, Open Graph 태그를 조건 분기로 출력
- 정적 데모 페이지(`frontend/src/`)와 달리 WordPress는 서버사이드 렌더링이라 크롤러가 완전한 HTML을 받는다는 이점을 그대로 살림 (클라이언트 사이드 렌더링에 의존하지 않음)
- `robots.txt`에서 마이페이지, 관리자 승인 화면 등 로그인 전용 영역은 `Disallow` 처리
- 시맨틱 HTML(제목 태그 계층, `<nav>`, `<main>`, `<article>` 등)을 테마 템플릿에서 일관되게 사용
- 사이트맵: WordPress 표준 기능(코어 5.5+ 기본 `wp-sitemap.xml`)을 그대로 활용하고, 마이페이지처럼 로그인 전용인 라우트는 사이트맵에서 제외

이 부분은 SEO 플러그인(예: 널리 쓰이는 무료 플러그인)을 별도로 설치해 표준적으로 처리하는 것도 가능합니다 — `cloud-press-theme`는 그런 플러그인과 충돌하지 않도록 자체 메타 태그 출력 로직에 필터 훅(`cp_seo_title`, `cp_seo_description`)을 걸어 다른 SEO 플러그인이 있으면 그쪽 결과를 우선하도록 설계합니다.

## 7. 디렉토리 구조

```
wordpress/
├── cloud-press-theme/
│   ├── style.css                 # 테마 헤더 + 기본 스타일
│   ├── functions.php             # 테마 셋업, enqueue
│   ├── header.php                # SEO 메타 태그 포함
│   ├── footer.php
│   ├── index.php
│   ├── page.php
│   └── templates/
│       └── mypage.php            # 마이페이지 템플릿 (콘솔 숏코드 삽입)
└── cloud-press-connector/
    ├── cloud-press-connector.php # 플러그인 진입점
    └── includes/
        ├── class-cp-auth.php           # 회원가입/로그인 숏코드+AJAX
        ├── class-cp-api-key-issuer.php # Worker API 키 발급/관리
        ├── class-cp-console.php        # 마이페이지 콘솔 AJAX 핸들러
        ├── class-cp-auto-pages.php     # 자동 페이지/포스트 생성 로직
        └── class-cp-seo.php            # SEO 메타 태그 필터
```
