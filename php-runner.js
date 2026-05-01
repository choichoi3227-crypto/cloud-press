/**
 * CloudPress PHP Runner Worker
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * php-wasm (WebAssembly PHP 8.2)으로 실제 PHP 코드 실행
 * 메인 Worker에서 Service Binding으로 호출
 *
 * wrangler.toml에 별도 worker로 등록:
 *   [env.production.services]
 *   binding = "PHP_RUNNER"
 *   service = "cloudpress-php"
 */

// php-wasm 임포트 (npm 패키지 사용)
// wrangler.toml에 nodejs_compat 필요
let phpModule = null;

async function loadPhpWasm() {
  if (phpModule) return phpModule;

  try {
    // @php-wasm/node를 사용 (Workers 환경)
    // 실제 배포 시 npm install @php-wasm/web 필요
    phpModule = await import("@php-wasm/web");
    return phpModule;
  } catch (e) {
    // CDN 폴백
    try {
      phpModule = await import(
        "https://cdn.jsdelivr.net/npm/@php-wasm/web@0.9.17/build/php_8_2.mjs"
      );
      return phpModule;
    } catch (e2) {
      throw new Error("php-wasm 로드 실패: " + e2.message);
    }
  }
}

/**
 * PHP 실행 핵심 함수
 */
async function executePhp({ code, env: phpEnv = {}, files = {}, stdin = "" }) {
  const wasm = await loadPhpWasm();

  // PHP 인스턴스 생성
  const php = await wasm.startPHP({
    dataRoot: "/tmp",
    phpIniEntries: {
      "memory_limit": "256M",
      "max_execution_time": "30",
      "upload_max_filesize": "50M",
      "post_max_size": "50M",
      "error_reporting": "E_ALL & ~E_NOTICE & ~E_DEPRECATED",
      "display_errors": "0",
      "log_errors": "1",
      "date.timezone": "Asia/Seoul",
      "mbstring.language": "Korean",
      "mbstring.internal_encoding": "UTF-8",
    },
  });

  // 환경변수 설정
  for (const [key, value] of Object.entries(phpEnv)) {
    if (value !== undefined && value !== null) {
      php.setEnv(key, String(value));
    }
  }

  // 파일 마운트 (가상 파일시스템)
  for (const [path, content] of Object.entries(files)) {
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) {
      try { php.mkdirTree(dir); } catch {}
    }
    if (typeof content === "string") {
      php.writeFile(path, content);
    } else if (content instanceof ArrayBuffer || ArrayBuffer.isView(content)) {
      php.writeFile(path, new Uint8Array(ArrayBuffer.isView(content) ? content.buffer : content));
    }
  }

  // stdin 설정
  if (stdin) {
    php.setStdin(stdin);
  }

  let output = "";
  let status = 200;
  const headers = new Headers();

  try {
    // PHP 코드 실행
    const result = await php.run({ code });

    output = result.text || "";
    const exitCode = result.exitCode || 0;

    // PHP 헤더 파싱
    if (result.headers) {
      for (const header of result.headers) {
        const [name, ...valueParts] = header.split(":");
        const value = valueParts.join(":").trim();

        if (name.toLowerCase() === "location") {
          status = 302;
          headers.set("Location", value);
        } else if (name.toLowerCase().startsWith("http/")) {
          const statusMatch = name.match(/HTTP\/\d+\.?\d*\s+(\d+)/i);
          if (statusMatch) status = parseInt(statusMatch[1]);
        } else if (name.toLowerCase() === "status") {
          const statusMatch = value.match(/^(\d+)/);
          if (statusMatch) status = parseInt(statusMatch[1]);
        } else {
          headers.set(name.trim(), value);
        }
      }
    }

    if (exitCode !== 0 && !output) {
      status = 500;
      output = "PHP 실행 오류 (exit code: " + exitCode + ")";
    }
  } catch (e) {
    status = 500;
    output = "PHP 실행 예외: " + e.message;
    console.error("[php-runner]", e);
  } finally {
    // php 인스턴스 정리
    try { php.exit(0); } catch {}
  }

  // Content-Type 기본값
  if (!headers.has("Content-Type")) {
    if (output.trim().startsWith("{") || output.trim().startsWith("[")) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    } else {
      headers.set("Content-Type", "text/html; charset=utf-8");
    }
  }

  return new Response(output, { status, headers });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("PHP Runner: POST only", { status: 405 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const { code, env: phpEnv = {}, files = {}, stdin = "" } = payload;

    if (!code) {
      return new Response("PHP code required", { status: 400 });
    }

    return executePhp({ code, env: phpEnv, files, stdin });
  },
};
