<?php
/**
 * GitHub 저장소 화이트리스트 관리 (docs/12 3절).
 *
 * 중요: 화이트리스트 자체를 추가/수정하는 것도 관리자 다중 승인 대상이다.
 * 그렇지 않으면 화이트리스트를 몰래 바꿔서 안전장치를 우회할 수 있기 때문이다.
 * 이 클래스는 화이트리스트를 "직접" 수정하는 함수를 외부에 노출하지 않고,
 * 반드시 CP_Deploy_Approval의 승인 워크플로를 거친 변경만 반영한다.
 */

if (!defined('ABSPATH')) {
    exit;
}

class CP_Deploy_Whitelist
{
    const OPTION_KEY = 'cp_deploy_whitelist';
    const ALLOWED_BRANCH_PATTERN = '/^(main|release\/[\w.\-]+)$/';

    public static function init(): void
    {
        // 화이트리스트 옵션이 없으면 기본값(현재 프로젝트 저장소)으로 초기화
        if (get_option(self::OPTION_KEY, null) === null) {
            update_option(self::OPTION_KEY, ['choichoi3227-crypto/cloud-press']);
        }
    }

    public static function get_list(): array
    {
        return get_option(self::OPTION_KEY, []);
    }

    public static function is_allowed(string $owner, string $repo): bool
    {
        return in_array("{$owner}/{$repo}", self::get_list(), true);
    }

    public static function is_branch_allowed(string $branch): bool
    {
        return (bool) preg_match(self::ALLOWED_BRANCH_PATTERN, $branch);
    }

    /**
     * 화이트리스트 변경은 오직 승인 완료된 요청을 통해서만 반영된다.
     * CP_Deploy_Approval::execute_whitelist_change() 에서만 호출되어야 하며,
     * 관리자 화면에서 직접 호출할 수 있는 공개 액션은 만들지 않는다.
     */
    public static function apply_approved_change(array $new_list): void
    {
        $sanitized = array_values(array_filter(array_map(function ($entry) {
            $entry = trim($entry);
            return preg_match('#^[\w.\-]+/[\w.\-]+$#', $entry) ? $entry : null;
        }, $new_list)));

        update_option(self::OPTION_KEY, $sanitized);
    }
}
