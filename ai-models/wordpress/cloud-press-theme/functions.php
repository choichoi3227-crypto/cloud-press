<?php
/**
 * Cloud Press Theme functions.php
 * 로직은 최소화하고, 실제 기능(회원가입/로그인/콘솔 등)은 cloud-press-connector
 * 플러그인이 담당한다 (docs/11 1절 — 테마는 표현, 플러그인은 기능).
 */

if (!defined('ABSPATH')) {
    exit;
}

function cp_theme_setup(): void
{
    add_theme_support('title-tag');
    add_theme_support('post-thumbnails');
    add_theme_support('html5', ['search-form', 'comment-form', 'comment-list', 'gallery', 'caption']);
    register_nav_menus([
        'primary' => __('메인 메뉴', 'cloud-press-theme'),
    ]);
}
add_action('after_setup_theme', 'cp_theme_setup');

function cp_theme_enqueue_assets(): void
{
    wp_enqueue_style('cp-theme-style', get_stylesheet_uri(), [], wp_get_theme()->get('Version'));
}
add_action('wp_enqueue_scripts', 'cp_theme_enqueue_assets');
