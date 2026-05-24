<?php
/**
 * CloudPress DB Drop-in
 * WordPress → Cloudflare D1 (SQLite) 브릿지
 *
 * 이 파일은 WordPress의 wpdb 클래스를 교체하여
 * MySQL 대신 Cloudflare D1 (SQLite)를 사용합니다.
 *
 * 설치: wp-content/db.php (WordPress가 자동으로 로드)
 */

if (!defined('ABSPATH')) {
    exit('Direct access not allowed.');
}

/**
 * MySQL → SQLite 쿼리 변환기
 */
class CloudPress_SQL_Translator {

    /**
     * MySQL 쿼리를 SQLite 호환으로 변환
     */
    public static function translate(string $query): string {
        $q = trim($query);

        // SHOW 쿼리 처리
        if (stripos($q, 'SHOW TABLES') !== false) {
            global $wpdb;
            $prefix = $wpdb ? $wpdb->prefix : 'wp_';
            return "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '{$prefix}%' ORDER BY name";
        }

        if (preg_match('/SHOW\s+COLUMNS\s+FROM\s+`?(\w+)`?/i', $q, $m)) {
            return "PRAGMA table_info({$m[1]})";
        }

        if (preg_match('/SHOW\s+CREATE\s+TABLE\s+`?(\w+)`?/i', $q, $m)) {
            return "SELECT sql FROM sqlite_master WHERE type='table' AND name='{$m[1]}'";
        }

        if (preg_match('/SHOW\s+INDEX\s+FROM\s+`?(\w+)`?/i', $q, $m)) {
            return "PRAGMA index_list({$m[1]})";
        }

        if (stripos($q, 'SHOW VARIABLES') !== false) {
            return "SELECT 'character_set_client' AS Variable_name, 'utf8mb4' AS Value";
        }

        if (stripos($q, 'SHOW STATUS') !== false) {
            return "SELECT '' AS Variable_name, '' AS Value WHERE 0";
        }

        // SET 명령 무시
        if (preg_match('/^\s*SET\s+/i', $q)) {
            return "SELECT 1";
        }

        // MySQL 함수 및 타입 변환
        $q = self::convertTypes($q);
        $q = self::convertFunctions($q);
        $q = self::convertSyntax($q);

        return $q;
    }

    private static function convertTypes(string $q): string {
        // 정수 타입
        $q = preg_replace('/\b(TINY|SMALL|MEDIUM|BIG)?INT\(\d+\)\s+UNSIGNED/i', 'INTEGER', $q);
        $q = preg_replace('/\b(TINY|SMALL|MEDIUM|BIG)?INT\(\d+\)/i', 'INTEGER', $q);
        $q = preg_replace('/\bINTEGER\s+UNSIGNED/i', 'INTEGER', $q);
        $q = preg_replace('/\b(TINY|SMALL|MEDIUM|BIG)INT\b/i', 'INTEGER', $q);

        // 실수 타입
        $q = preg_replace('/\b(DOUBLE|FLOAT|DECIMAL)\s*(\(\d+,\d+\))?/i', 'REAL', $q);

        // 문자열 타입
        $q = preg_replace('/\bVARCHAR\(\d+\)/i', 'TEXT', $q);
        $q = preg_replace('/\bCHAR\(\d+\)/i', 'TEXT', $q);
        $q = preg_replace('/\b(LONG|MEDIUM|TINY)?TEXT\b/i', 'TEXT', $q);
        $q = preg_replace('/\bBLOB\b/i', 'BLOB', $q);
        $q = preg_replace('/\b(LONG|MEDIUM|TINY)?BLOB\b/i', 'BLOB', $q);

        // 날짜 타입
        $q = preg_replace('/\b(DATETIME|TIMESTAMP|DATE|TIME)\b/i', 'TEXT', $q);

        // 테이블 옵션 제거
        $q = preg_replace('/\s+ENGINE\s*=\s*\w+/i', '', $q);
        $q = preg_replace('/\s+DEFAULT\s+CHARSET\s*=\s*\w+/i', '', $q);
        $q = preg_replace('/\s+COLLATE\s*=\s*[\w_]+/i', '', $q);
        $q = preg_replace('/\s+ROW_FORMAT\s*=\s*\w+/i', '', $q);
        $q = preg_replace('/\s+AUTO_INCREMENT\s*=\s*\d+/i', '', $q);
        $q = preg_replace('/\s+COMMENT\s*=\s*\'[^\']*\'/i', '', $q);

        // 컬럼 속성
        $q = str_replace(' UNSIGNED', '', $q);
        $q = preg_replace('/\s+COLLATE\s+[\w_]+/i', '', $q);
        $q = preg_replace('/\s+CHARACTER\s+SET\s+\w+/i', '', $q);

        // AUTO_INCREMENT → AUTOINCREMENT
        $q = preg_replace('/\bAUTO_INCREMENT\b/i', 'AUTOINCREMENT', $q);

        return $q;
    }

