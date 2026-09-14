<?php
if (!defined('ABSPATH')) {
    exit;
}
get_header();
?>

<?php if (have_posts()): ?>
    <?php while (have_posts()): the_post(); ?>
        <article <?php post_class(); ?>>
            <h2><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></h2>
            <div><?php the_excerpt(); ?></div>
        </article>
    <?php endwhile; ?>
    <?php the_posts_pagination(); ?>
<?php else: ?>
    <p><?php esc_html_e('게시물이 없습니다.', 'cloud-press-theme'); ?></p>
<?php endif; ?>

<?php get_footer(); ?>
