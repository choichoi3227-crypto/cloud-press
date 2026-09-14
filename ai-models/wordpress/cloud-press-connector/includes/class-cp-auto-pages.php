<?php
/**
 * 자동 페이지 추가 로직 (docs/11 5절).
 *
 * 두 가지 용도:
 *   1) 모델 버전 배포 시 "업데이트 노트" 포스트 자동 생성
 *   2) 마이페이지: 사용자마다 실제 wp_posts row를 만들지 않고,
 *      라우팅(rewrite rule) 레벨에서 처리 — 가입자가 늘어도 포스트 테이블이
 *      비대해지지 않도록 하기 위함.
 */

if (!defined('ABSPATH')) {
    exit;
}

class CP_Auto_Pages
{
    public static function init(): void
    {
        add_action('init', [self::class, 'register_rewrite_rules']);
        add_filter('query_vars', [self::class, 'register_query_vars']);
        add_action('template_redirect', [self::class, 'handle_mypage_route']);

        // cloud-press-deploy 플러그인이 배포 완료 시 발생시키는 훅 (docs/12 참조)
        add_action('cp_model_deployed', [self::class, 'create_update_post'], 10, 2);
    }

    public static function register_rewrite_rules(): void
    {
        add_rewrite_rule('^mypage/?$', 'index.php?cp_mypage=1', 'top');
    }

    public static function register_query_vars(array $vars): array
    {
        $vars[] = 'cp_mypage';
        return $vars;
    }

    public static function handle_mypage_route(): void
    {
        if (!get_query_var('cp_mypage')) {
            return;
        }

        if (!is_user_logged_in()) {
            wp_safe_redirect(wp_login_url(home_url('/mypage/')));
            exit;
        }

        $template = locate_template('templates/mypage.php');
        if ($template) {
            include $template;
        } else {
            // 테마가 마이페이지 템플릿을 제공하지 않는 경우를 위한 최소 폴백
            get_header();
            echo '<main class="cp-mypage-fallback">';
            echo do_shortcode('[cp_mypage_console]');
            echo '</main>';
            get_footer();
        }
        exit;
    }

    public static function create_update_post(string $model_name, string $version): void
    {
        $category_id = self::get_or_create_category(__('업데이트 노트', 'cloud-press-connector'));

        wp_insert_post([
            'post_type'     => 'post',
            'post_status'   => 'publish',
            'post_title'    => sprintf('%s %s 업데이트', $model_name, $version),
            'post_content'  => self::render_update_note_template($model_name, $version),
            'post_category' => $category_id ? [$category_id] : [],
        ]);
    }

    private static function get_or_create_category(string $name): int
    {
        $term = term_exists($name, 'category');
        if ($term && !is_wp_error($term)) {
            return (int) $term['term_id'];
        }
        $created = wp_insert_term($name, 'category');
        if (is_wp_error($created)) {
            return 0;
        }
        return (int) $created['term_id'];
    }

    private static function render_update_note_template(string $model_name, string $version): string
    {
        return sprintf(
            '<p>%s의 새 버전 %s가 배포되었습니다.</p>',
            esc_html($model_name),
            esc_html($version)
        );
    }
}