    private static function convertFunctions(string $q): string {
        // NOW() → datetime('now')
        $q = preg_replace('/\bNOW\(\)/i', "datetime('now')", $q);

        // UNIX_TIMESTAMP() → unixepoch()
        $q = preg_replace('/\bUNIX_TIMESTAMP\(\)/i', "unixepoch('now')", $q);
        $q = preg_replace('/\bUNIX_TIMESTAMP\(([^)]+)\)/i', "unixepoch($1)", $q);

        // FROM_UNIXTIME
        $q = preg_replace('/\bFROM_UNIXTIME\(([^)]+)\)/i', "datetime($1, 'unixepoch')", $q);

        // DATE_FORMAT
        $q = preg_replace('/\bDATE_FORMAT\(([^,]+),\s*\'%Y-%m-%d\'\)/i', "strftime('%Y-%m-%d', $1)", $q);
        $q = preg_replace('/\bDATE_FORMAT\(([^,]+),\s*\'([^\']+)\'\)/i', "strftime('$2', $1)", $q);

        // GROUP_CONCAT
        $q = preg_replace('/\bGROUP_CONCAT\(([^)]+)\s+SEPARATOR\s+\'([^\']*)\'\)/i', "group_concat($1, '$2')", $q);

        // IFNULL → COALESCE
        $q = preg_replace('/\bIFNULL\(/i', 'COALESCE(', $q);

        // IF(cond, true, false) → CASE WHEN ... END
        // 단순 케이스만 처리
        $q = preg_replace_callback('/\bIF\s*\((.+?),\s*(.+?),\s*(.+?)\)/i', function($m) {
            return "CASE WHEN {$m[1]} THEN {$m[2]} ELSE {$m[3]} END";
        }, $q);

        // ISNULL → IS NULL
        $q = preg_replace('/\bISNULL\(([^)]+)\)/i', '($1 IS NULL)', $q);

        // CONVERT(x, type)
        $q = preg_replace('/\bCONVERT\(([^,]+),\s*\w+\)/i', 'CAST($1 AS TEXT)', $q);

        // CAST(x AS SIGNED) → CAST(x AS INTEGER)
        $q = preg_replace('/\bCAST\(([^)]+)\s+AS\s+SIGNED\s*(INT(?:EGER)?)?\)/i', 'CAST($1 AS INTEGER)', $q);

        // SUBSTRING → substr
        $q = preg_replace('/\bSUBSTRING\(/i', 'substr(', $q);
        $q = preg_replace('/\bSUBSTR\(/i', 'substr(', $q);

        // LOCATE → instr (args reversed)
        // MySQL: LOCATE(substr, str) → SQLite: instr(str, substr)
        // 간단한 케이스만 처리
        $q = preg_replace('/\bLOCATE\(([^,]+),\s*([^)]+)\)/i', 'instr($2, $1)', $q);

        // LOWER/UPPER 유지 (SQLite 지원)
        // LENGTH 유지

        // RAND() → random()
        $q = preg_replace('/\bRAND\(\)/i', 'random()', $q);

        return $q;
    }

    private static function convertSyntax(string $q): string {
        // INSERT IGNORE → INSERT OR IGNORE
        $q = preg_replace('/\bINSERT\s+IGNORE\b/i', 'INSERT OR IGNORE', $q);

        // REPLACE INTO 유지 (SQLite 지원)

        // ON DUPLICATE KEY UPDATE → INSERT OR REPLACE (단순 케이스)
        if (preg_match('/ON DUPLICATE KEY UPDATE/i', $q)) {
            $q = preg_replace('/\bINSERT\s+(INTO\s+)?/i', 'INSERT OR REPLACE $1', $q);
            $q = preg_replace('/\s*ON DUPLICATE KEY UPDATE.+$/is', '', $q);
        }

        // LIMIT x,y → LIMIT y OFFSET x
        $q = preg_replace('/\bLIMIT\s+(\d+)\s*,\s*(\d+)\b/i', 'LIMIT $2 OFFSET $1', $q);

        // FOR UPDATE 제거 (트랜잭션 힌트)
        $q = preg_replace('/\s+FOR\s+UPDATE\b/i', '', $q);

        // LOCK IN SHARE MODE 제거
        $q = preg_replace('/\s+LOCK\s+IN\s+SHARE\s+MODE\b/i', '', $q);

        // STRAIGHT_JOIN → JOIN
        $q = str_ireplace('STRAIGHT_JOIN', 'JOIN', $q);

        // SQL_CALC_FOUND_ROWS 제거
        $q = preg_replace('/\bSQL_CALC_FOUND_ROWS\b/i', '', $q);

        // FOUND_ROWS() → changes() (근사값)
        $q = preg_replace('/\bFOUND_ROWS\(\)/i', '(SELECT count(*) FROM sqlite_master)', $q);

        // USE INDEX, FORCE INDEX 제거
        $q = preg_replace('/\s+(USE|FORCE|IGNORE)\s+INDEX\s*\([^)]*\)/i', '', $q);

        // FULLTEXT 인덱스 → 일반 인덱스 (MySQL 전용)
        $q = preg_replace('/\bFULLTEXT\s+(INDEX|KEY)\b/i', 'INDEX', $q);

        // KEY 키워드를 INDEX로 (CREATE TABLE 안에서)
        // 단독 KEY xxx (col) → INDEX xxx (col)
        // PRIMARY KEY는 유지
        $q = preg_replace('/(?<!PRIMARY\s)(?<!UNIQUE\s)\bKEY\b\s+`?(\w+)`?\s*\(/i', 'INDEX `$1` (', $q);

        // UNIQUE KEY → UNIQUE INDEX
        $q = preg_replace('/\bUNIQUE\s+KEY\b/i', 'UNIQUE INDEX', $q);

        // 역따옴표(백틱)를 큰따옴표로 (SQLite 표준)
        // SQLite도 백틱을 지원하므로 그대로 유지

        return $q;
    }
}

