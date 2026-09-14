<?php
/**
 * Plugin Name: Cloud Press Deploy
 * Description: GitHub 저장소를 관리자 화면에서 등록하면 자동으로 코드를 가져오되,
 *              반영은 화이트리스트 검사 + 관리자 다중 승인을 거친 뒤에만 이루어지는
 *              배포 파이프라인. (docs/12-github-deploy-plugin-spec.md 참조)
 * Version: 0.1.0
 * Author: Cloud Press
 * Text Domain: cloud-press-deploy
 *
 * 절대 원칙: 이 플러그인은 "가져오기는 자동, 반영은 수동 다중 승인 후"로만 동작한다.
 * 승인 없이 자동으로 실제 서비스 경로에 코드를 반영하는 경로는 존재하지 않는다.
 * 배포 대상은 cloud-press 저장소 중 WordPress 테마/플러그인 코드로 한정하며,
 * training/, inference-server/, workers/ 는 이 플러그인의 배포 대상이 아니다
 * (docs/12 8절 참조 — API/모델 서버 코드까지 자동화 파이프라인이 건드리면 위험 범위가
 * 지나치게 커지므로 의도적으로 범위를 제한한다).
 */

if (!defined('ABSPATH')) {
    exit;
}

define('CP_DEPLOY_VERSION', '0.1.0');
define('CP_DEPLOY_DIR', plugin_dir_path(__FILE__));
define('CP_DEPLOY_MIN_APPROVALS', 2); // docs/12 4절 — 등록자 본인 제외 최소 승인 인원

// wp-config.php에 정의해야 하는 상수:
//   define('CP_WORKER_ADMIN_URL', 'https://api.yourdomain.com');
//   define('CP_DEPLOY_PROXY_KEY', '...');  // Worker의 DEPLOY_PROXY_KEY와 동일한 값
//   define('CP_DEPLOY_RELEASES_DIR', '/var/www/cloud-press/releases');
//   define('CP_DEPLOY_LIVE_LINK', '/var/www/cloud-press/live');
if (!defined('CP_DEPLOY_PROXY_KEY') || !defined('CP_WORKER_ADMIN_URL')) {
    add_action('admin_notices', function () {
        echo '<div class="notice notice-error"><p>'
            . esc_html__('Cloud Press Deploy: wp-config.php에 CP_WORKER_ADMIN_URL, CP_DEPLOY_PROXY_KEY 상수를 정의해야 합니다.', 'cloud-press-deploy')
            . '</p></div>';
    });
}

require_once CP_DEPLOY_DIR . 'includes/class-cp-deploy-whitelist.php';
require_once CP_DEPLOY_DIR . 'includes/class-cp-deploy-fetcher.php';
require_once CP_DEPLOY_DIR . 'includes/class-cp-deploy-scanner.php';
require_once CP_DEPLOY_DIR . 'includes/class-cp-deploy-stager.php';
require_once CP_DEPLOY_DIR . 'includes/class-cp-deploy-approval.php';
require_once CP_DEPLOY_DIR . 'admin/deploy-review-page.php';

add_action('plugins_loaded', function () {
    CP_Deploy_Whitelist::init();
    CP_Deploy_Approval::init();
});

add_action('admin_menu', function () {
    add_menu_page(
        __('Cloud Press 배포', 'cloud-press-deploy'),
        __('Cloud Press 배포', 'cloud-press-deploy'),
        'manage_options', // 관리자만 접근 가능
        'cloud-press-deploy',
        'cp_deploy_render_review_page',
        'dashicons-cloud-upload'
    );
});

register_activation_hook(__FILE__, function () {
    // 배포 요청을 저장할 커스텀 포스트 타입 등록에 필요
    CP_Deploy_Approval::register_post_type();
    flush_rewrite_rules();
});
