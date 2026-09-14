<?php
/**
 * 스테이징된 코드에 대한 정적 검사 (docs/12 7절).
 *
 * 중요: 이 검사를 통과했다고 안전이 보장되는 것이 아니다. 어디까지나 승인자가
 * 검토할 때 참고할 "경고 표시"를 만드는 용도이며, 승인 자체를 자동으로
 * 막거나 자동으로 통과시키지 않는다 — 최종 판단은 항상 사람(관리자)이 한다.
 */

if (!defined('ABSPATH')) {
    exit;
}

class CP_Deploy_Scanner
{
    const SUSPICIOUS_PATTERNS = [
        '/eval\s*\(/i',
        '/base64_decode\s*\(.*eval/i',
        '/system\s*\(/i',
        '/shell_exec\s*\(/i',
        '/passthru\s*\(/i',
    ];

    const MAX_TOTAL_SIZE_BYTES = 50 * 1024 * 1024; // 50MB — 테마/플러그인 규모 기준 임계값

    /**
     * @return array{warnings: string[], total_size: int, file_count: int}
     */
    public static function scan(string $directory): array
    {
        $warnings = [];
        $total_size = 0;
        $file_count = 0;

        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($directory, RecursiveDirectoryIterator::SKIP_DOTS)
        );

        foreach ($iterator as $file) {
            if (!$file->isFile()) {
                continue;
            }
            $file_count++;
            $total_size += $file->getSize();

            $ext = strtolower($file->getExtension());
            if (in_array($ext, ['exe', 'sh', 'bat', 'dll'], true)) {
                $warnings[] = sprintf(
                    __('예상 밖의 실행 파일 발견: %s', 'cloud-press-deploy'),
                    $file->getPathname()
                );
            }

            if (in_array($ext, ['php', 'js'], true) && $file->getSize() < 2 * 1024 * 1024) {
                $content = file_get_contents($file->getPathname());
                foreach (self::SUSPICIOUS_PATTERNS as $pattern) {
                    if (preg_match($pattern, $content)) {
                        $warnings[] = sprintf(
                            __('의심스러운 패턴 발견 (%s): %s', 'cloud-press-deploy'),
                            $pattern,
                            $file->getPathname()
                        );
                    }
                }
            }
        }

        if ($total_size > self::MAX_TOTAL_SIZE_BYTES) {
            $warnings[] = sprintf(
                __('총 용량이 비정상적으로 큽니다: %s MB', 'cloud-press-deploy'),
                round($total_size / 1024 / 1024, 1)
            );
        }

        return [
            'warnings'   => $warnings,
            'total_size' => $total_size,
            'file_count' => $file_count,
        ];
    }
}