/**
 * CloudPress wpdb - WordPress DB 클래스 교체
 * Cloudflare D1 HTTP API를 통해 SQLite 쿼리 실행
 */
class CloudPress_DB extends wpdb {

    /** @var string D1 API 엔드포인트 */
    private string $d1_endpoint = '';

    /** @var string D1 API 토큰 */
    private string $d1_token = '';

    /** @var \PDO|null SQLite 폴백 PDO 인스턴스 */
    private ?\PDO $pdo = null;

    /** @var bool D1 사용 여부 */
    private bool $use_d1 = false;

    public function __construct() {
        $this->d1_endpoint = (string) (getenv('D1_ENDPOINT') ?: '');
        $this->d1_token    = (string) (getenv('D1_TOKEN')    ?: '');
        $this->use_d1      = !empty($this->d1_endpoint) && !empty($this->d1_token);

        $this->charset = DB_CHARSET;
        $this->collate = DB_COLLATE;

        global $table_prefix;
        $this->set_prefix($table_prefix ?: 'wp_');

        $this->ready = true;
        $this->show_errors();
    }

    /**
     * 쿼리 실행 메인 함수
     */
    public function query($query) {
        if (empty($query)) return false;

        $this->flush();
        $this->last_query = $query;

        // 쿼리 변환
        $sql = CloudPress_SQL_Translator::translate($query);

        // D1 사용 가능하면 D1, 아니면 SQLite 파일
        if ($this->use_d1) {
            return $this->d1_query($sql, $query);
        } else {
            return $this->sqlite_query($sql);
        }
    }

    /**
     * Cloudflare D1 HTTP API 쿼리
     */
    private function d1_query(string $sql, string $original): int|false {
        $is_read = (bool) preg_match('/^\s*(SELECT|SHOW|PRAGMA|EXPLAIN|WITH)/i', $sql);

        $url = $this->d1_endpoint . '/query';

        $response = wp_remote_post($url, [
            'method'  => 'POST',
            'headers' => [
                'Authorization' => 'Bearer ' . $this->d1_token,
                'Content-Type'  => 'application/json',
            ],
            'body'    => wp_json_encode(['sql' => $sql, 'params' => []]),
            'timeout' => 15,
        ]);

        if (is_wp_error($response)) {
            $this->last_error = $response->get_error_message();
            do_action('cloudpress_db_error', $this->last_error, $original);
            return false;
        }

        $body = json_decode(wp_remote_retrieve_body($response), true);

        if (!empty($body['error'])) {
            $this->last_error = $body['error'];
            // 테이블이 이미 존재하는 오류는 무시
            if (stripos($this->last_error, 'already exists') !== false) {
                return 0;
            }
            return false;
        }

        if ($is_read && isset($body['results'])) {
            $this->last_result = array_map(fn($r) => (object) $r, $body['results']);
            $this->num_rows    = count($this->last_result);
            return $this->num_rows;
        }

        $this->rows_affected = (int) ($body['meta']['changes']     ?? 0);
        $this->insert_id     = (int) ($body['meta']['last_row_id'] ?? 0);
        return $this->rows_affected;
    }

