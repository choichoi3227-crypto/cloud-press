<?php
/**
 * wp-config-check.php
 *
 * cloud-press-connector / cloud-press-deploy 플러그인이 필요로 하는 wp-config.php
 * 상수가 전부 정의되어 있는지, 그리고 값의 형태가 명백히 잘못되지는 않았는지
 * 배포 전에 확인하는 진단 스크립트입니다.
 *
 * 사용법 (WordPress 설치 루트에서):
 *   php scripts/wp-config-check.php
 *
 * 이 스크립트는 wp-config.php를 로드하되 WordPress 전체를 부팅하지 않으므로
 * 매우 가볍고 빠르게 실행됩니다. CI(예: cloud-press-deploy가 배포 전 자동 실행)에
 * 연결해도 좋습니다.
 */

$wp_config_path = getenv('CP_WP_CONFIG_PATH') ?: (__DIR__ . '/../../../wp-config.php');

if (!file_exists($wp_config_path)) {
    fwrite(STDERR, "wp-config.php를 찾을 수 없습니다: {$wp_config_path}\n");
    fwrite(STDERR, "CP_WP_CONFIG_PATH 환경변수로 경로를 직접 지정할 수 있습니다.\n");
    exit(1);
}

// ABSPATH가 정의되어 있으면 wp-config.php 안의 require_once(ABSPATH.'wp-settings.php')가
// 전체 WordPress를 부팅하려 시도하므로, 상수 정의 검사만 하고 싶을 때는 이 스크립트를
// wp-config.php 내용 중 상수 정의 부분까지만 파싱하는 방식이 더 안전하다.
// 여기서는 실제 운영 편의를 위해 두 가지 모드를 지원한다.
$mode = getenv('CP_CHECK_MODE') ?: 'static'; // 'static' | 'boot'

$required = [
    'CP_WORKER_PUBLIC_URL' => [
        'description' => '사용자 요청(마이페이지 콘솔)이 호출하는 Worker 공개 도메인',
        'validate' => function ($v) {
            return is_string($v) && preg_match('#^https://#', $v);
        },
        'hint' => 'https:// 로 시작하는 URL이어야 합니다. 예: https://api.example.com',
    ],
    'CP_WORKER_ADMIN_URL' => [
        'description' => '관리자 전용 /internal/* 호출용 Worker 도메인 (보통 PUBLIC과 동일)',
        'validate' => function ($v) {
            return is_string($v) && preg_match('#^https://#', $v);
        },
        'hint' => 'https:// 로 시작하는 URL이어야 합니다.',
    ],
    'CP_WORKER_ADMIN_SECRET' => [
        'description' => 'Worker의 ADMIN_SECRET과 동일해야 하는 값 (사용자 API 키 발급용)',
        'validate' => function ($v) {
            return is_string($v) && strlen($v) >= 16;
        },
        'hint' => '최소 16자 이상의 무작위 문자열을 권장합니다. `openssl rand -hex 32`로 생성하세요.',
    ],
    'CP_DEPLOY_PROXY_KEY' => [
        'description' => 'Worker의 DEPLOY_PROXY_KEY와 동일해야 하는 값 (GitHub 배포 프록시용)',
        'validate' => function ($v) {
            return is_string($v) && strlen($v) >= 16;
        },
        'hint' => '최소 16자 이상의 무작위 문자열을 권장합니다. CP_WORKER_ADMIN_SECRET과는 다른 값을 사용하세요.',
    ],
    'CP_DEPLOY_RELEASES_DIR' => [
        'description' => '배포 스테이징 디렉토리 (실제 서비스 경로 바깥이어야 함)',
        'validate' => function ($v) {
            return is_string($v) && $v !== '' && $v[0] === '/';
        },
        'hint' => '절대 경로여야 합니다. 예: /var/www/cloud-press/releases',
    ],
    'CP_DEPLOY_LIVE_LINK' => [
        'description' => '실제 서비스 중인 코드가 위치할 심볼릭 링크 경로',
        'validate' => function ($v) {
            return is_string($v) && $v !== '' && $v[0] === '/';
        },
        'hint' => '절대 경로여야 합니다. 예: /var/www/cloud-press/live',
    ],
];

