<?php
/**
 * SEO 메타 태그 처리 (docs/11 6절).
 *
 * 다른 SEO 플러그인(예: 널리 쓰이는 무료 SEO 플러그인)이 함께 설치된 경우
 * 충돌하지 않도록, 필터 훅으로 감싸 다른 플러그인이 이미 값을 채웠으면
 * 그쪽을 우선한다.
 */

if (!defined('ABSPATH')) {
    exit;
}

class CP_SEO
{
    public static function init(): void
    {
        add_action('wp_head', [self::class, 'output_meta_tags'], 1);
        add_filter('wp_sitemaps_posts_query_args', [self::class, 'exclude_login_only_from_sitemap']);
    }

    public static function output_meta_tags(): void
    {
        // 로그인 전용 라우트(마이페이지)는 별도 메타를 출력하지 않고 noindex 처리
        if (get_query_var('cp_mypage')) {
            echo '<meta name="robots" content="noindex, nofollow">' . "\n";
            return;
        }

        $title       = apply_filters('cp_seo_title', self::default_title());
        $description = apply_filters('cp_seo_description', self::default_description());

        if ($title) {
            printf('<meta property="og:title" content="%s">' . "\n", esc_attr($title));
        }
        if ($description) {
            printf('<meta name="description" content="%s">' . "\n", esc_attr($description));
            printf('<meta property="og:description" content="%s">' . "\n", esc_attr($description));
        }
    }

    private static function default_title(): string
    {
        if (is_singular()) {
            return get_the_title();
        }
        return get_bloginfo('name');
    }

    private static function default_description(): string
    {
        if (is_singular()) {
            $excerpt = get_the_excerpt();
            if ($excerpt) {
                return wp_strip_all_tags($excerpt);
            }
        }
        return get_bloginfo('description');
    }

    public static function exclude_login_only_from_sitemap(array $args): array
    {
        // 마이페이지는 실제 post가 아니라 라우팅으로 처리되므로 이 필터는 향후
        // 사용자별 posts를 만드는 방향으로 바뀔 경우를 대비한 확장 지점으로 남겨둔다.
        return $args;
    }
}