    /**
     * SQLite 파일 폴백 (php-wasm /tmp)
     */
    private function sqlite_query(string $sql): int|false {
        if (!$this->pdo) {
            $dbPath = defined('SQLITE_DB_REALPATH') ? SQLITE_DB_REALPATH : '/tmp/wordpress.db';
            try {
                $this->pdo = new PDO('sqlite:' . $dbPath);
                $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
                $this->pdo->exec('PRAGMA journal_mode=WAL');
                $this->pdo->exec('PRAGMA foreign_keys=OFF');
                $this->pdo->exec('PRAGMA synchronous=NORMAL');
            } catch (\PDOException $e) {
                $this->last_error = 'DB 연결 실패: ' . $e->getMessage();
                return false;
            }
        }

        try {
            $is_read = (bool) preg_match('/^\s*(SELECT|SHOW|PRAGMA|EXPLAIN|WITH)/i', $sql);
            $stmt    = $this->pdo->query($sql);

            if ($is_read) {
                $this->last_result = $stmt->fetchAll(PDO::FETCH_OBJ) ?: [];
                $this->num_rows    = count($this->last_result);
                return $this->num_rows;
            }

            $this->rows_affected = $stmt->rowCount();
            $this->insert_id     = (int) $this->pdo->lastInsertId();
            return $this->rows_affected;

        } catch (\PDOException $e) {
            $msg = $e->getMessage();
            // 이미 존재하는 테이블/인덱스는 무시
            if (stripos($msg, 'already exists') !== false) return 0;
            $this->last_error = $msg;
            return false;
        }
    }

    // ── wpdb 인터페이스 구현 ─────────────────────────────────────────────

    public function get_results($query = null, $output = OBJECT) {
        if ($query !== null) $this->query($query);
        $results = $this->last_result ?: [];
        if ($output === ARRAY_A) return array_map(fn($r) => (array) $r, $results);
        if ($output === ARRAY_N) return array_map(fn($r) => array_values((array) $r), $results);
        return $results;
    }

    public function get_row($query = null, $output = OBJECT, $y = 0) {
        if ($query !== null) $this->query($query);
        $row = $this->last_result[$y] ?? null;
        if ($row === null) return null;
        if ($output === ARRAY_A) return (array) $row;
        if ($output === ARRAY_N) return array_values((array) $row);
        return $row;
    }

    public function get_var($query = null, $column_offset = 0, $row_offset = 0) {
        if ($query !== null) $this->query($query);
        $row = $this->last_result[$row_offset] ?? null;
        if ($row === null) return null;
        $vals = array_values((array) $row);
        return $vals[$column_offset] ?? null;
    }

    public function get_col($query = null, $column_offset = 0) {
        if ($query !== null) $this->query($query);
        return array_map(function($row) use ($column_offset) {
            $vals = array_values((array) $row);
            return $vals[$column_offset] ?? null;
        }, $this->last_result ?: []);
    }

    public function prepare($query, ...$args) {
        if (empty($args)) return $query;

        // vsprintf 형식 변환
        $query = str_replace("'%s'", '%s', $query);
        $query = str_replace('"%s"', '%s', $query);
        $query = preg_replace('/(?<!%)%s/', "'%s'", $query);
        $query = preg_replace('/(?<!%)%d/', '%d', $query);
        $query = preg_replace('/(?<!%)%f/', '%f', $query);

        array_walk($args, function (&$arg) {
            if (is_null($arg)) {
                $arg = 'NULL';
            } elseif (is_int($arg) || is_float($arg)) {
                // 숫자는 타입 강제
                $arg = is_int($arg) ? (int) $arg : (float) $arg;
            } else {
                // SQL Injection 방어: 위험 패턴 차단 + escape
                $str = (string) $arg;
                // null 바이트 제거
                $str = str_replace("\x00", '', $str);
                // addslashes + 작은따옴표 이스케이프
                $arg = "'" . str_replace(
                    ["\\", "'", "\r", "\n"],
                    ["\\\\", "\\'", "\\r", "\\n"],
                    $str
                ) . "'";
            }
        });

        // %s/%d/%f 교체
        $i = 0;
        return preg_replace_callback("/'?%[sdf]'?/", function($m) use (&$i, $args) {
            return $args[$i++] ?? 'NULL';
        }, $query);
    }

    public function esc_like($text) {
        return addcslashes($text, '_%\\');
    }

    public function flush() {
        $this->last_result  = [];
        $this->last_query   = '';
        $this->last_error   = '';
        $this->num_rows     = 0;
        $this->rows_affected = 0;
        $this->insert_id    = 0;
    }

    // 호환성 메서드
    public function check_connection($allow_bail = true) { return true; }
    public function db_connect($allow_bail = true)       { return true; }
    public function db_version()                         { return '8.0.0'; }
    public function has_cap($db_cap)                     { return true; }
}

// WordPress 글로벌 DB 인스턴스 교체
global $wpdb;
$wpdb = new CloudPress_DB();