echo "=== Cloud Press wp-config.php 검증 ===\n\n";

if ($mode === 'static') {
    $constants = cp_extract_defines_statically($wp_config_path);
} else {
    // 'boot' 모드: 실제로 wp-config.php를 include (WordPress 루트에서 실행되고
    // wp-settings.php까지 정상적으로 로드 가능한 환경일 때만 사용 권장)
    define('ABSPATH', dirname($wp_config_path) . '/');
    // wp-settings.php의 전체 부팅을 막기 위해 shutdown 트릭을 쓰는 대신,
    // 대부분의 wp-config.php는 상수 정의 이후에 require wp-settings.php를 호출하므로
    // static 모드 사용을 기본값으로 강력히 권장한다.
    fwrite(STDERR, "경고: boot 모드는 WordPress 전체를 부팅하려 시도할 수 있습니다. static 모드를 권장합니다.\n");
    include $wp_config_path;
    $constants = [];
    foreach (array_keys($required) as $name) {
        if (defined($name)) {
            $constants[$name] = constant($name);
        }
    }
}

$has_error = false;

foreach ($required as $name => $spec) {
    if (!array_key_exists($name, $constants)) {
        echo "[누락] {$name}\n";
        echo "       {$spec['description']}\n";
        echo "       힌트: {$spec['hint']}\n\n";
        $has_error = true;
        continue;
    }

    $value = $constants[$name];
    if (!$spec['validate']($value)) {
        echo "[값 이상] {$name}\n";
        echo "       현재 값이 예상 형식과 다릅니다.\n";
        echo "       힌트: {$spec['hint']}\n\n";
        $has_error = true;
        continue;
    }

    $masked = cp_mask_secret_like($name, $value);
    echo "[정상] {$name} = {$masked}\n";
}

// 서로 다른 값이어야 하는 두 시크릿이 실수로 같은 값인지 확인 (흔한 설정 실수)
if (
    isset($constants['CP_WORKER_ADMIN_SECRET'], $constants['CP_DEPLOY_PROXY_KEY']) &&
    $constants['CP_WORKER_ADMIN_SECRET'] === $constants['CP_DEPLOY_PROXY_KEY']
) {
    echo "\n[경고] CP_WORKER_ADMIN_SECRET과 CP_DEPLOY_PROXY_KEY가 동일한 값입니다.\n";
    echo "       서로 다른 용도의 시크릿이므로 별개의 값을 사용하는 것을 강력히 권장합니다.\n";
}

echo "\n";
if ($has_error) {
    echo "=== 검증 실패: 위 항목을 wp-config.php에 수정/추가해 주세요 ===\n";
    exit(1);
}

echo "=== 모든 필수 상수가 올바르게 설정되어 있습니다 ===\n";
exit(0);

/**
 * wp-config.php를 실제로 실행하지 않고, define('NAME', 값) 패턴만 정규식으로
 * 추출한다. WordPress 전체를 부팅하지 않아 어떤 환경에서도 안전하게 실행 가능.
 * 값이 단순 문자열/숫자 리터럴이 아닌 경우(변수 참조, 함수 호출 결과 등)는
 * 감지하지 못할 수 있으니, 그 경우 boot 모드 사용을 안내한다.
 */
function cp_extract_defines_statically(string $path): array
{
    $content = file_get_contents($path);
    $constants = [];

    // define('NAME', 'value') 또는 define("NAME", "value") 형태만 매칭 (가장 흔한 패턴)
    if (preg_match_all(
        '/define\s*\(\s*[\'"]([A-Z_][A-Z0-9_]*)[\'"]\s*,\s*[\'"]([^\'"]*)[\'"]\s*\)/',
        $content,
        $matches,
        PREG_SET_ORDER
    )) {
        foreach ($matches as $m) {
            $constants[$m[1]] = $m[2];
        }
    }

    return $constants;
}

function cp_mask_secret_like(string $name, string $value): string
{
    if (stripos($name, 'secret') !== false || stripos($name, 'key') !== false) {
        if (strlen($value) <= 6) {
            return str_repeat('*', strlen($value));
        }
        return substr($value, 0, 3) . str_repeat('*', max(strlen($value) - 6, 3)) . substr($value, -3);
    }
    return $value;
}
