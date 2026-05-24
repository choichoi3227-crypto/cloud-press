/**
 * POST /api/convert
 * PHP→Astro, JS→TypeScript 실시간 변환 API
 * Cloudflare Workers AI (claude) 또는 규칙 기반 변환
 */

import { jsonOk, jsonErr, requireAuth } from "../_shared.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  const payload = await requireAuth(request, env).catch(() => null);
  if (!payload) return jsonErr("Unauthorized", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("Invalid JSON", 400); }

  const { type, code, filename } = body;

  if (!type || !code) return jsonErr("type, code 파라미터가 필요합니다.", 400);
  if (!["php_to_astro", "js_to_ts"].includes(type))
    return jsonErr("type은 'php_to_astro' 또는 'js_to_ts'여야 합니다.", 400);

  try {
    let converted;
    if (type === "php_to_astro") {
      converted = await convertPhpToAstro(code, filename || "Component.astro", env);
    } else {
      converted = await convertJsToTs(code, filename || "module.ts", env);
    }

    return jsonOk({
      success:   true,
      type,
      filename:  converted.filename,
      original:  code,
      converted: converted.code,
      notes:     converted.notes || [],
    });
  } catch (e) {
    return jsonErr("변환 중 오류: " + e.message, 500);
  }
}

// ── PHP → Astro 변환 ─────────────────────────────────────────────────────────
async function convertPhpToAstro(phpCode, filename, env) {
  // AI 기반 변환 (Workers AI 사용 가능 시)
  if (env.AI) {
    try {
      const prompt = buildPhpToAstroPrompt(phpCode, filename);
      const result = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
        messages: [
          { role: "system", content: PHP_TO_ASTRO_SYSTEM },
          { role: "user",   content: prompt },
        ],
        max_tokens: 4096,
      });
      const text = result?.response || "";
      const codeMatch = text.match(/```(?:astro)?\n([\s\S]*?)```/);
      if (codeMatch) {
        return {
          filename: filename.replace(/\.php$/, ".astro"),
          code:     codeMatch[1].trim(),
          notes:    ["Workers AI (Llama) 기반 실시간 변환"],
        };
      }
    } catch {}
  }

  // 규칙 기반 폴백 변환
  return ruleBasedPhpToAstro(phpCode, filename);
}

// ── JS → TypeScript 변환 ─────────────────────────────────────────────────────
async function convertJsToTs(jsCode, filename, env) {
  if (env.AI) {
    try {
      const result = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
        messages: [
          { role: "system", content: JS_TO_TS_SYSTEM },
          { role: "user",   content: `다음 JavaScript 코드를 TypeScript로 변환하세요:\n\n\`\`\`javascript\n${jsCode}\n\`\`\`` },
        ],
        max_tokens: 4096,
      });
      const text = result?.response || "";
      const codeMatch = text.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
      if (codeMatch) {
        return {
          filename: filename.replace(/\.js$/, ".ts").replace(/\.jsx$/, ".tsx"),
          code:     codeMatch[1].trim(),
          notes:    ["Workers AI (Llama) 기반 실시간 변환"],
        };
      }
    } catch {}
  }

  return ruleBasedJsToTs(jsCode, filename);
}

// ── PHP→Astro 시스템 프롬프트 ─────────────────────────────────────────────────
const PHP_TO_ASTRO_SYSTEM = `당신은 PHP/WordPress 코드를 Astro 컴포넌트로 변환하는 전문가입니다.
규칙:
1. PHP 서버 로직은 Astro frontmatter(--- 사이)로 이전
2. WordPress 함수(get_post, the_content 등)는 Astro의 fetch/API 호출로 대체
3. <?php echo ?> 는 {변수명}으로, <?php if(): ?> 는 {조건 && <JSX>} 또는 3항 연산자로
4. WordPress 루프는 Array.map()으로
5. 결과는 반드시 .astro 파일 형식으로 출력
6. 코드만 출력하고 설명은 생략`;

function buildPhpToAstroPrompt(php, filename) {
  return `파일명: ${filename}\n\n${php}`;
}

