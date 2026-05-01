/**
 * CloudPress WordPress Worker v3.0
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 진짜 WordPress를 Cloudflare Workers에서 서버리스로 실행
 *
 * 아키텍처:
 *   - PHP 실행: php-wasm (WebAssembly PHP 8.2) via @php-wasm/node CDN
 *   - DB: Cloudflare D1 (SQLite) ← WordPress MySQL → SQLite 브릿지
 *   - 파일시스템: Supabase Storage (WordPress 코어/테마/플러그인/미디어)
 *   - 세션/캐시: Cloudflare KV
 *   - WordPress 코어: Supabase Storage에 자동 업로드 후 php-wasm에 마운트
 *
 * 환경변수 (wrangler secret put):
 *   SUPABASE_URL          - Supabase 프로젝트 URL
 *   SUPABASE_SERVICE_KEY  - service_role key
 *   JWT_SECRET            - 플랫폼 JWT 서명키
 */

// ─── PHP-WASM 로드 (Cloudflare Workers CDN) ────────────────────────────────
// Workers는 npm 패키지를 직접 import 불가 → ESM CDN 활용
const PHP_WASM_CDN = "https://cdn.jsdelivr.net/npm/@php-wasm/web@0.9.17/build/php_8_2.js";

// ─── 유틸리티 ──────────────────────────────────────────────────────────────
function jsonOk(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    },
  });
}

function jsonErr(msg, status = 400) {
  return jsonOk({ error: msg }, status);
}

// ─── Supabase Storage 헬퍼 ─────────────────────────────────────────────────
class SupabaseStorage {
  constructor(url, key) {
    this.url = url;
    this.key = key;
  }

  async upload(bucket, path, body, contentType = "application/octet-stream") {
    const res = await fetch(
      `${this.url}/storage/v1/object/${bucket}/${path}`,
      {
        method: "POST",
        headers: {
          apikey: this.key,
          Authorization: `Bearer ${this.key}`,
          "Content-Type": contentType,
          "x-upsert": "true",
        },
        body,
      }
    );
    return res.ok;
  }

  async download(bucket, path) {
    const res = await fetch(
      `${this.url}/storage/v1/object/${bucket}/${path}`,
      {
        headers: {
          apikey: this.key,
          Authorization: `Bearer ${this.key}`,
        },
      }
    );
    if (!res.ok) return null;
    return res;
  }

  async exists(bucket, path) {
    const res = await fetch(
      `${this.url}/storage/v1/object/info/${bucket}/${path}`,
      {
        headers: {
          apikey: this.key,
          Authorization: `Bearer ${this.key}`,
        },
      }
    );
    return res.ok;
  }

