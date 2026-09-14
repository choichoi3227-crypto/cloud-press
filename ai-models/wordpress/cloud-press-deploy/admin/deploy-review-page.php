<?php
/**
 * 관리자 화면: 배포 요청 등록 + 대기 중인 요청 승인/반려.
 * manage_options 권한(관리자)만 접근 가능 (cloud-press-deploy.php의 add_menu_page에서 제한).
 */

if (!defined('ABSPATH')) {
    exit;
}

function cp_deploy_render_review_page(): void
{
    if (!current_user_can('manage_options')) {
        wp_die(__('권한이 없습니다.', 'cloud-press-deploy'));
    }

    $notice_type = isset($_GET['cp_notice']) ? sanitize_text_field($_GET['cp_notice']) : '';
    $notice_msg  = isset($_GET['cp_message']) ? sanitize_text_field(rawurldecode($_GET['cp_message'])) : '';

    $pending_requests = get_posts([
        'post_type'      => 'cp_deploy_request',
        'posts_per_page' => 20,
        'meta_key'       => 'cp_status',
        'meta_value'     => 'pending',
    ]);

    $recent_deployed = get_posts([
        'post_type'      => 'cp_deploy_request',
        'posts_per_page' => 10,
        'meta_key'       => 'cp_status',
        'meta_value'     => 'deployed',
        'orderby'        => 'meta_value_num',
        'meta_query'     => [['key' => 'cp_deployed_at']],
    ]);

    ?>
    <div class="wrap">
        <h1><?php esc_html_e('Cloud Press 배포 관리', 'cloud-press-deploy'); ?></h1>

        <?php if ($notice_msg): ?>
            <div class="notice notice-<?php echo $notice_type === 'error' ? 'error' : 'success'; ?> is-dismissible">
                <p><?php echo esc_html($notice_msg); ?></p>
            </div>
        <?php endif; ?>

        <h2><?php esc_html_e('새 배포 요청 등록', 'cloud-press-deploy'); ?></h2>
        <p class="description">
            <?php esc_html_e('등록 즉시 반영되지 않습니다. 화이트리스트 검사와 정적 스캔을 거쳐 스테이징에만 저장되며, 관리자 최소 2명의 승인 후에만 실제 서비스에 반영됩니다.', 'cloud-press-deploy'); ?>
        </p>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
            <input type="hidden" name="action" value="cp_deploy_request_new">
            <?php wp_nonce_field('cp_deploy_new_request'); ?>
            <table class="form-table">
                <tr>
                    <th><label for="cp-owner"><?php esc_html_e('저장소 소유자 (owner)', 'cloud-press-deploy'); ?></label></th>
                    <td><input type="text" id="cp-owner" name="owner" class="regular-text" required placeholder="choichoi3227-crypto"></td>
                </tr>
                <tr>
                    <th><label for="cp-repo"><?php esc_html_e('저장소 이름 (repo)', 'cloud-press-deploy'); ?></label></th>
                    <td><input type="text" id="cp-repo" name="repo" class="regular-text" required placeholder="cloud-press"></td>
                </tr>
                <tr>
                    <th><label for="cp-branch"><?php esc_html_e('브랜치', 'cloud-press-deploy'); ?></label></th>
                    <td>
                        <input type="text" id="cp-branch" name="branch" class="regular-text" value="main" required>
                        <p class="description"><?php esc_html_e('main 또는 release/* 형식만 허용됩니다.', 'cloud-press-deploy'); ?></p>
                    </td>
                </tr>
            </table>
            <p class="description">
                <?php
                $whitelist = CP_Deploy_Whitelist::get_list();
                printf(
                    esc_html__('현재 화이트리스트: %s', 'cloud-press-deploy'),
                    esc_html(implode(', ', $whitelist))
                );
                ?>
            </p>
            <?php submit_button(__('배포 요청 등록 (스테이징만 진행)', 'cloud-press-deploy')); ?>
        </form>

        <hr>

        <h2><?php esc_html_e('승인 대기 중인 요청', 'cloud-press-deploy'); ?></h2>
        <?php if (empty($pending_requests)): ?>
            <p><?php esc_html_e('대기 중인 요청이 없습니다.', 'cloud-press-deploy'); ?></p>
        <?php else: ?>
            <table class="widefat">
                <thead>
                    <tr>
                        <th><?php esc_html_e('저장소', 'cloud-press-deploy'); ?></th>
                        <th><?php esc_html_e('커밋', 'cloud-press-deploy'); ?></th>
                        <th><?php esc_html_e('요청자', 'cloud-press-deploy'); ?></th>
                        <th><?php esc_html_e('스캔 경고', 'cloud-press-deploy'); ?></th>
                        <th><?php esc_html_e('승인 현황', 'cloud-press-deploy'); ?></th>
                        <th><?php esc_html_e('작업', 'cloud-press-deploy'); ?></th>
                    </tr>
                </thead>
                <tbody>
                <?php foreach ($pending_requests as $req):
                    $owner = get_post_meta($req->ID, 'cp_owner', true);
                    $repo = get_post_meta($req->ID, 'cp_repo', true);
                    $sha = get_post_meta($req->ID, 'cp_sha', true);
                    $msg = get_post_meta($req->ID, 'cp_commit_msg', true);
                    $scan = get_post_meta($req->ID, 'cp_scan_result', true) ?: ['warnings' => []];
                    $approvals = get_post_meta($req->ID, 'cp_approvals', true) ?: [];
                    $requester = get_userdata($req->post_author);
                    $current_user_id = get_current_user_id();
                    $already_approved = false;
                    foreach ($approvals as $a) {
                        if ((int) $a['user_id'] === $current_user_id) $already_approved = true;
                    }
                    $is_requester = (int) $req->post_author === $current_user_id;
                ?>
                    <tr>
                        <td><?php echo esc_html("{$owner}/{$repo}"); ?></td>
                        <td>
                            <code><?php echo esc_html(substr($sha, 0, 7)); ?></code><br>
                            <?php echo esc_html($msg); ?>
                        </td>
                        <td><?php echo esc_html($requester ? $requester->display_name : '—'); ?></td>
                        <td>
                            <?php if (empty($scan['warnings'])): ?>
                                <span style="color:green;">✓ <?php esc_html_e('경고 없음', 'cloud-press-deploy'); ?></span>
                            <?php else: ?>
                                <span style="color:#b32d2e;">⚠ <?php echo count($scan['warnings']); ?><?php esc_html_e('건 경고', 'cloud-press-deploy'); ?></span>
                                <ul>
                                    <?php foreach ($scan['warnings'] as $w): ?>
                                        <li><?php echo esc_html($w); ?></li>
                                    <?php endforeach; ?>
                                </ul>
                            <?php endif; ?>
                        </td>
                        <td><?php printf('%d / %d', count($approvals), CP_DEPLOY_MIN_APPROVALS); ?></td>
                        <td>
                            <?php if ($is_requester): ?>
                                <em><?php esc_html_e('본인 요청 (승인 불가)', 'cloud-press-deploy'); ?></em>
                            <?php elseif ($already_approved): ?>
                                <em><?php esc_html_e('승인 완료', 'cloud-press-deploy'); ?></em>
                            <?php else: ?>
                                <a class="button button-primary" href="<?php
                                    echo esc_url(wp_nonce_url(
                                        admin_url('admin-post.php?action=cp_deploy_approve&request_id=' . $req->ID),
                                        'cp_deploy_approve_' . $req->ID
                                    ));
                                ?>"><?php esc_html_e('승인', 'cloud-press-deploy'); ?></a>
                            <?php endif; ?>
                            <a class="button" href="<?php
                                echo esc_url(wp_nonce_url(
                                    admin_url('admin-post.php?action=cp_deploy_reject&request_id=' . $req->ID),
                                    'cp_deploy_reject_' . $req->ID
                                ));
                            ?>" onclick="return confirm('<?php esc_attr_e('정말 반려하시겠습니까?', 'cloud-press-deploy'); ?>');">
                                <?php esc_html_e('반려', 'cloud-press-deploy'); ?>
                            </a>
                        </td>
                    </tr>
                <?php endforeach; ?>
                </tbody>
            </table>
        <?php endif; ?>

        <hr>

        <h2><?php esc_html_e('최근 배포 이력 (롤백 가능)', 'cloud-press-deploy'); ?></h2>
        <?php if (empty($recent_deployed)): ?>
            <p><?php esc_html_e('배포 이력이 없습니다.', 'cloud-press-deploy'); ?></p>
        <?php else: ?>
            <table class="widefat">
                <thead>
                    <tr>
                        <th><?php esc_html_e('저장소', 'cloud-press-deploy'); ?></th>
                        <th><?php esc_html_e('커밋', 'cloud-press-deploy'); ?></th>
                        <th><?php esc_html_e('배포 시각', 'cloud-press-deploy'); ?></th>
                        <th><?php esc_html_e('작업', 'cloud-press-deploy'); ?></th>
                    </tr>
                </thead>
                <tbody>
                <?php foreach ($recent_deployed as $req):
                    $owner = get_post_meta($req->ID, 'cp_owner', true);
                    $repo = get_post_meta($req->ID, 'cp_repo', true);
                    $sha = get_post_meta($req->ID, 'cp_sha', true);
                    $staged_dir = get_post_meta($req->ID, 'cp_staged_dir', true);
                    $deployed_at = get_post_meta($req->ID, 'cp_deployed_at', true);
                ?>
                    <tr>
                        <td><?php echo esc_html("{$owner}/{$repo}"); ?></td>
                        <td><code><?php echo esc_html(substr($sha, 0, 7)); ?></code></td>
                        <td><?php echo esc_html(wp_date('Y-m-d H:i', $deployed_at)); ?></td>
                        <td>
                            <a class="button" href="<?php
                                echo esc_url(wp_nonce_url(
                                    admin_url('admin-post.php?action=cp_deploy_rollback&release_dir=' . rawurlencode($staged_dir)),
                                    'cp_deploy_rollback'
                                ));
                            ?>" onclick="return confirm('<?php esc_attr_e('이 버전으로 되돌리시겠습니까?', 'cloud-press-deploy'); ?>');">
                                <?php esc_html_e('이 버전으로 롤백', 'cloud-press-deploy'); ?>
                            </a>
                        </td>
                    </tr>
                <?php endforeach; ?>
                </tbody>
            </table>
        <?php endif; ?>
    </div>
    <?php
}
