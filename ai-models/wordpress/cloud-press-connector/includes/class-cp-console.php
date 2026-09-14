<?php
/**
 * 마이페이지 콘솔: 로그인 사용자가 Flash Texter / Nano-Tech Artist를 실제로
 * 사용해보는 화면의 서버사이드 처리.
 *
 * 서버사이드 프록시 방식 (docs/11 4절): 브라우저는 이 플러그인의 AJAX
 * 엔드포인트만 호출하고, 실제 Worker API 키를 이용한 호출은 PHP가 대신 수행한다.
 */

if (!defined('ABSPATH')) {
    exit;
}

class CP_Console
{
    public static function init(): void
    {
        add_shortcode('cp_mypage_console', [self::class, 'render_console']);

        // 로그인 사용자 전용이므로 wp_ajax_nopriv_* 는 등록하지 않는다
        add_action('wp_ajax_cp_generate_text', [self::class, 'handle_generate_text']);
        add_action('wp_ajax_cp_generate_image', [self::class, 'handle_generate_image']);
    }

    public static function render_console(): string
    {
        if (!is_user_logged_in()) {
            return '<p>' . esc_html__('로그인 후 이용할 수 있습니다.', 'cloud-press-connector') . '</p>';
        }

        ob_start();
        ?>
        <div class="cp-console" id="cp-text-console">
            <h3><?php esc_html_e('Flash Texter', 'cloud-press-connector'); ?></h3>
            <form id="cp-text-form">
                <?php wp_nonce_field('cp_console_nonce', 'cp_console_nonce_field'); ?>
                <input type="text" name="prompt" maxlength="200" placeholder="<?php esc_attr_e('예: 안녕하세요', 'cloud-press-connector'); ?>" required>
                <button type="submit"><?php esc_html_e('보내기', 'cloud-press-connector'); ?></button>
            </form>
            <div class="cp-console-output" id="cp-text-output" aria-live="polite"></div>
        </div>

        <div class="cp-console" id="cp-image-console">
            <h3><?php esc_html_e('Nano-Tech Artist', 'cloud-press-connector'); ?></h3>
            <form id="cp-image-form">
                <?php wp_nonce_field('cp_console_nonce', 'cp_console_nonce_field'); ?>
                <select name="color">
                    <option value="red"><?php esc_html_e('빨강', 'cloud-press-connector'); ?></option>
                    <option value="blue"><?php esc_html_e('파랑', 'cloud-press-connector'); ?></option>
                    <option value="green"><?php esc_html_e('초록', 'cloud-press-connector'); ?></option>
                    <option value="yellow"><?php esc_html_e('노랑', 'cloud-press-connector'); ?></option>
                    <option value="purple"><?php esc_html_e('보라', 'cloud-press-connector'); ?></option>
                    <option value="black"><?php esc_html_e('검정', 'cloud-press-connector'); ?></option>
                </select>
                <select name="shape">
                    <option value="circle"><?php esc_html_e('원', 'cloud-press-connector'); ?></option>
                    <option value="square"><?php esc_html_e('사각형', 'cloud-press-connector'); ?></option>
                    <option value="triangle"><?php esc_html_e('삼각형', 'cloud-press-connector'); ?></option>
                </select>
                <button type="submit"><?php esc_html_e('생성하기', 'cloud-press-connector'); ?></button>
            </form>
            <div class="cp-console-output" id="cp-image-output" aria-live="polite"></div>
        </div>
        <?php
        return ob_get_clean();
    }

    private static function get_current_user_key_or_fail(): string
    {
        if (!is_user_logged_in()) {
            wp_send_json_error(['message' => __('로그인이 필요합니다.', 'cloud-press-connector')], 401);
        }

        $api_key = CP_API_Key_Issuer::get_key_for_user(get_current_user_id());
        if (!$api_key) {
            wp_send_json_error(['message' => __('계정에 연결된 API 키가 없습니다. 관리자에게 문의해 주세요.', 'cloud-press-connector')], 500);
        }

        return $api_key;
    }

    public static function handle_generate_text(): void
    {
        check_ajax_referer('cp_console_nonce', 'nonce');
        $api_key = self::get_current_user_key_or_fail();

        $prompt = isset($_POST['prompt']) ? sanitize_text_field(wp_unslash($_POST['prompt'])) : '';
        if (empty($prompt)) {
            wp_send_json_error(['message' => __('메시지를 입력해 주세요.', 'cloud-press-connector')], 400);
        }

        $response = wp_remote_post(rtrim(CP_WORKER_PUBLIC_URL, '/') . '/v1/text/generate', [
            'headers' => [
                'Content-Type'  => 'application/json',
                'Authorization' => 'Bearer ' . $api_key,
            ],
            'body'    => wp_json_encode(['prompt' => $prompt, 'max_tokens' => 128]),
            'timeout' => 15,
        ]);

        self::relay_worker_response($response);
    }

    public static function handle_generate_image(): void
    {
        check_ajax_referer('cp_console_nonce', 'nonce');
        $api_key = self::get_current_user_key_or_fail();

        $color = isset($_POST['color']) ? sanitize_text_field(wp_unslash($_POST['color'])) : '';
        $shape = isset($_POST['shape']) ? sanitize_text_field(wp_unslash($_POST['shape'])) : '';

        $response = wp_remote_post(rtrim(CP_WORKER_PUBLIC_URL, '/') . '/v1/image/generate', [
            'headers' => [
                'Content-Type'  => 'application/json',
                'Authorization' => 'Bearer ' . $api_key,
            ],
            'body'    => wp_json_encode(['prompt_type' => 'condition', 'color' => $color, 'shape' => $shape]),
            'timeout' => 20,
        ]);

        self::relay_worker_response($response);
    }

    /**
     * Worker 응답을 그대로 전달하되, 장애 시 사용자 친화적 메시지로 변환한다
     * (docs/13-resilience-and-failover.md 2.1절 — Worker/추론서버 장애가 사이트
     * 전체를 죽이지 않고, 이 콘솔 부분만 "점검 중" 메시지를 보여주도록 격리).
     */
    private static function relay_worker_response($response): void
    {
        if (is_wp_error($response)) {
            wp_send_json_error(['message' => __('지금 모델 서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.', 'cloud-press-connector')], 503);
        }

        $status = wp_remote_retrieve_response_code($response);
        $body   = json_decode(wp_remote_retrieve_body($response), true);

        if ($status >= 500 || $status === 0) {
            wp_send_json_error(['message' => __('지금 모델 서버가 점검 중이에요. 잠시 후 다시 시도해 주세요.', 'cloud-press-connector')], 503);
        }

        if ($status === 429) {
            wp_send_json_error(['message' => __('요청이 너무 많아요. 잠시 후 다시 시도해 주세요.', 'cloud-press-connector')], 429);
        }

        if ($status >= 400) {
            wp_send_json_error(['message' => $body['error'] ?? __('요청을 처리할 수 없어요.', 'cloud-press-connector')], $status);
        }

        wp_send_json_success($body);
    }
}
