<?php
/**
 * 마이페이지 템플릿. cloud-press-connector의 CP_Auto_Pages가 라우팅 레벨에서
 * 이 템플릿을 include한다 (실제 wp_posts row가 아님 — docs/11 5.2절 참조).
 */
if (!defined('ABSPATH')) {
    exit;
}
get_header();
?>

<h1><?php esc_html_e('마이페이지', 'cloud-press-theme'); ?></h1>
<p>
    <?php
    $user = wp_get_current_user();
    printf(esc_html__('%s님, 환영합니다.', 'cloud-press-theme'), esc_html($user->display_name));
    ?>
</p>

<?php echo do_shortcode('[cp_mypage_console]'); ?>

<?php get_footer(); ?>
