<?php
/**
 * Plugin Name: Cloud Press Connector
 * Description: Cloud Press의 Cloudflare Worker API(Flash Texter, Nano-Tech Artist)를 WordPress와 연동합니다.
 *              회원가입 시 Worker API 키 자동 발급, 마이페이지 콘솔, 자동 페이지/포스트 생성, SEO 메타 처리를 담당합니다.
 * Version: 0.1.0
 * Author: Cloud Press
 * Text Domain: cloud-press-connector
 *
 * 설계 원칙 (docs/10-wordpress-architecture.md, docs/11-wordpress-theme-plugin-spec.md 참조):
 *   - 모델 추론은 절대 이 플러그인이 직접 수행하지 않는다. 항상 Worker API를 호출한다.
 *   - WordPress 로그인 세션과 Worker API 키 인증은 완전히 분리된 두 체계다.
 *   - 사용자별 Worker API 키는 브라우저에 절대 노출하지 않는다 (서버사이드 프록시 방식).
 */

if (!defined('ABSPATH')) {
    exit; // 직접 접근 차단
}

define('CP_CONNECTOR_VERSION', '0.1.0');
define('CP_CONNECTOR_DIR', plugin_dir_path(__FILE__));

// 운영 환경별 설정: wp-config.php에 아래 상수들을 정의해야 한다.
//   define('CP_WORKER_PUBLIC_URL', 'https://api.yourdomain.com');   // 사용자 요청용 (Authorization: Bearer 인증)
//   define('CP_WORKER_ADMIN_URL', 'https://api.yourdomain.com');    // 관리자 전용 /internal/* 호출용 (보통 동일 도메인)
//   define('CP_WORKER_ADMIN_SECRET', '...');                        // Worker의 ADMIN_SECRET과 동일한 값
if (!defined('CP_WORKER_PUBLIC_URL') || !defined('CP_WORKER_ADMIN_SECRET')) {
    add_action('admin_notices', function () {
        echo '<div class="notice notice-error"><p>'
            . esc_html__('Cloud Press Connector: wp-config.php에 CP_WORKER_PUBLIC_URL, CP_WORKER_ADMIN_URL, CP_WORKER_ADMIN_SECRET 상수를 정의해야 플러그인이 정상 동작합니다.', 'cloud-press-connector')
            . '</p></div>';
    });
}

require_once CP_CONNECTOR_DIR . 'includes/class-cp-auth.php';
require_once CP_CONNECTOR_DIR . 'includes/class-cp-api-key-issuer.php';
require_once CP_CONNECTOR_DIR . 'includes/class-cp-console.php';
require_once CP_CONNECTOR_DIR . 'includes/class-cp-auto-pages.php';
require_once CP_CONNECTOR_DIR . 'includes/class-cp-seo.php';

add_action('plugins_loaded', function () {
    CP_Auth::init();
    CP_API_Key_Issuer::init();
    CP_Console::init();
    CP_Auto_Pages::init();
    CP_SEO::init();
});

add_action('wp_enqueue_scripts', function () {
    wp_enqueue_script(
        'cp-connector',
        plugins_url('assets/connector.js', __FILE__),
        [],
        CP_CONNECTOR_VERSION,
        true
    );
    wp_localize_script('cp-connector', 'cpConnector', [
        'ajaxUrl' => admin_url('admin-ajax.php'),
    ]);
});

register_activation_hook(__FILE__, function () {
    // 마이페이지 라우팅(rewrite rule)을 등록하려면 활성화 시 flush 필요
    CP_Auto_Pages::register_rewrite_rules();
    flush_rewrite_rules();
});

register_deactivation_hook(__FILE__, function () {
    flush_rewrite_rules();
});
