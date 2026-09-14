<?php
/**
 * 배포 요청의 다중 승인 워크플로 (docs/12 4절).
 *
 * 정책: 최소 CP_DEPLOY_MIN_APPROVALS(기본 2)인의 서로 다른 관리자 승인 필요.
 * 요청 등록자 본인은 승인자 수에 포함되지 않는다 (셀프 승인 금지).
 * 모든 승인/반려 행위는 타임스탬프와 함께 로그로 남는다 (감사 추적용).
 */

if (!defined('ABSPATH')) {
    exit;
}

class CP_Deploy_Approval
{
    const POST_TYPE = 'cp_deploy_request';

    public static function init(): void
    {
        self::register_post_type();

        add_action('admin_post_cp_deploy_request_new', [self::class, 'handle_new_request']);
        add_action('admin_post_cp_deploy_approve', [self::class, 'handle_approve']);
        add_action('admin_post_cp_deploy_reject', [self::class, 'handle_reject']);
        add_action('admin_post_cp_deploy_rollback', [self::class, 'handle_rollback']);
    }

    public static function register_post_type(): void
    {
        register_post_type(self::POST_TYPE, [
            'label'        => __('배포 요청', 'cloud-press-deploy'),
            'public'       => false,
            'show_ui'      => false, // 전용 관리자 화면(admin/deploy-review-page.php)에서만 노출
            'supports'     => ['title', 'author'],
            'capability_type' => 'page',
            'capabilities' => [
                // 배포 요청 생성/조회/승인은 전부 manage_options 권한(관리자)로 제한
                'create_posts' => 'manage_options',
                'edit_post'    => 'manage_options',
                'read_post'    => 'manage_options',
            ],
            'map_meta_cap' => true,
        ]);
    }

    /**
     * 관리자가 새 배포 요청을 등록. 이 시점에서는 아직 아무것도 실행 경로에 반영되지 않는다.
     * 스테이징 다운로드 + 정적 검사까지만 수행하고, 실제 반영은 승인 완료 후에만 이루어진다.
     */
    public static function handle_new_request(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die(__('권한이 없습니다.', 'cloud-press-deploy'), 403);
        }
        check_admin_referer('cp_deploy_new_request');

        $owner  = sanitize_text_field(wp_unslash($_POST['owner'] ?? ''));
        $repo   = sanitize_text_field(wp_unslash($_POST['repo'] ?? ''));
        $branch = sanitize_text_field(wp_unslash($_POST['branch'] ?? 'main'));

        if (!CP_Deploy_Whitelist::is_allowed($owner, $repo)) {
            self::redirect_with_notice('error', __('화이트리스트에 없는 저장소입니다.', 'cloud-press-deploy'));
        }

        $commit_info = CP_Deploy_Fetcher::get_latest_commit($owner, $repo, $branch);
        if (is_wp_error($commit_info)) {
            self::redirect_with_notice('error', $commit_info->get_error_message());
        }

        $staged_dir = CP_Deploy_Fetcher::download_to_staging($owner, $repo, $commit_info['sha']);
        if (is_wp_error($staged_dir)) {
            self::redirect_with_notice('error', $staged_dir->get_error_message());
        }

        $scan_result = CP_Deploy_Scanner::scan($staged_dir);

        $request_id = wp_insert_post([
            'post_type'   => self::POST_TYPE,
            'post_status' => 'publish', // 워크플로 상태는 post meta의 'cp_status'로 별도 관리
            'post_title'  => sprintf('%s/%s @ %s', $owner, $repo, substr($commit_info['sha'], 0, 7)),
            'post_author' => get_current_user_id(),
            'meta_input'  => [
                'cp_owner'       => $owner,
                'cp_repo'        => $repo,
                'cp_branch'      => $branch,
                'cp_sha'         => $commit_info['sha'],
                'cp_commit_msg'  => $commit_info['message'],
                'cp_staged_dir'  => $staged_dir,
                'cp_scan_result' => $scan_result,
                'cp_status'      => 'pending',
                'cp_approvals'   => [], // [{user_id, timestamp}, ...]
                'cp_audit_log'   => [[
                    'action'    => 'requested',
                    'user_id'   => get_current_user_id(),
                    'timestamp' => time(),
                ]],
            ],
        ]);