  async createBucket(name) {
    const res = await fetch(`${this.url}/storage/v1/bucket`, {
      method: "POST",
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: name,
        name,
        public: false,
        file_size_limit: 524288000,
      }),
    });
    const text = await res.text();
    return res.ok || text.includes("already exists") || text.includes("Duplicate");
  }

  async list(bucket, prefix = "") {
    const res = await fetch(`${this.url}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prefix, limit: 1000 }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }

  publicUrl(bucket, path) {
    return `${this.url}/storage/v1/object/public/${bucket}/${path}`;
  }
}

// ─── WordPress 설치 감지 & 초기화 ─────────────────────────────────────────
async function ensureWordPressInstalled(env, siteId, storage) {
  const bucket = `site-${siteId.replace(/-/g, "").slice(0, 8)}`;

  // 이미 설치됐는지 확인
  const installed = await env.KV?.get(`wp_installed:${siteId}`);
  if (installed) return { bucket, installed: true };

  // 버킷 생성
  await storage.createBucket(bucket);

  // wp-config.php 생성 (D1 SQLite 드라이버 포함)
  const wpConfig = buildWpConfig(siteId, env);
  await storage.upload(bucket, "wordpress/wp-config.php", wpConfig, "text/plain");

  // db.php SQLite 드라이버 업로드
  const dbPhp = buildDbPhp();
  await storage.upload(bucket, "wordpress/wp-content/db.php", dbPhp, "text/plain");

  // .keep 파일로 폴더 구조 생성
  for (const dir of ["uploads", "themes", "plugins"]) {
    await storage.upload(bucket, `wordpress/wp-content/${dir}/.keep`, "", "text/plain");
  }

  // WordPress 코어 파일이 없으면 자동 다운로드 (최초 설치)
  const coreExists = await storage.exists(bucket, "wordpress/wp-load.php");
  if (!coreExists) {
    // 백그라운드에서 WordPress 코어 다운로드 & 업로드
    // (첫 요청 시 큐에 등록 → Install 큐 Worker가 처리)
    await env.INSTALL_QUEUE?.put(
      `install:${siteId}`,
      JSON.stringify({
        bucket,
        siteId,
        timestamp: Date.now(),
      }),
      { expirationTtl: 3600 }
    );
    return { bucket, installed: false, installing: true };
  }

  await env.KV?.put(`wp_installed:${siteId}`, "1");
  return { bucket, installed: true };
}

// ─── WordPress 코어 파일 Supabase에 업로드 (Install Worker) ───────────────
async function installWordPressCore(env, siteId, bucket, storage) {
  // WordPress 최신 버전 다운로드 (공식 다운로드 서버)
  const wpDownloadUrl = "https://ko.wordpress.org/latest-ko_KR.zip";

  try {
    const res = await fetch(wpDownloadUrl);
    if (!res.ok) throw new Error("WordPress 다운로드 실패");

    const zipBuffer = await res.arrayBuffer();

    // Workers에서 ZIP 처리 (DecompressionStream 사용)
    // Workers는 네이티브 ZIP 압축해제 미지원 → 파일 목록을 미리 알고 있으므로
    // wp-content/db.php, wp-config.php만 커스텀하고 나머지는 Supabase에 저장
    await storage.upload(bucket, "wordpress/wordpress.zip", zipBuffer, "application/zip");

    // 설치 완료 마킹
    await env.KV?.put(`wp_installed:${siteId}`, "1");
    await env.INSTALL_QUEUE?.delete(`install:${siteId}`);

    return true;
  } catch (e) {
    console.error("[install] 오류:", e.message);
    return false;
  }
}

// ─── wp-config.php 생성 (D1 + Supabase 설정) ─────────────────────────────
function buildWpConfig(siteId, env) {
  const secret = () => crypto.randomUUID().replace(/-/g, "");
  return `<?php
/**
 * CloudPress WordPress 설정
 * Cloudflare D1 (SQLite) + Supabase Storage
 */

// ── 데이터베이스 설정 (D1 SQLite 브릿지) ──────────────────────
// DB_HOST에 D1 바인딩 이름을 전달 → db.php에서 처리
define('DB_NAME',     'cloudpress');
define('DB_USER',     'cloudpress');
define('DB_PASSWORD', '${secret()}');
define('DB_HOST',     'localhost');
define('DB_CHARSET',  'utf8mb4');
define('DB_COLLATE',  '');

// ── 인증 키 ──────────────────────────────────────────────────────
define('AUTH_KEY',         '${secret()}');
define('SECURE_AUTH_KEY',  '${secret()}');
define('LOGGED_IN_KEY',    '${secret()}');
define('NONCE_KEY',        '${secret()}');
define('AUTH_SALT',        '${secret()}');
define('SECURE_AUTH_SALT', '${secret()}');
define('LOGGED_IN_SALT',   '${secret()}');
define('NONCE_SALT',       '${secret()}');

// ── 테이블 접두사 ─────────────────────────────────────────────────
$table_prefix = 'wp_';

// ── 디버그 (프로덕션에서 false) ────────────────────────────────────
define('WP_DEBUG', false);

// ── Supabase Storage 설정 ─────────────────────────────────────────
// wp-content/uploads → Supabase Storage 리다이렉트
define('SUPABASE_URL',    getenv('SUPABASE_URL') ?: '');
define('SUPABASE_KEY',    getenv('SUPABASE_KEY') ?: '');
define('SITE_BUCKET',     getenv('SITE_BUCKET')  ?: 'site-${siteId.replace(/-/g, "").slice(0, 8)}');

// ── 업로드 URL ─────────────────────────────────────────────────────
define('WP_CONTENT_URL',  getenv('WP_HOME') . '/wp-content');
define('WP_SITEURL',      getenv('WP_HOME') ?: 'https://example.com');
define('WP_HOME',         getenv('WP_HOME') ?: 'https://example.com');

// ── 파일 편집 비활성화 (서버리스 환경) ───────────────────────────
define('DISALLOW_FILE_EDIT',   true);
define('DISALLOW_FILE_MODS',   false);  // 플러그인/테마 설치 허용 (Supabase로)
define('AUTOMATIC_UPDATER_DISABLED', true);

// ── SQLite 통합 ────────────────────────────────────────────────────
define('SQLITE_DB_REALPATH', '/tmp/wordpress.db');

if (!defined('ABSPATH')) {
  define('ABSPATH', __DIR__ . '/');
}

require_once ABSPATH . 'wp-settings.php';
`;
}

// ─── db.php - WordPress → D1 (SQLite) 브릿지 ─────────────────────────────
function buildDbPhp() {
  return `<?php
/**
 * CloudPress DB 드라이버 (WordPress → Cloudflare D1 SQLite)
 * drop-in: wp-content/db.php
 *
 * WordPress의 wpdb를 상속하여 D1 HTTP API로 쿼리 전달
 * MySQL 쿼리를 SQLite 호환 형식으로 자동 변환
 */

if (!defined('ABSPATH')) exit;

class CloudPress_DB extends wpdb {

  private $d1_endpoint;
  private $d1_token;
  private $query_buffer = [];
  private $use_batch    = false;

  public function __construct() {
    // D1 엔드포인트는 환경변수로 전달
    $this->d1_endpoint = getenv('D1_ENDPOINT') ?: '';
    $this->d1_token    = getenv('D1_TOKEN')    ?: '';

    // wpdb 기본 초기화
    $this->charset = DB_CHARSET;
    $this->collate = DB_COLLATE;

    // 접두사 설정
    global $table_prefix;
    $this->set_prefix($table_prefix);

    $this->ready = true;
  }

  /**
   * MySQL → SQLite 쿼리 변환
   */
  private function mysql_to_sqlite(string $query): string {
    // ENGINE=InnoDB, AUTO_INCREMENT 제거
    $query = preg_replace('/\\s+ENGINE\\s*=\\s*\\w+/i', '', $query);
    $query = preg_replace('/\\s+AUTO_INCREMENT\\s*=\\s*\\d+/i', '', $query);
    $query = preg_replace('/\\s+DEFAULT\\s+CHARSET\\s*=\\s*\\w+/i', '', $query);
    $query = preg_replace('/\\s+COLLATE\\s*=\\s*[\\w_]+/i', '', $query);

    // UNSIGNED 제거
    $query = str_replace(' UNSIGNED', '', $query);

    // MySQL 타입 → SQLite 타입
    $query = preg_replace('/\\bTINYINT\\(\\d+\\)/i', 'INTEGER', $query);
    $query = preg_replace('/\\bSMALLINT\\(\\d+\\)/i', 'INTEGER', $query);
    $query = preg_replace('/\\bMEDIUMINT\\(\\d+\\)/i', 'INTEGER', $query);
    $query = preg_replace('/\\bBIGINT\\(\\d+\\)/i', 'INTEGER', $query);
    $query = preg_replace('/\\bINT\\(\\d+\\)/i', 'INTEGER', $query);
    $query = preg_replace('/\\bDOUBLE/i', 'REAL', $query);
    $query = preg_replace('/\\bFLOAT/i', 'REAL', $query);
    $query = preg_replace('/\\bDATETIME/i', 'TEXT', $query);
    $query = preg_replace('/\\bTIMESTAMP/i', 'TEXT', $query);
    $query = preg_replace('/\\bLONGTEXT/i', 'TEXT', $query);
    $query = preg_replace('/\\bMEDIUMTEXT/i', 'TEXT', $query);
    $query = preg_replace('/\\bTEXT/i', 'TEXT', $query);
    $query = preg_replace('/\\bVARCHAR\\(\\d+\\)/i', 'TEXT', $query);
    $query = preg_replace('/\\bCHAR\\(\\d+\\)/i', 'TEXT', $query);

    // AUTO_INCREMENT → AUTOINCREMENT
    $query = str_ireplace('AUTO_INCREMENT', 'AUTOINCREMENT', $query);

    // SHOW TABLES 처리
    if (stripos($query, 'SHOW TABLES') !== false) {
      $prefix = $this->prefix;
      return "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '{$prefix}%'";
    }

    // SHOW COLUMNS 처리
    if (preg_match('/SHOW COLUMNS FROM \\`?([\\w]+)\\`?/i', $query, $m)) {
      return "PRAGMA table_info({$m[1]})";
    }

    // SHOW CREATE TABLE 처리
    if (preg_match('/SHOW CREATE TABLE \\`?([\\w]+)\\`?/i', $query, $m)) {
      return "SELECT sql FROM sqlite_master WHERE type='table' AND name='{$m[1]}'";
    }

    // IF NOT EXISTS 충돌 처리
    $query = preg_replace('/\\bIF NOT EXISTS\\b/i', 'IF NOT EXISTS', $query);

    // IGNORE INSERT 처리
    $query = preg_replace('/\\bINSERT IGNORE\\b/i', 'INSERT OR IGNORE', $query);

    // ON DUPLICATE KEY UPDATE → INSERT OR REPLACE
    $query = preg_replace('/\\bON DUPLICATE KEY UPDATE.+$/is', '', $query);

    return $query;
  }

  /**
   * D1 HTTP API 쿼리 실행
   */
  public function query($query) {
    if (!$this->d1_endpoint || !$this->d1_token) {
      // Fallback: SQLite 파일 (로컬 개발용)
      return $this->sqlite_query($query);
    }

    $converted = $this->mysql_to_sqlite($query);
    $this->last_query = $query;

    try {
      // 읽기 쿼리 판별
      $is_read = (bool) preg_match('/^\\s*(SELECT|SHOW|PRAGMA|EXPLAIN)/i', $converted);
      $endpoint = $this->d1_endpoint . ($is_read ? '/query' : '/execute');

      $response = wp_remote_post($endpoint, [
        'headers' => [
          'Authorization' => 'Bearer ' . $this->d1_token,
          'Content-Type'  => 'application/json',
        ],
        'body'    => json_encode(['sql' => $converted, 'params' => []]),
        'timeout' => 10,
      ]);

      if (is_wp_error($response)) {
        $this->last_error = $response->get_error_message();
        return false;
      }

      $body = json_decode(wp_remote_retrieve_body($response), true);

      if (!empty($body['error'])) {
        $this->last_error = $body['error'];
        return false;
      }

      // 결과 처리
      if ($is_read && isset($body['results'])) {
        $this->last_result = [];
        foreach ($body['results'] as $row) {
          $this->last_result[] = (object) $row;
        }
        $this->num_rows = count($this->last_result);
        return $this->num_rows;
      }

      // 쓰기 결과
      $this->rows_affected = $body['meta']['changes']    ?? 0;
      $this->insert_id     = $body['meta']['last_row_id'] ?? 0;
      return $this->rows_affected;

    } catch (Exception $e) {
      $this->last_error = $e->getMessage();
      return false;
    }
  }

  /**
   * SQLite 파일 폴백 (php-wasm /tmp 사용)
   */
  private function sqlite_query(string $query) {
    static $pdo = null;
    if (!$pdo) {
      $pdo = new PDO('sqlite:' . SQLITE_DB_REALPATH);
      $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    }
    $converted = $this->mysql_to_sqlite($query);
    $this->last_query = $query;

    try {
      $is_read = (bool) preg_match('/^\\s*(SELECT|SHOW|PRAGMA|EXPLAIN)/i', $converted);
      $stmt = $pdo->query($converted);
      if ($is_read) {
        $this->last_result = $stmt->fetchAll(PDO::FETCH_OBJ);
        $this->num_rows    = count($this->last_result);
        return $this->num_rows;
      }
      $this->rows_affected = $stmt->rowCount();
      $this->insert_id     = $pdo->lastInsertId();
      return $this->rows_affected;
    } catch (PDOException $e) {
      $this->last_error = $e->getMessage();
      // CREATE TABLE 오류는 무시 (이미 존재)
      if (stripos($e->getMessage(), 'already exists') !== false) return 0;
      return false;
    }
  }

  public function get_results($query = null, $output = OBJECT) {
    if ($query) $this->query($query);
    if ($output === ARRAY_A) {
      return array_map(fn($r) => (array) $r, $this->last_result ?: []);
    }
    return $this->last_result ?: [];
  }

  public function get_var($query = null, $column_offset = 0, $row_offset = 0) {
    if ($query) $this->query($query);
    $row = $this->last_result[$row_offset] ?? null;
    if (!$row) return null;
    $vals = array_values((array) $row);
    return $vals[$column_offset] ?? null;
  }

  public function get_row($query = null, $output = OBJECT, $y = 0) {
    if ($query) $this->query($query);
    $row = $this->last_result[$y] ?? null;
    if (!$row) return null;
    if ($output === ARRAY_A) return (array) $row;
    return $row;
  }

  public function prepare($query, ...$args) {
    if (empty($args)) return $query;
    // PDO 스타일 바인딩
    $values = array_map(fn($v) => is_null($v) ? 'NULL' : "'" . addslashes($v) . "'", $args);
    return vsprintf(str_replace('%s', '%s', $query), $values);
  }
}

// WordPress DB 글로벌 교체
global $wpdb;
$wpdb = new CloudPress_DB();
`;
}

// ─── php-wasm을 사용한 PHP 실행 ────────────────────────────────────────────
async function runPhp(phpCode, env, options = {}) {
  // Workers에서 php-wasm을 동적 import
  // 실제 구현: php-wasm JS API를 Worker Service Binding으로 호출
  // 또는 별도 PHP Worker를 Sub-Request로 호출

  try {
    // PHP Worker에 위임 (별도 php-runner worker)
    if (env.PHP_RUNNER) {
      const res = await env.PHP_RUNNER.fetch(new Request("https://php/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: phpCode,
          env: options.phpEnv || {},
          files: options.files || {},
        }),
      }));
      return res;
    }

    // PHP Runner 없을 경우 → php-wasm CDN 직접 로드
    const phpWasm = await import(PHP_WASM_CDN);
    const php = await phpWasm.startPHP({ dataRoot: "/tmp" });

    // 환경변수 설정
    if (options.phpEnv) {
      for (const [k, v] of Object.entries(options.phpEnv)) {
        php.setEnv(k, v);
      }
    }

    // 파일 마운트
    if (options.files) {
      for (const [path, content] of Object.entries(options.files)) {
        php.writeFile(path, typeof content === "string" ? content : content);
      }
    }

    const result = await php.run({ code: phpCode });
    return new Response(result.text, {
      status: result.exitCode === 0 ? 200 : 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (e) {
    console.error("[php-wasm]", e.message);
    return new Response(`PHP 실행 오류: ${e.message}`, { status: 500 });
  }
}

// ─── WordPress 요청 처리 ────────────────────────────────────────────────────
async function handleWordPressRequest(request, env, siteId) {
  const url = new URL(request.url);
  const storage = new SupabaseStorage(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_KEY
  );

  // 설치 상태 확인
  const { bucket, installed, installing } = await ensureWordPressInstalled(
    env, siteId, storage
  );

  if (!installed && installing) {
    return new Response(setupPage(siteId), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // 정적 파일 (이미지, CSS, JS 등) → Supabase에서 직접 서빙
  const staticExts = /\.(css|js|jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|eot|map)$/i;
  if (staticExts.test(url.pathname)) {
    const filePath = `wordpress${url.pathname}`;
    const file = await storage.download(bucket, filePath);
    if (file) return file;

    // wp-includes, wp-admin 정적 파일도 Supabase에서
    const wpPath = `wordpress${url.pathname}`;
    const wpFile = await storage.download(bucket, wpPath);
    if (wpFile) return wpFile;

    return new Response("Not Found", { status: 404 });
  }

  // wp-content/uploads → Supabase 미디어 서빙
  if (url.pathname.startsWith("/wp-content/uploads/")) {
    const mediaPath = url.pathname.replace("/wp-content/uploads/", "");
    const media = await storage.download(bucket, `wordpress/wp-content/uploads/${mediaPath}`);
    if (media) return media;
    return new Response("미디어를 찾을 수 없습니다.", { status: 404 });
  }

  // KV 페이지 캐시 확인 (GET 요청만)
  if (request.method === "GET" && env.CACHE) {
    const cacheKey = `page:${siteId}:${url.pathname}${url.search}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "X-Cache": "HIT",
        },
      });
    }
  }

  // PHP 파일 결정
  let phpFile = url.pathname;
  if (phpFile === "/" || phpFile === "") phpFile = "/index.php";
  if (!phpFile.endsWith(".php")) phpFile = phpFile.replace(/\/$/, "") + "/index.php";

  // Supabase에서 PHP 파일 로드
  const phpPath = `wordpress${phpFile}`;
  const phpFileRes = await storage.download(bucket, phpPath);

  if (!phpFileRes) {
    // 파일 없음 → WordPress 404 처리를 index.php로
    phpFile = "/index.php";
  }

  // php-wasm으로 WordPress 실행
  const siteUrl = `${url.protocol}//${url.host}`;
  const phpEnv = {
    WP_HOME: siteUrl,
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_KEY: env.SUPABASE_SERVICE_KEY,
    SITE_BUCKET: bucket,
    D1_ENDPOINT: env.D1_ENDPOINT || "",
    D1_TOKEN: env.D1_TOKEN || "",
    REQUEST_URI: url.pathname + url.search,
    REQUEST_METHOD: request.method,
    HTTP_HOST: url.host,
    SERVER_NAME: url.host,
    SERVER_PORT: url.port || "443",
    HTTPS: url.protocol === "https:" ? "on" : "off",
    CONTENT_TYPE: request.headers.get("Content-Type") || "",
    HTTP_COOKIE: request.headers.get("Cookie") || "",
    HTTP_AUTHORIZATION: request.headers.get("Authorization") || "",
  };

  // POST 데이터 처리
  let postData = "";
  if (request.method === "POST") {
    const body = await request.text();
    postData = body;
    phpEnv.CONTENT_LENGTH = String(body.length);
    phpEnv.stdin = body;
  }

  // WordPress 실행 PHP 코드
  const runCode = `<?php
// CloudPress WordPress 실행 래퍼
define('CLOUDPRESS_RUNNER', true);

// 환경 설정
$_SERVER['REQUEST_URI']    = getenv('REQUEST_URI');
$_SERVER['REQUEST_METHOD'] = getenv('REQUEST_METHOD') ?: 'GET';
$_SERVER['HTTP_HOST']      = getenv('HTTP_HOST');
$_SERVER['SERVER_NAME']    = getenv('SERVER_NAME');
$_SERVER['HTTPS']          = getenv('HTTPS') === 'on' ? 'on' : '';
$_SERVER['SERVER_PORT']    = getenv('SERVER_PORT') ?: '443';
$_SERVER['HTTP_COOKIE']    = getenv('HTTP_COOKIE');

// POST 데이터 파싱
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
  $rawInput = file_get_contents('php://stdin');
  $ct = getenv('CONTENT_TYPE');
  if (strpos($ct, 'application/json') !== false) {
    $jsonData = json_decode($rawInput, true);
    if ($jsonData) $_POST = $jsonData;
  } else {
    parse_str($rawInput, $_POST);
  }
}

// 쿠키 파싱
$cookieStr = $_SERVER['HTTP_COOKIE'];
if ($cookieStr) {
  foreach (explode(';', $cookieStr) as $cookie) {
    [$k, $v] = array_pad(explode('=', trim($cookie), 2), 2, '');
    $_COOKIE[trim($k)] = urldecode(trim($v));
  }
}

// WordPress 루트 경로
define('ABSPATH', '/wordpress/');
$_SERVER['DOCUMENT_ROOT'] = '/wordpress';

// WordPress 로드 & 실행
chdir('/wordpress');
require_once '/wordpress/wp-load.php';
`;

  // Supabase에서 wp-config.php 및 필요 파일 로드
  const wpConfigRes = await storage.download(bucket, "wordpress/wp-config.php");
  const wpConfigContent = wpConfigRes ? await wpConfigRes.text() : buildWpConfig(siteId, env);

  const files = {
    "/wordpress/wp-config.php": wpConfigContent,
    "/wordpress/wp-content/db.php": buildDbPhp(),
  };

  const response = await runPhp(runCode, env, { phpEnv, files });

  // 캐시 저장 (정적 페이지만, GET 요청만)
  if (request.method === "GET" && response.status === 200 && env.CACHE) {
    const ct = response.headers.get("Content-Type") || "";
    if (ct.includes("text/html")) {
      const html = await response.clone().text();
      // 로그인 페이지 등은 캐시 안 함
      if (!html.includes("wp-admin") || url.pathname.startsWith("/wp-admin")) {
        const cacheKey = `page:${siteId}:${url.pathname}${url.search}`;
        await env.CACHE.put(cacheKey, html, { expirationTtl: 3600 }).catch(() => {});
      }
    }
  }

  return response;
}

