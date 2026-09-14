<?php
/**
 * 사용자별 Cloudflare Worker API 키 발급/관리.
 *
 * 중요 (docs/10 3절, docs/11 3절): WordPress 로그인과 Worker API 키 인증은
 * 완전히 별개의 인증 체계다. 이 클래스가 발급하는 키는 사용자에게 절대
 * 노출하지 않고, user_meta에 서버사이드로만 저장한다. 텍스트/이미지 생성
 * 요청은 항상 CP_Console이 이 키를 서버에서 대신 사용해 Worker를 호출한다
 * (서버사이드 프록시 방식 — 브라우저 JS에는 이 키가 절대 전달되지 않는다).
 */

if (!defined('ABSPATH')) {
    exit;
}

class CP_API_Key_Issuer
{
    const META_KEY = 'cp_worker_api_key';

    public static function init(): void
    {
        add_action('cp_user_registered', [self::class, 'issue_key_for_user']);
        add_action('delete_user', [self::class, 'revoke_key_for_user']);
    }

    public static function issue_key_for_user(int $user_id): void
    {
        // 이미 키가 있으면 재발급하지 않음 (예: 훅이 중복 호출되는 경우 대비)
        $existing = get_user_meta($user_id, self::META_KEY, true);
        if (!empty($existing)) {
            return;
        }

        $user = get_userdata($user_id);
        if (!$user) {
            return;
        }

        $raw_key  = wp_generate_password(40, false, false);
        $key_hash = hash('sha256', $raw_key);

        $response = wp_remote_post(rtrim(CP_WORKER_ADMIN_URL, '/') . '/internal/keys', [
            'headers' => [
                'Content-Type'   => 'application/json',
                'X-Admin-Secret' => CP_WORKER_ADMIN_SECRET,
            ],
            'body' => wp_json_encode([
                'key_hash'    => $key_hash,
                'owner_email' => $user->user_email,
                'plan'        => 'free',
            ]),
            'timeout' => 10,
        ]);

        if (is_wp_error($response)) {
            error_log('[cloud-press-connector] Worker API 키 발급 실패: ' . $response->get_error_message());
            return;
        }

        $status = wp_remote_retrieve_response_code($response);
        if ($status !== 201) {
            error_log("[cloud-press-connector] Worker API 키 발급 실패, status={$status}");
            return;
        }

        // raw_key는 여기(서버 DB의 user_meta)에만 저장한다. 브라우저로는 절대 전달하지 않는다.
        update_user_meta($user_id, self::META_KEY, $raw_key);
    }

    public static function revoke_key_for_user(int $user_id): void
    {
        $raw_key = get_user_meta($user_id, self::META_KEY, true);
        if (empty($raw_key)) {
            return;
        }
        $key_hash = hash('sha256', $raw_key);

        wp_remote_post(rtrim(CP_WORKER_ADMIN_URL, '/') . '/internal/keys/revoke', [
            'headers' => [
                'Content-Type'   => 'application/json',
                'X-Admin-Secret' => CP_WORKER_ADMIN_SECRET,
            ],
            'body'    => wp_json_encode(['key_hash' => $key_hash]),
            'timeout' => 10,
        ]);

        delete_user_meta($user_id, self::META_KEY);
    }

    public static function get_key_for_user(int $user_id): ?string
    {
        $key = get_user_meta($user_id, self::META_KEY, true);
        return $key ?: null;
    }
}
