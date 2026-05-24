<?php
/**
 * CloudPress WordPress PHP Edge — 보안 미들웨어
 * wp-content/mu-plugins/cloudpress-security.php
 *
 * WordPress MU Plugin으로 자동 로드됨
 * - SQL Injection 방어 (추가 레이어)
 * - XSS 방어
 * - 악성 User-Agent 차단
 * - 위험 URL 파라미터 차단
 * - WordPress 로그인 보호
 */

if (!defined('ABSPATH')) {
    exit('Direct access not allowed.');
}

class CloudPress_Security {

    /** 싱글톤 */
    private static ?self $instance = null;

    public static function init(): void {
        if (self::$instance) return;
        self::$instance = new self();
        self::$instance->register_hooks();
    }

    private function register_hooks(): void {
        // 요청 초기에 위험 입력값 검사
        add_action('init', [$this, 'sanitize_request'], 1);

        // WordPress 쿼리 필터링
        add_filter('query', [$this, 'filter_query']);

        // 로그인 시도 제한 헤더
        add_action('login_init', [$this, 'login_security_headers']);

        // REST API 보안 헤더
        add_filter('rest_pre_serve_request', [$this, 'rest_security_headers']);
    }

    /** ── 요청 파라미터 정제 ──────────────────────────────────────────── */
    public function sanitize_request(): void {
        // 악성 User-Agent 차단
        $ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
        $blocked_ua = [
            'sqlmap', 'nikto', 'nmap', 'masscan', 'zgrab',
            'python-requests/2.1', 'go-http-client/1.1',
            'dirbuster', 'dirb ', 'wfuzz', 'acunetix', 'nessus',
        ];
        foreach ($blocked_ua as $bad) {
            if (stripos($ua, $bad) !== false) {
                $this->block_request('Forbidden', 403);
            }
        }

        // 위험 쿼리스트링 패턴 차단
        $query_string = $_SERVER['QUERY_STRING'] ?? '';
        $dangerous_patterns = [
            '/(<|%3C)[^>]*(script|img|svg|iframe)/i',  // XSS
            '/union\s+(all\s+)?select/i',               // SQL Union
            '/;\s*(drop|truncate|delete|insert|update)\s/i', // SQL DDL/DML
            '/\bor\b\s+[\'"]\w+[\'"]?\s*=\s*[\'"]\w+/i',   // OR 1=1
            '/\/etc\/passwd/i',                          // LFI
            '/\.\.\//i',                                 // Path traversal
            '/base64_decode\s*\(/i',                     // PHP eval
            '/eval\s*\(/i',                              // eval
        ];
        foreach ($dangerous_patterns as $pattern) {
            if (preg_match($pattern, urldecode($query_string))) {
                $this->block_request('Bad Request', 400);
            }
        }

        // POST body 검사 (로그인 폼 등)
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $raw = file_get_contents('php://input');
            if ($raw && strlen($raw) < 65536) { // 64KB 이하만 검사
                foreach ($dangerous_patterns as $pattern) {
                    if (preg_match($pattern, urldecode($raw))) {
                        $this->block_request('Bad Request', 400);
                    }
                }
            }
        }
    }

    /** ── DB 쿼리 추가 필터링 ────────────────────────────────────────── */
    public function filter_query(string $query): string {
        // null 바이트 제거
        $query = str_replace("\x00", '', $query);

        // 다중 쿼리 스택킹 차단 (WordPress는 단일 쿼리만 허용)
        // 예: SELECT 1; DROP TABLE users;
        if (substr_count(rtrim($query, " \t\n\r;"), ';') > 0) {
            $pos = strpos($query, ';');
            if ($pos !== false) {
                // 첫 쿼리만 허용
                $query = substr($query, 0, $pos + 1);
            }
        }

        return $query;
    }

    /** ── 로그인 보안 헤더 ───────────────────────────────────────────── */
    public function login_security_headers(): void {
        // 로그인 폼에 캐시 방지 헤더
        nocache_headers();
        // 클릭재킹 방지
        header('X-Frame-Options: DENY');
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: strict-origin');
    }

    /** ── REST API 보안 헤더 ─────────────────────────────────────────── */
    public function rest_security_headers(bool $served): bool {
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: DENY');
        header('Referrer-Policy: strict-origin');
        return $served;
    }

    /** ── 요청 차단 ─────────────────────────────────────────────────── */
    private function block_request(string $message, int $code): never {
        status_header($code);
        nocache_headers();
        header('Content-Type: text/plain; charset=utf-8');
        exit($message);
    }
}

// WordPress 초기화 시 보안 미들웨어 활성화
CloudPress_Security::init();

/**
 * WordPress 로그인 페이지 이메일 검증 강화
 * SQL Injection 문자가 포함된 경우 차단
 */
add_filter('authenticate', function ($user, $username, $password) {
    if (is_wp_error($user)) return $user;

    // 이메일/사용자명 검증
    if (!empty($username)) {
        // null 바이트 차단
        if (strpos($username, "\x00") !== false) {
            return new WP_Error('invalid_username', '올바르지 않은 입력입니다.');
        }
        // 이메일로 로그인 시 형식 검증
        if (strpos($username, '@') !== false) {
            if (!filter_var($username, FILTER_VALIDATE_EMAIL)) {
                return new WP_Error('invalid_email', '올바른 이메일 형식이 아닙니다.');
            }
        }
    }

    return $user;
}, 5, 3);

/**
 * 전체 보안 HTTP 응답 헤더 추가
 */
add_action('send_headers', function () {
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: SAMEORIGIN');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('Permissions-Policy: camera=(), microphone=(), geolocation=()');
    // CSP (관리자 페이지 제외)
    if (!is_admin()) {
        header("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src 'self' fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'");
    }
});