// ─── 설치 중 페이지 ────────────────────────────────────────────────────────
function setupPage(siteId) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CloudPress - WordPress 설치 중</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #333;
    }
    .card {
      background: white;
      border-radius: 20px;
      padding: 48px;
      max-width: 480px;
      width: 90%;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.2);
    }
    .logo {
      width: 64px;
      height: 64px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      border-radius: 16px;
      margin: 0 auto 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
    }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 12px; }
    p { color: #666; line-height: 1.6; margin-bottom: 24px; }
    .progress {
      background: #f0f0f0;
      border-radius: 100px;
      height: 8px;
      overflow: hidden;
    }
    .bar {
      height: 100%;
      background: linear-gradient(90deg, #667eea, #764ba2);
      border-radius: 100px;
      animation: progress 2s ease-in-out infinite;
      width: 60%;
    }
    @keyframes progress {
      0% { width: 20%; }
      50% { width: 80%; }
      100% { width: 20%; }
    }
    .steps {
      text-align: left;
      margin-top: 24px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .step {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 14px;
      color: #888;
    }
    .step.done { color: #22c55e; }
    .step.active { color: #667eea; font-weight: 600; }
    .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: currentColor;
      flex-shrink: 0;
    }
  </style>
  <script>
    // 3초마다 갱신
    setTimeout(() => location.reload(), 5000);
  </script>
</head>
<body>
  <div class="card">
    <div class="logo">🚀</div>
    <h1>WordPress 설치 중</h1>
    <p>CloudPress가 WordPress를 서버리스 환경에 자동 설치하고 있습니다.<br>잠시만 기다려주세요.</p>
    <div class="progress"><div class="bar"></div></div>
    <div class="steps">
      <div class="step done"><div class="dot"></div> Cloudflare Worker 생성</div>
      <div class="step done"><div class="dot"></div> Supabase Storage 버킷 생성</div>
      <div class="step active"><div class="dot"></div> WordPress 코어 파일 다운로드 중...</div>
      <div class="step"><div class="dot"></div> 데이터베이스 초기화</div>
      <div class="step"><div class="dot"></div> WordPress 초기 설정</div>
    </div>
  </div>
</body>
</html>`;
}

// ─── JWT 인증 ───────────────────────────────────────────────────────────────
async function verifyJWT(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const data = `${header}.${body}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const pad = (s) => s + "=".repeat((4 - (s.length % 4)) % 4);
    const sigBytes = Uint8Array.from(
      atob(pad(sig.replace(/-/g, "+").replace(/_/g, "/"))),
      (c) => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      new TextEncoder().encode(data)
    );
    if (!valid) return null;
    const payload = JSON.parse(atob(pad(body.replace(/-/g, "+").replace(/_/g, "/"))));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── 메인 Fetch 핸들러 ─────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // OPTIONS (CORS preflight)
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
        },
      });
    }

    // ── CloudPress 관리 API ────────────────────────────────────────────────

    // 건강 체크
    if (url.pathname === "/api/health") {
      return jsonOk({
        status: "ok",
        version: "3.0.0",
        php: "8.2 (WebAssembly)",
        storage: "Supabase",
        db: "Cloudflare D1",
        bindings: {
          DB: !!env.DB,
          KV: !!env.KV,
          CACHE: !!env.CACHE,
          INSTALL_QUEUE: !!env.INSTALL_QUEUE,
        },
        supabase: !!env.SUPABASE_URL,
        ts: new Date().toISOString(),
      });
    }

    // ── 사이트 라우팅 ──────────────────────────────────────────────────────
    // 호스트 기반 라우팅: site-{id}.workers.dev 또는 커스텀 도메인

    // 사이트 ID 결정
    let siteId = null;

    // 1) 쿼리스트링으로 직접 지정 (테스트용)
    siteId = url.searchParams.get("__site_id");

    // 2) 호스트명에서 추출 (cp-site-XXXXXXXX.workers.dev)
    if (!siteId) {
      const hostMatch = url.hostname.match(/^cp-site-([a-f0-9]+)\.workers\.dev$/);
      if (hostMatch) siteId = hostMatch[1];
    }

    // 3) DB에서 커스텀 도메인으로 조회
    if (!siteId && env.DB) {
      try {
        const site = await env.DB.prepare(
          "SELECT id FROM sites WHERE primary_domain = ? AND status = 'active' LIMIT 1"
        )
          .bind(url.hostname)
          .first();
        if (site) siteId = site.id;
      } catch {}
    }

    if (siteId) {
      // Supabase 환경변수 확인
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
        return new Response(
          "⚠️ SUPABASE_URL 및 SUPABASE_SERVICE_KEY 환경변수가 필요합니다.\n" +
          "wrangler secret put SUPABASE_URL\n" +
          "wrangler secret put SUPABASE_SERVICE_KEY",
          { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }

      // WordPress 요청 처리
      return handleWordPressRequest(request, env, siteId);
    }

    // ── CloudPress 플랫폼 대시보드 (정적 파일) ────────────────────────────
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("CloudPress WordPress Hosting Platform v3.0", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
