<?php
/**
 * 회원가입/로그인 처리.
 *
 * 설계 결정 (docs/11 2절): 순수 WordPress 기본 회원가입을 그대로 사용한다.
 * 커스텀 인증 로직(직접 비밀번호 해싱, 별도 세션 관리 등)을 만들지 않고
 * WordPress 코어 함수(register_new_user, wp_signon 등)에 위임하여
 * 보안 사고 표면을 최소화한다. 이 파일이 하는 일은 "프런트엔드에 어울리는
 * 폼을 제공하고 AJAX로 감싸는 것"뿐이다.
 */

if (!defined('ABSPATH')) {
    exit;
}

class CP_Auth
{
    public static function init(): void
    {
        add_shortcode('cp_register_form', [self::class, 'render_register_form']);
        add_shortcode('cp_login_form', [self::class, 'render_login_form']);

        // 비로그인 사용자도 호출 가능해야 하므로 nopriv 액션으로 등록
        add_action('wp_ajax_nopriv_cp_register', [self::class, 'handle_register']);
        add_action('wp_ajax_nopriv_cp_login', [self::class, 'handle_login']);
    }

    public static function render_register_form(): string
    {
        if (is_user_logged_in()) {
            return '<p>' . esc_html__('이미 로그인되어 있습니다.', 'cloud-press-connector') . '</p>';
        }

        ob_start();
        ?>
        <form id="cp-register-form" class="cp-auth-form">
            <?php wp_nonce_field('cp_register_nonce', 'cp_register_nonce_field'); ?>
            <div class="cp-field">
                <label for="cp-reg-username"><?php esc_html_e('아이디', 'cloud-press-connector'); ?></label>
                <input type="text" id="cp-reg-username" name="username" required maxlength="60" autocomplete="username">
            </div>
            <div class="cp-field">
                <label for="cp-reg-email"><?php esc_html_e('이메일', 'cloud-press-connector'); ?></label>
                <input type="email" id="cp-reg-email" name="email" required autocomplete="email">
            </div>
            <div class="cp-field">
                <label for="cp-reg-password"><?php esc_html_e('비밀번호', 'cloud-press-connector'); ?></label>
                <input type="password" id="cp-reg-password" name="password" required minlength="8" autocomplete="new-password">
            </div>
            <button type="submit"><?php esc_html_e('가입하기', 'cloud-press-connector'); ?></button>
            <p class="cp-form-message" role="alert" aria-live="polite"></p>
        </form>
        <?php
        return ob_get_clean();
    }

    public static function render_login_form(): string
    {
        if (is_user_logged_in()) {
            return '<p>' . esc_html__('이미 로그인되어 있습니다.', 'cloud-press-connector') . '</p>';
        }

        ob_start();
        ?>
        <form id="cp-login-form" class="cp-auth-form">
            <?php wp_nonce_field('cp_login_nonce', 'cp_login_nonce_field'); ?>
            <div class="cp-field">
                <label for="cp-login-username"><?php esc_html_e('아이디 또는 이메일', 'cloud-press-connector'); ?></label>
                <input type="text" id="cp-login-username" name="username" required autocomplete="username">
            </div>
            <div class="cp-field">
                <label for="cp-login-password"><?php esc_html_e('비밀번호', 'cloud-press-connector'); ?></label>
                <input type="password" id="cp-login-password" name="password" required autocomplete="current-password">
            </div>
            <button type="submit"><?php esc_html_e('로그인', 'cloud-press-connector'); ?></button>
            <p class="cp-form-message" role="alert" aria-live="polite"></p>
        </form>
        <?php
        return ob_get_clean();
    }

    public static function handle_register(): void
    {
        check_ajax_referer('cp_register_nonce', 'nonce');

        $username = isset($_POST['username']) ? sanitize_user(wp_unslash($_POST['username'])) : '';
        $email    = isset($_POST['email']) ? sanitize_email(wp_unslash($_POST['email'])) : '';
        $password = isset($_POST['password']) ? (string) $_POST['password'] : '';

        if (empty($username) || empty($email) || empty($password)) {
            wp_send_json_error(['message' => __('모든 항목을 입력해 주세요.', 'cloud-press-connector')], 400);
        }
        if (strlen($password) < 8) {
            wp_send_json_error(['message' => __('비밀번호는 8자 이상이어야 합니다.', 'cloud-press-connector')], 400);
        }
        if (username_exists($username)) {
            wp_send_json_error(['message' => __('이미 사용 중인 아이디입니다.', 'cloud-press-connector')], 409);
        }
        if (email_exists($email)) {
            wp_send_json_error(['message' => __('이미 사용 중인 이메일입니다.', 'cloud-press-connector')], 409);
        }

        // WordPress 코어 함수로 가입 처리 (비밀번호 해싱 등은 전부 코어에 위임)
        $user_id = wp_create_user($username, $password, $email);
        if (is_wp_error($user_id)) {
            wp_send_json_error(['message' => $user_id->get_error_message()], 400);
        }

        // 가입 직후 Worker API 키 발급 (docs/11 3절)
        do_action('cp_user_registered', $user_id);

        // 가입과 동시에 로그인 처리
        wp_set_current_user($user_id);
        wp_set_auth_cookie($user_id);

        wp_send_json_success(['message' => __('가입이 완료되었습니다.', 'cloud-press-connector')]);
    }

    public static function handle_login(): void
    {
        check_ajax_referer('cp_login_nonce', 'nonce');

        $username = isset($_POST['username']) ? sanitize_user(wp_unslash($_POST['username'])) : '';
        $password = isset($_POST['password']) ? (string) $_POST['password'] : '';

        if (empty($username) || empty($password)) {
            wp_send_json_error(['message' => __('아이디와 비밀번호를 입력해 주세요.', 'cloud-press-connector')], 400);
        }

        $user = wp_signon([
            'user_login'    => $username,
            'user_password' => $password,
            'remember'      => true,
        ], is_ssl());

        if (is_wp_error($user)) {
            // 아이디/비밀번호 오류를 구체적으로 알려주지 않아 계정 존재 여부 추측(user enumeration)을 방지
            wp_send_json_error(['message' => __('아이디 또는 비밀번호가 올바르지 않습니다.', 'cloud-press-connector')], 401);
        }

        wp_send_json_success(['message' => __('로그인되었습니다.', 'cloud-press-connector')]);
    }
}
