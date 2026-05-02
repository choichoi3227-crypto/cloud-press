#!/usr/bin/env node
/**
 * CloudPress v3.0 초기 설정 스크립트
 * 실행: node scripts/setup.mjs
 *
 * 수행 작업:
 *  1. wrangler.toml의 D1/KV ID 확인
 *  2. DB 스키마 초기화
 *  3. 환경변수(secrets) 설정 안내
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

const run = (cmd, opts = {}) => {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: opts.silent ? "pipe" : "inherit", ...opts });
  } catch (e) {
    if (!opts.allowFail) throw e;
    return null;
  }
};

console.log(`
╔═══════════════════════════════════════╗
║   CloudPress v3.0 초기 설정           ║
║   서버리스 WordPress 호스팅 플랫폼    ║
╚═══════════════════════════════════════╝
`);

// 1. wrangler 확인
try {
  run("wrangler --version", { silent: true });
} catch {
  console.error("❌ wrangler가 설치되지 않았습니다. npm install -g wrangler 로 설치하세요.");
  process.exit(1);
}
console.log("✅ Wrangler 확인 완료\n");

// 2. 필수 secrets 설정
console.log("📋 필수 환경변수(secrets) 설정이 필요합니다:\n");

const secrets = [
  {
    name: "SUPABASE_URL",
    desc: "Supabase 프로젝트 URL (https://xxxx.supabase.co)",
    required: true,
  },
  {
    name: "SUPABASE_SERVICE_KEY",
    desc: "Supabase service_role key (Settings > API)",
    required: true,
  },
  {
    name: "JWT_SECRET",
    desc: "플랫폼 JWT 서명 비밀키 (임의의 긴 문자열)",
    required: true,
  },
  {
    name: "SUPABASE_MANAGEMENT_TOKEN",
    desc: "Supabase Management API 토큰 (선택, 새 프로젝트 자동 생성용)",
    required: false,
  },
];

for (const s of secrets) {
  const req = s.required ? " [필수]" : " [선택]";
  console.log(`  ${s.name}${req}`);
  console.log(`    → ${s.desc}`);
}

console.log(`
다음 명령으로 설정하세요:

  wrangler secret put SUPABASE_URL
  wrangler secret put SUPABASE_SERVICE_KEY
  wrangler secret put JWT_SECRET

`);

const proceed = await ask("계속 진행하시겠습니까? (y/N): ");
if (proceed.toLowerCase() !== "y") {
  console.log("setup을 중단합니다. 나중에 다시 실행하세요.");
  rl.close();
  process.exit(0);
}

// 3. DB 스키마 초기화
console.log("\n📦 D1 데이터베이스 스키마 초기화 중...");
try {
  run("wrangler d1 execute cloudpress-db --remote --file=schema.sql");
  console.log("✅ 스키마 초기화 완료");
} catch (e) {
  console.error("⚠️  스키마 초기화 오류:", e.message);
  console.log("수동으로 실행하세요: wrangler d1 execute cloudpress-db --remote --file=schema.sql");
}

// 4. PHP Runner 배포
console.log("\n🚀 PHP Runner Worker 배포 중...");
try {
  run("wrangler deploy --config wrangler-php.toml");
  console.log("✅ PHP Runner 배포 완료");

  // wrangler.toml에서 PHP_RUNNER 바인딩 주석 해제
  let toml = readFileSync("wrangler.toml", "utf-8");
  if (toml.includes("# [[services]]")) {
    toml = toml
      .replace("# [[services]]", "[[services]]")
      .replace("# binding = \"PHP_RUNNER\"", "binding = \"PHP_RUNNER\"")
      .replace("# service = \"cloudpress-php\"", "service = \"cloudpress-php\"");
    writeFileSync("wrangler.toml", toml);
    console.log("✅ wrangler.toml PHP_RUNNER 바인딩 활성화");
  }
} catch (e) {
  console.error("⚠️  PHP Runner 배포 오류:", e.message);
}

// 5. 메인 Worker 배포
console.log("\n🚀 메인 Worker 배포 중...");
try {
  run("wrangler deploy");
  console.log("✅ 메인 Worker 배포 완료");
} catch (e) {
  console.error("⚠️  배포 오류:", e.message);
}

console.log(`
╔═══════════════════════════════════════════════╗
║   ✅ CloudPress v3.0 설정 완료!               ║
╠═══════════════════════════════════════════════╣
║                                               ║
║  환경변수를 아직 설정하지 않았다면:           ║
║    wrangler secret put SUPABASE_URL           ║
║    wrangler secret put SUPABASE_SERVICE_KEY   ║
║    wrangler secret put JWT_SECRET             ║
║                                               ║
║  이후 재배포:  wrangler deploy                ║
╚═══════════════════════════════════════════════╝
`);

rl.close();