const JS_TO_TS_SYSTEM = `당신은 JavaScript를 TypeScript로 변환하는 전문가입니다.
규칙:
1. 함수 파라미터와 반환값에 타입 추가
2. 변수 선언에 타입 명시
3. interface/type 정의 추가
4. any 타입 최소화, 명확한 타입 사용
5. JSDoc 주석이 있으면 TypeScript 타입으로 변환
6. 코드만 출력`;

// ── 규칙 기반 PHP→Astro 폴백 ─────────────────────────────────────────────────
function ruleBasedPhpToAstro(php, filename) {
  const notes = ["규칙 기반 변환 (AI 미사용)"];

  // frontmatter 추출 (PHP 로직 부분)
  let frontmatter = "";
  let template = php;

  // <?php ... ?> 블록을 Astro frontmatter로
  const phpBlocks = [];
  template = template.replace(/<\?php([\s\S]*?)\?>/g, (_, code) => {
    // echo 구문은 인라인 표현식으로
    const echoMatch = code.trim().match(/^echo\s+(.+);$/);
    if (echoMatch) {
      return `{${echoMatch[1].trim()}}`;
    }
    phpBlocks.push(code.trim());
    return "";
  });

  // 남은 <?= ... ?> 처리
  template = template.replace(/<\?=\s*(.*?)\?>/g, (_, expr) => `{${expr.trim()}}`);

  // WordPress 공통 함수 변환
  frontmatter = phpBlocks
    .join("\n")
    .replace(/get_post_meta\(([^,]+),\s*['"]([^'"]+)['"]\s*,\s*true\)/g,
      "/* TODO: fetch post meta $2 for post $1 */")
    .replace(/get_the_title\(\)/g, "post.title.rendered")
    .replace(/the_content\(\)/g, "{post.content.rendered}")
    .replace(/get_template_directory_uri\(\)/g, "import.meta.env.BASE_URL")
    .replace(/wp_enqueue_style\([^)]+\)/g, "/* TODO: add <link> in <head> */")
    .replace(/wp_enqueue_script\([^)]+\)/g, "/* TODO: add <script> tag */");

  // HTML 템플릿 정리
  template = template
    .replace(/class=/g, "class=")
    .replace(/\bfor=/g, "for=");

  const astroFilename = filename.replace(/\.php$/, ".astro");

  const astroCode = frontmatter.trim()
    ? `---\n// 변환됨: ${filename} → ${astroFilename}\n// TODO: WordPress API 호출로 데이터 fetch 추가 필요\n${frontmatter.trim()}\n---\n\n${template.trim()}`
    : `---\n// 변환됨: ${filename} → ${astroFilename}\n---\n\n${template.trim()}`;

  notes.push("PHP echo/if/loop → Astro JSX 변환");
  notes.push("WordPress 함수 → TODO 주석으로 표시 (수동 확인 필요)");

  return { filename: astroFilename, code: astroCode, notes };
}

// ── 규칙 기반 JS→TS 폴백 ──────────────────────────────────────────────────────
function ruleBasedJsToTs(js, filename) {
  const notes = ["규칙 기반 변환 (AI 미사용)"];

  let ts = js;

  // function() → (param: any) => 타입 추가 시도
  ts = ts.replace(
    /function\s+(\w+)\s*\(([^)]*)\)/g,
    (_, name, params) => {
      const typedParams = params
        .split(",")
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => `${p}: unknown`)
        .join(", ");
      return `function ${name}(${typedParams})`;
    }
  );

  // const/let/var x = [] → 타입 추가
  ts = ts.replace(/\b(const|let)\s+(\w+)\s*=\s*\[\]/g, "$1 $2: unknown[] = []");
  ts = ts.replace(/\b(const|let)\s+(\w+)\s*=\s*\{\}/g, "$1 $2: Record<string, unknown> = {}");

  // require → import
  ts = ts.replace(/const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)/g,
    "import $1 from '$2'");
  ts = ts.replace(/module\.exports\s*=\s*/g, "export default ");
  ts = ts.replace(/exports\.(\w+)\s*=/g, "export const $1 =");

  const tsFilename = filename.replace(/\.js$/, ".ts").replace(/\.jsx$/, ".tsx");

  notes.push("require → import 변환");
  notes.push("module.exports → export default 변환");
  notes.push("기본 타입 어노테이션 추가 (수동 검토 권장)");

  return { filename: tsFilename, code: ts, notes };
}
