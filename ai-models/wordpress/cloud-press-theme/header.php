<!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php bloginfo('charset'); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1">
<?php
// CP_SEO::output_meta_tags()가 wp_head 훅(priority 1)에서 description/og 태그를 출력한다.
// (wordpress/cloud-press-connector/includes/class-cp-seo.php 참조)
wp_head();
?>
</head>
<body <?php body_class(); ?>>
<header class="cp-site-header">
    <div class="cp-wrap">
        <a href="<?php echo esc_url(home_url('/')); ?>"><?php bloginfo('name'); ?></a>
        <?php
        wp_nav_menu([
            'theme_location' => 'primary',
            'container'      => false,
            'fallback_cb'    => false,
        ]);
        ?>
        <?php if (is_user_logged_in()): ?>
            <a href="<?php echo esc_url(home_url('/mypage/')); ?>"><?php esc_html_e('마이페이지', 'cloud-press-theme'); ?></a>
            <a href="<?php echo esc_url(wp_logout_url(home_url('/'))); ?>"><?php esc_html_e('로그아웃', 'cloud-press-theme'); ?></a>
        <?php else: ?>
            <a href="<?php echo esc_url(wp_login_url()); ?>"><?php esc_html_e('로그인', 'cloud-press-theme'); ?></a>
        <?php endif; ?>
    </div>
</header>
<main class="cp-wrap">
