<?php
/**
 * Worker의 /internal/github-proxy를 경유해 GitHub 저장소 정보를 조회하고,
 * 실제 코드는 GitHub의 codeload(tarball) 엔드포인트에서 직접 다운로드한다.
 * (docs/12 5절 — GitHub 토큰은 Worker에만 보관하고 WordPress 서버에는 두지 않는다)
 */

if (!defined('ABSPATH')) {
    exit;
}

class CP_Deploy_Fetcher
{
    /**
     * @return array{sha: string, message: string}|WP_Error
     */
    public static function get_latest_commit(string $owner, string $repo, string $branch)
    {
        if (!CP_Deploy_Whitelist::is_allowed($owner, $repo)) {
            return new WP_Error('not_whitelisted', __('화이트리스트에 없는 저장소입니다.', 'cloud-press-deploy'));
        }
        if (!CP_Deploy_Whitelist::is_branch_allowed($branch)) {
            return new WP_Error('branch_not_allowed', __('허용되지 않은 브랜치입니다.', 'cloud-press-deploy'));
        }

        $url = sprintf(
            '%s/internal/github-proxy/latest-commit/%s/%s/%s',
            rtrim(CP_WORKER_ADMIN_URL, '/'),
            rawurlencode($owner),
            rawurlencode($repo),
            rawurlencode($branch)
        );

        $response = wp_remote_get($url, [
            'headers' => ['X-Deploy-Proxy-Key' => CP_DEPLOY_PROXY_KEY],
            'timeout' => 15,
        ]);

        if (is_wp_error($response)) {
            return $response;
        }
        if (wp_remote_retrieve_response_code($response) !== 200) {
            return new WP_Error('github_proxy_error', __('저장소 정보를 가져오지 못했습니다.', 'cloud-press-deploy'));
        }

        $data = json_decode(wp_remote_retrieve_body($response), true);
        return [
            'sha'     => $data['sha'] ?? '',
            'message' => $data['commit']['message'] ?? '',
        ];
    }

    /**
     * 저장소 tarball을 스테이징 디렉토리로 다운로드한다.
     * 이 함수는 실행 경로(live)에는 절대 쓰지 않고, 항상 새 릴리스 디렉토리에만 받는다.
     *
     * @return string|WP_Error 다운로드된 스테이징 디렉토리 경로
     */
    public static function download_to_staging(string $owner, string $repo, string $sha)
    {
        if (!CP_Deploy_Whitelist::is_allowed($owner, $repo)) {
            return new WP_Error('not_whitelisted', __('화이트리스트에 없는 저장소입니다.', 'cloud-press-deploy'));
        }

        // GitHub codeload는 공개 저장소 tarball을 토큰 없이도 커밋 sha로 받을 수 있다.
        // 비공개 저장소라면 Worker 프록시를 통해 인증된 다운로드로 바꿔야 한다 (향후 확장 지점).
        $tarball_url = sprintf('https://codeload.github.com/%s/%s/tar.gz/%s', $owner, $repo, $sha);

        $release_dir = rtrim(CP_DEPLOY_RELEASES_DIR, '/') . '/' . gmdate('Y-m-d') . '-' . substr($sha, 0, 7);
        if (!wp_mkdir_p($release_dir)) {
            return new WP_Error('mkdir_failed', __('스테이징 디렉토리를 만들 수 없습니다.', 'cloud-press-deploy'));
        }

        $tmp_file = download_url($tarball_url, 60);
        if (is_wp_error($tmp_file)) {
            return $tmp_file;
        }

        // WP_Filesystem을 통한 압축 해제 (WordPress 코어 헬퍼 사용)
        require_once ABSPATH . 'wp-admin/includes/file.php';
        WP_Filesystem();
        global $wp_filesystem;

        $unzip_result = self::extract_tarball($tmp_file, $release_dir);
        @unlink($tmp_file);

        if (is_wp_error($unzip_result)) {
            return $unzip_result;
        }

        return $release_dir;
    }

    private static function extract_tarball(string $tar_gz_path, string $destination)
    {
        // PharData는 PHP 코어 확장으로 tar.gz 압축 해제를 지원한다.
        try {
            $phar = new PharData($tar_gz_path);
            $phar->extractTo($destination, null, true);
            return true;
        } catch (Exception $e) {
            return new WP_Error('extract_failed', $e->getMessage());
        }
    }
}
