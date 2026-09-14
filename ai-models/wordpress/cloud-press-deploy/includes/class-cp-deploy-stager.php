<?php
/**
 * 스테이징 → 실제 경로 원자적 교체 (docs/12 6절).
 *
 * live 심볼릭 링크가 가리키는 실제 서비스 경로에는 승인 완료 전까지 절대 손대지 않는다.
 * 승인 완료 시에만 심볼릭 링크를 새 릴리스 디렉토리로 원자적으로 교체한다.
 */

if (!defined('ABSPATH')) {
    exit;
}

class CP_Deploy_Stager
{
    const KEEP_RELEASES = 5; // 롤백을 위해 보관할 이전 릴리스 개수

    /**
     * @return true|WP_Error
     */
    public static function swap_to_live(string $release_dir)
    {
        if (!is_dir($release_dir)) {
            return new WP_Error('release_not_found', __('릴리스 디렉토리를 찾을 수 없습니다.', 'cloud-press-deploy'));
        }

        $live_link = rtrim(CP_DEPLOY_LIVE_LINK, '/');
        $tmp_link  = $live_link . '.tmp';

        // 새 심볼릭 링크를 임시 이름으로 먼저 만든 뒤, rename()으로 교체한다.
        // rename()은 같은 파일시스템 내에서 원자적 연산이므로, 배포 도중 요청이
        // 들어와도 "링크가 없는 순간"이나 "절반만 바뀐 상태"가 발생하지 않는다.
        if (file_exists($tmp_link) || is_link($tmp_link)) {
            unlink($tmp_link);
        }

        if (!symlink($release_dir, $tmp_link)) {
            return new WP_Error('symlink_failed', __('심볼릭 링크 생성에 실패했습니다.', 'cloud-press-deploy'));
        }

        if (!rename($tmp_link, $live_link)) {
            @unlink($tmp_link);
            return new WP_Error('swap_failed', __('원자적 교체에 실패했습니다.', 'cloud-press-deploy'));
        }

        self::cleanup_old_releases();
        return true;
    }

    private static function cleanup_old_releases(): void
    {
        $releases_dir = rtrim(CP_DEPLOY_RELEASES_DIR, '/');
        $dirs = glob($releases_dir . '/*', GLOB_ONLYDIR);
        if (!$dirs) {
            return;
        }

        usort($dirs, function ($a, $b) {
            return filemtime($b) <=> filemtime($a);
        });

        $current_live = is_link(CP_DEPLOY_LIVE_LINK) ? readlink(CP_DEPLOY_LIVE_LINK) : null;

        foreach (array_slice($dirs, self::KEEP_RELEASES) as $old_dir) {
            // 현재 서비스 중인 릴리스는 보관 개수와 무관하게 절대 삭제하지 않는다
            if ($old_dir === $current_live) {
                continue;
            }
            self::remove_directory_recursive($old_dir);
        }
    }

    private static function remove_directory_recursive(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        $items = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, RecursiveDirectoryIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($items as $item) {
            $item->isDir() ? rmdir($item->getPathname()) : unlink($item->getPathname());
        }
        rmdir($dir);
    }

    /**
     * 롤백: live 링크를 이전 릴리스로 되돌린다. 관리자 화면에서 원클릭으로 호출.
     *
     * @return true|WP_Error
     */
    public static function rollback_to(string $previous_release_dir)
    {
        return self::swap_to_live($previous_release_dir);
    }
}