        self::notify_admins_new_request($request_id);
        self::redirect_with_notice('success', __('배포 요청이 등록되었습니다. 관리자 승인을 기다립니다.', 'cloud-press-deploy'));
    }

    public static function handle_approve(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die(__('권한이 없습니다.', 'cloud-press-deploy'), 403);
        }
        $request_id = absint($_GET['request_id'] ?? 0);
        check_admin_referer('cp_deploy_approve_' . $request_id);

        $result = self::approve($request_id, get_current_user_id());
        self::redirect_with_notice(
            $result['ok'] ? 'success' : 'error',
            $result['message']
        );
    }

    public static function handle_reject(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die(__('권한이 없습니다.', 'cloud-press-deploy'), 403);
        }
        $request_id = absint($_GET['request_id'] ?? 0);
        check_admin_referer('cp_deploy_reject_' . $request_id);

        update_post_meta($request_id, 'cp_status', 'rejected');
        self::append_audit_log($request_id, 'rejected', get_current_user_id());

        self::redirect_with_notice('success', __('배포 요청을 반려했습니다.', 'cloud-press-deploy'));
    }

    public static function handle_rollback(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die(__('권한이 없습니다.', 'cloud-press-deploy'), 403);
        }
        $target_dir = sanitize_text_field(wp_unslash($_GET['release_dir'] ?? ''));
        check_admin_referer('cp_deploy_rollback');

        // 롤백 대상 경로는 반드시 지정된 releases 디렉토리 하위여야 한다 (경로 조작 방지)
        $releases_root = realpath(CP_DEPLOY_RELEASES_DIR);
        $real_target   = realpath($target_dir);
        if (!$real_target || strpos($real_target, $releases_root) !== 0) {
            self::redirect_with_notice('error', __('유효하지 않은 롤백 대상입니다.', 'cloud-press-deploy'));
        }

        $result = CP_Deploy_Stager::rollback_to($real_target);
        self::redirect_with_notice(
            is_wp_error($result) ? 'error' : 'success',
            is_wp_error($result) ? $result->get_error_message() : __('롤백이 완료되었습니다.', 'cloud-press-deploy')
        );
    }

    /**
     * @return array{ok: bool, message: string}
     */
    public static function approve(int $request_id, int $approver_id): array
    {
        $post = get_post($request_id);
        if (!$post || $post->post_type !== self::POST_TYPE) {
            return ['ok' => false, 'message' => __('요청을 찾을 수 없습니다.', 'cloud-press-deploy')];
        }
        if (get_post_meta($request_id, 'cp_status', true) !== 'pending') {
            return ['ok' => false, 'message' => __('이미 처리된 요청입니다.', 'cloud-press-deploy')];
        }

        // 셀프 승인 금지 (docs/12 4절)
        if ((int) $post->post_author === $approver_id) {
            return ['ok' => false, 'message' => __('본인이 등록한 요청은 스스로 승인할 수 없습니다.', 'cloud-press-deploy')];
        }

        $approvals = get_post_meta($request_id, 'cp_approvals', true) ?: [];

        // 중복 승인 방지
        foreach ($approvals as $a) {
            if ((int) $a['user_id'] === $approver_id) {
                return ['ok' => false, 'message' => __('이미 승인하셨습니다.', 'cloud-press-deploy')];
            }
        }

        $approvals[] = ['user_id' => $approver_id, 'timestamp' => time()];
        update_post_meta($request_id, 'cp_approvals', $approvals);
        self::append_audit_log($request_id, 'approved', $approver_id);

        if (count($approvals) >= CP_DEPLOY_MIN_APPROVALS) {
            return self::execute_deploy($request_id);
        }

        $remaining = CP_DEPLOY_MIN_APPROVALS - count($approvals);
        return [
            'ok'      => true,
            'message' => sprintf(
                /* translators: %d: 남은 승인 필요 인원 수 */
                __('승인했습니다. %d명의 추가 승인이 더 필요합니다.', 'cloud-press-deploy'),
                $remaining
            ),
        ];
    }

    /**
     * @return array{ok: bool, message: string}
     */
    private static function execute_deploy(int $request_id): array
    {
        $staged_dir = get_post_meta($request_id, 'cp_staged_dir', true);

        $result = CP_Deploy_Stager::swap_to_live($staged_dir);

        if (is_wp_error($result)) {
            update_post_meta($request_id, 'cp_status', 'failed');
            self::append_audit_log($request_id, 'deploy_failed', get_current_user_id(), $result->get_error_message());
            return ['ok' => false, 'message' => $result->get_error_message()];
        }

        update_post_meta($request_id, 'cp_status', 'deployed');
        update_post_meta($request_id, 'cp_deployed_at', time());
        self::append_audit_log($request_id, 'deployed', get_current_user_id());

        // cloud-press-connector가 업데이트 노트를 자동 생성하도록 훅 발생 (docs/11 5.1절)
        $repo = get_post_meta($request_id, 'cp_repo', true);
        $sha  = get_post_meta($request_id, 'cp_sha', true);
        do_action('cp_model_deployed', $repo, substr($sha, 0, 7));

        return ['ok' => true, 'message' => __('필요한 승인이 모두 완료되어 배포되었습니다.', 'cloud-press-deploy')];
    }

    private static function append_audit_log(int $request_id, string $action, int $user_id, string $detail = ''): void
    {
        $log = get_post_meta($request_id, 'cp_audit_log', true) ?: [];
        $log[] = [
            'action'    => $action,
            'user_id'   => $user_id,
            'timestamp' => time(),
            'detail'    => $detail,
        ];
        update_post_meta($request_id, 'cp_audit_log', $log);
    }

    private static function notify_admins_new_request(int $request_id): void
    {
        $admins = get_users(['role' => 'administrator']);
        $subject = __('[Cloud Press] 새 배포 요청이 승인을 기다리고 있습니다', 'cloud-press-deploy');
        $link = admin_url('admin.php?page=cloud-press-deploy');

        foreach ($admins as $admin) {
            wp_mail($admin->user_email, $subject, sprintf(
                __("새 배포 요청이 등록되었습니다.\n\n검토 및 승인: %s", 'cloud-press-deploy'),
                $link
            ));
        }
    }

    private static function redirect_with_notice(string $type, string $message): void
    {
        $url = add_query_arg(
            ['page' => 'cloud-press-deploy', 'cp_notice' => $type, 'cp_message' => rawurlencode($message)],
            admin_url('admin.php')
        );
        wp_safe_redirect($url);
        exit;
    }
}
