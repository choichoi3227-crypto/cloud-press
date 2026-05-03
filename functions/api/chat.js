// functions/api/chat.js
// POST /api/chat  → 챗봇 응답 (스크립트 매칭 → Cloudflare AI → Gemini 폴백)
// POST /api/chat/inquiry → 직접 문의 저장

import { jsonOk, jsonErr } from "../_shared.js";

// ── 스크립트 정의 (거미줄 Q&A 구조) ──────────────────────────────────────────
// 각 노드: { keywords[], answer, children?: {keyword[], answer, children?}[] }
const SCRIPTS = [
  // 1. 가격/요금 클러스터
  {
    id: "pricing",
    keywords: ["요금", "가격", "플랜", "얼마", "비용", "pricing", "plan", "무료", "유료"],
    answer: `💰 **CloudPress 요금 안내**

CloudPress는 다음 플랜을 제공합니다:

• **Free** — 무료, WordPress 사이트 1개, 1GB 스토리지
• **Starter** — 월 $5, 사이트 3개, 10GB 스토리지
• **Pro** — 월 $15, 사이트 10개, 50GB 스토리지, 우선 지원
• **Business** — 월 $39, 무제한 사이트, 200GB 스토리지, 전담 지원

모든 플랜은 SSL, CDN, 자동 백업이 포함되어 있습니다. 더 궁금한 점이 있으신가요?`,
    children: [
      {
        keywords: ["무료", "free", "0원"],
        answer: `🆓 **Free 플랜 상세**

Free 플랜에서는:
• WordPress 사이트 1개 운영 가능
• 1GB GitHub 스토리지
• Cloudflare 글로벌 CDN
• 자동 SSL 인증서
• 기본 기술 지원

업그레이드 없이 영구 무료로 사용하실 수 있습니다! 업그레이드가 필요하시면 [요금 페이지](/pricing.html)를 확인해주세요.`
      },
      {
        keywords: ["pro", "프로", "비즈니스", "business"],
        answer: `⭐ **Pro / Business 플랜 비교**

| 항목 | Pro ($15/월) | Business ($39/월) |
|------|-------------|------------------|
| 사이트 수 | 10개 | 무제한 |
| 스토리지 | 50GB | 200GB |
| 지원 | 우선 처리 | 전담 담당자 |
| 고급 캐시 | ✅ | ✅ |
| 팀 계정 | ❌ | ✅ |

결제는 [결제 페이지](/payment.html)에서 바로 진행하실 수 있습니다.`
      },
      {
        keywords: ["환불", "취소", "refund", "cancel"],
        answer: `💳 **환불 및 취소 정책**

• 결제 후 **7일 이내** 전액 환불 가능
• 7일 이후에는 잔여 기간 비례 환불
• 취소 후에도 구독 만료일까지 서비스 이용 가능
• 환불 요청: 우측 하단 **직접 문의** 버튼 클릭

더 자세한 사항은 직접 문의해 주세요.`
      }
    ]
  },

  // 2. 호스팅 생성/관리 클러스터
  {
    id: "hosting",
    keywords: ["호스팅", "사이트", "생성", "만들기", "배포", "wordpress", "워드프레스", "hosting", "create"],
    answer: `🚀 **WordPress 호스팅 생성 방법**

1. **대시보드** → [호스팅 관리](/hosting.html) 이동
2. **새 호스팅 생성** 버튼 클릭
3. 사이트 이름, 도메인 입력
4. PHP 버전 선택 (권장: PHP 8.2)
5. WordPress 설정 (관리자 계정 등)
6. **생성** 클릭 → 약 1~3분 내 완료

생성 완료 후 WordPress 대시보드에 바로 접속할 수 있습니다. 문제가 있으신가요?`,
    children: [
      {
        keywords: ["오류", "에러", "error", "실패", "안됨", "안 됨"],
        answer: `🔧 **호스팅 생성 오류 해결**

자주 발생하는 오류와 해결방법:

1. **GitHub 연결 오류** → 관리자 설정에서 GitHub 토큰 확인
2. **도메인 중복** → 다른 도메인 이름 사용
3. **생성 후 "설치 중" 지속** → 1~2분 대기 후 새로고침
4. **DB 오류** → Cloudflare D1 바인딩 확인 필요

해결이 안 되신다면 **직접 문의**를 통해 알려주세요. 빠르게 도와드리겠습니다!`
      },
      {
        keywords: ["도메인", "domain", "연결", "커스텀"],
        answer: `🌐 **커스텀 도메인 연결 방법**

1. 호스팅 상세 → **도메인 관리** 탭
2. **도메인 추가** 클릭
3. 사용할 도메인 입력
4. DNS 설정: CNAME을 \`cloudpress.app\`으로 설정
5. SSL 자동 발급 (최대 5분 소요)

Cloudflare DNS를 사용 중이라면 [DNS 관리](/dns.html)에서 직접 설정 가능합니다.`
      },
      {
        keywords: ["삭제", "제거", "delete", "remove"],
        answer: `🗑️ **호스팅 삭제 방법**

1. [호스팅 관리](/hosting.html) 이동
2. 삭제할 사이트 선택 → **상세 보기**
3. 하단 **위험 구역** → **사이트 삭제** 클릭
4. 사이트 이름 입력하여 확인

⚠️ **주의**: 삭제된 데이터는 복구되지 않습니다. 미리 백업을 받아두세요!`
      }
    ]
  },

  // 3. GitHub 연동 클러스터
  {
    id: "github",
    keywords: ["github", "깃허브", "토큰", "token", "저장소", "repository", "repo"],
    answer: `🐱 **GitHub 연동 안내**

CloudPress는 WordPress 파일을 GitHub에 안전하게 저장합니다.

**연동 방법:**
1. [GitHub Settings](https://github.com/settings/tokens/new) → Personal Access Tokens
2. **repo** 권한 체크 → 토큰 생성
3. CloudPress **관리자 설정** → GitHub 토큰 추가

토큰은 **무제한**으로 추가 가능하며, 자동으로 부하를 분산합니다. 더 궁금한 점이 있으신가요?`,
    children: [
      {
        keywords: ["rate limit", "한도", "초과", "limit"],
        answer: `⚡ **GitHub API Rate Limit 해결**

Rate Limit 초과 시:
• 추가 GitHub 토큰을 등록하면 자동으로 부하 분산
• 관리자 설정 → GitHub 토큰 → **API 추가**
• 토큰은 무제한으로 추가 가능

토큰 1개당 시간당 5,000 요청이 가능합니다. 토큰을 2개 추가하면 10,000 요청까지 처리됩니다.`
      },
      {
        keywords: ["private", "공개", "비공개", "public"],
        answer: `🔒 **GitHub 저장소 공개/비공개 설정**

CloudPress는 기본적으로 **비공개(Private) 저장소**에 WordPress 파일을 저장합니다.

• 비공개: 파일이 외부에 노출되지 않음 (권장)
• 공개: 누구나 파일 내용 열람 가능 (주의 필요)

저장소 설정은 GitHub에서 직접 변경하실 수 있습니다.`
      }
    ]
  },

  // 4. 결제/청구 클러스터
  {
    id: "billing",
    keywords: ["결제", "청구", "invoice", "billing", "카드", "payment", "페이"],
    answer: `💳 **결제 및 청구 안내**

CloudPress 결제 수단:
• 신용카드 / 체크카드 (Visa, MasterCard, 국내카드)
• 토스페이먼츠를 통한 안전한 결제

**청구서 확인:** [계정 관리](/account.html) → 청구 탭

결제 관련 문의는 직접 문의를 통해 도움드리겠습니다.`,
    children: [
      {
        keywords: ["영수증", "세금계산서", "invoice", "계산서"],
        answer: `🧾 **영수증/세금계산서 발급**

• 결제 완료 후 이메일로 자동 발송됩니다
• 세금계산서가 필요하신 경우 **직접 문의**로 요청해주세요
• 사업자등록번호, 이메일 주소를 함께 알려주시면 신속 처리해드립니다`
      },
      {
        keywords: ["자동결제", "구독", "subscription", "자동"],
        answer: `🔄 **자동 결제(구독) 안내**

• 매월 결제일에 자동으로 갱신됩니다
• 구독 취소: [계정 관리](/account.html) → 구독 → 취소
• 취소 후에도 **만료일까지** 서비스 이용 가능
• 갱신 3일 전에 이메일 알림이 발송됩니다`
      }
    ]
  },

  // 5. 기술 지원 클러스터
  {
    id: "support",
    keywords: ["지원", "도움", "문의", "support", "help", "느림", "속도", "성능", "performance"],
    answer: `🛠️ **기술 지원 안내**

CloudPress 지원 채널:
• 💬 **챗봇** (지금 이용 중) — 24/7 즉시 응답
• 📧 **직접 문의** — 우측 하단 버튼 → 1영업일 내 답변
• 📚 **문서** — [FAQ](/faq.html), [가이드](/about.html)

무엇을 도와드릴까요?`,
    children: [
      {
        keywords: ["느림", "slow", "속도", "loading", "로딩"],
        answer: `⚡ **사이트 속도 개선 방법**

1. **캐시 활성화** → 호스팅 상세 → 캐시 관리 → 퍼지/활성화
2. **이미지 최적화** → WebP 변환 권장
3. **플러그인 정리** → 불필요한 플러그인 비활성화
4. **CDN 확인** → Cloudflare CDN 자동 적용 중

호스팅 상세 페이지에서 트래픽과 응답 속도를 확인하실 수 있습니다.`
      },
      {
        keywords: ["백업", "backup", "복원", "restore"],
        answer: `💾 **백업 및 복원**

CloudPress 백업 시스템:
• **자동 백업**: 매일 자정 자동 실행
• **수동 백업**: 호스팅 상세 → 백업 탭 → 지금 백업
• **복원**: 백업 목록에서 복원 버튼 클릭

백업 파일은 GitHub 저장소에 안전하게 보관됩니다. Pro 이상 플랜은 30일치 백업을 보관합니다.`
      },
      {
        keywords: ["ssl", "https", "인증서", "certificate"],
        answer: `🔐 **SSL 인증서 안내**

CloudPress는 모든 사이트에 **무료 SSL**을 자동 제공합니다.

• Let's Encrypt 인증서 자동 발급
• 90일마다 자동 갱신
• HTTP → HTTPS 자동 리디렉션

SSL이 적용되지 않는 경우: 도메인 DNS 설정을 확인하거나 직접 문의해주세요.`
      }
    ]
  },

  // 6. 계정 관리 클러스터
  {
    id: "account",
    keywords: ["계정", "account", "비밀번호", "password", "이메일", "email", "로그인", "login", "회원"],
    answer: `👤 **계정 관리 안내**

계정 관련 작업:
• **비밀번호 변경**: [계정 설정](/account.html) → 보안 탭
• **이메일 변경**: 직접 문의 필요 (본인 확인 후 처리)
• **회원 탈퇴**: 계정 설정 → 위험 구역 → 탈퇴

무엇을 도와드릴까요?`,
    children: [
      {
        keywords: ["비밀번호", "password", "잊음", "forgot", "분실"],
        answer: `🔑 **비밀번호 재설정**

1. [로그인 페이지](/login.html) → **비밀번호 찾기** 클릭
2. 가입한 이메일 주소 입력
3. 이메일로 재설정 링크 발송 (수 분 내)
4. 링크 클릭 → 새 비밀번호 설정

이메일이 오지 않는다면 스팸함을 확인하거나 직접 문의해주세요.`
      },
      {
        keywords: ["탈퇴", "삭제", "계정삭제", "withdraw"],
        answer: `⚠️ **계정 탈퇴 안내**

탈퇴 전 확인사항:
• 모든 WordPress 사이트가 **삭제**됩니다
• 데이터 복구가 **불가능**합니다
• 구독 중인 플랜은 **즉시 취소**됩니다

탈퇴를 원하신다면: [계정 설정](/account.html) → 위험 구역 → 계정 삭제`
      }
    ]
  },

  // 7. CloudPress 서비스 소개 클러스터
  {
    id: "about",
    keywords: ["cloudpress", "클라우드프레스", "뭐야", "what", "소개", "서비스", "기능", "features", "어떤"],
    answer: `☁️ **CloudPress 소개**

CloudPress는 **서버리스 WordPress 호스팅 플랫폼**입니다.

**핵심 특징:**
• 🚀 Cloudflare 글로벌 네트워크 (200+ 엣지 서버)
• 📂 GitHub 기반 파일 스토리지
• 🗄️ Cloudflare D1 데이터베이스
• 🔒 자동 SSL + CDN 포함
• ⚡ 코드 한 줄 없이 WordPress 배포

[기능 소개 페이지](/features.html)에서 더 자세히 확인하세요.`,
    children: [
      {
        keywords: ["cloudflare", "클라우드플레어", "worker", "d1", "kv"],
        answer: `☁️ **Cloudflare 인프라 상세**

CloudPress는 Cloudflare의 최신 기술을 활용합니다:

• **Workers**: PHP를 WebAssembly로 실행
• **D1**: WordPress 데이터베이스 (SQLite 호환)
• **KV**: 세션 및 캐시 저장소
• **R2/GitHub**: 미디어 및 파일 스토리지
• **CDN**: 전 세계 200+ 엣지 서버

덕분에 기존 호스팅보다 훨씬 빠른 응답 속도를 제공합니다.`
      },
      {
        keywords: ["비교", "vs", "차이", "다른", "compare", "차별"],
        answer: `🆚 **CloudPress vs 일반 호스팅 비교**

| 항목 | CloudPress | 일반 호스팅 |
|------|-----------|------------|
| 서버 유지 | 불필요 | 필요 |
| 글로벌 CDN | 기본 포함 | 별도 비용 |
| 확장성 | 자동 | 수동 |
| 백업 | 자동 | 플랜마다 다름 |
| 가격 | 저렴 | 상대적으로 비쌈 |

서버리스 구조로 트래픽이 급증해도 안정적으로 운영됩니다.`
      }
    ]
  },

  // 8. 도메인 관련
  {
    id: "domain",
    keywords: ["도메인", "domain", "DNS", "네임서버", "nameserver", "subdomain", "서브도메인"],
    answer: `🌐 **도메인 관리 안내**

CloudPress에서 도메인 관리:
• **기본 도메인**: \`{사이트명}.cloudpress.app\` 자동 제공
• **커스텀 도메인**: 외부 도메인 연결 가능
• **DNS 관리**: Cloudflare DNS 직접 관리 가능

[도메인 관리](/domains.html)에서 모든 도메인을 한눈에 확인하세요.`,
    children: [
      {
        keywords: ["이전", "migration", "기존", "옮기기", "migrate"],
        answer: `📦 **기존 사이트 이전 방법**

기존 WordPress 사이트를 CloudPress로 이전하는 방법:

1. 기존 사이트에서 **All-in-One WP Migration** 플러그인으로 백업
2. CloudPress에서 새 호스팅 생성
3. WordPress 대시보드 → 플러그인 설치 → 백업 파일 가져오기
4. 도메인 DNS를 CloudPress로 변경

이전 지원이 필요하시면 직접 문의해주세요.`
      }
    ]
  },

  // 9. 플러그인/테마
  {
    id: "plugins",
    keywords: ["플러그인", "plugin", "테마", "theme", "설치", "install", "woocommerce"],
    answer: `🧩 **플러그인 & 테마 안내**

CloudPress WordPress에서 플러그인/테마 사용:
• WordPress 공식 플러그인 디렉터리의 모든 플러그인 사용 가능
• 테마 커스터마이저 정상 동작
• WooCommerce 지원

**주의**: 파일 시스템에 직접 쓰는 일부 플러그인은 제한될 수 있습니다. (GitHub 저장소에 저장됨)`,
    children: [
      {
        keywords: ["woocommerce", "쇼핑몰", "e-commerce", "상점"],
        answer: `🛒 **WooCommerce (쇼핑몰) 지원**

CloudPress에서 WooCommerce를 사용하실 수 있습니다:
• WordPress 대시보드 → 플러그인 → WooCommerce 설치
• 결제 게이트웨이 연동 가능
• 상품 이미지는 GitHub 저장소에 자동 저장

대용량 쇼핑몰 운영 시 Pro 이상 플랜을 권장합니다.`
      }
    ]
  },

  // 10. PHP/서버 설정
  {
    id: "php",
    keywords: ["php", "php버전", "server", "서버", "8.2", "8.1", "설정", "config"],
    answer: `⚙️ **PHP 버전 및 서버 설정**

CloudPress 지원 PHP 버전:
• **PHP 8.2** ✅ (권장, 최신 보안 패치)
• **PHP 8.1** ✅ (안정)
• **PHP 8.0** ⚠️ (지원 종료 예정)

PHP 버전 변경: 호스팅 상세 → 설정 탭 → PHP 버전 선택`,
    children: [
      {
        keywords: ["오류", "error", "500", "404", "php error"],
        answer: `🔍 **PHP 오류 디버깅**

1. **로그 확인**: 호스팅 상세 → 로그 탭
2. **디버그 모드**: wp-config.php에서 WP_DEBUG 활성화
3. **플러그인 충돌**: 플러그인 비활성화 후 순차 테스트
4. **메모리 제한**: PHP 메모리 설정 확인

오류 로그를 첨부해서 직접 문의해주시면 빠르게 해결해드립니다.`
      }
    ]
  },
];

// ── 스크립트 매칭 함수 ─────────────────────────────────────────────────────
function matchScript(message) {
  const msg = message.toLowerCase().replace(/[?!.,。？！]/g, "").trim();

  for (const script of SCRIPTS) {
    const topMatch = script.keywords.some(kw => msg.includes(kw.toLowerCase()));
    if (topMatch) {
      // 자식 노드 먼저 체크 (더 구체적인 매칭)
      if (script.children) {
        for (const child of script.children) {
          const childMatch = child.keywords.some(kw => msg.includes(kw.toLowerCase()));
          if (childMatch) return child.answer;
        }
      }
      return script.answer;
    }
  }
  return null;
}

// ── Cloudflare AI 호출 ────────────────────────────────────────────────────
async function callCloudflareAI(message, env) {
  if (!env.AI) return null;
  try {
    const systemPrompt = `당신은 CloudPress의 친절한 고객 지원 AI입니다.
CloudPress는 Cloudflare Workers + GitHub Storage 기반의 서버리스 WordPress 호스팅 플랫폼입니다.
주요 특징: Cloudflare D1 DB, KV 캐시, 자동 SSL/CDN, GitHub 파일 저장, PHP WebAssembly 실행.
요금: Free(무료,1사이트), Starter($5,3사이트), Pro($15,10사이트), Business($39,무제한).
항상 한국어로 간결하고 친절하게 답변하세요. 마크다운 사용 가능. 모르는 내용은 "직접 문의"를 안내하세요.`;

    const response = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ],
      max_tokens: 512,
    });

    return response?.response || null;
  } catch (e) {
    console.warn("[CF AI] 오류:", e.message);
    return null;
  }
}

// ── Gemini 호출 (폴백) ────────────────────────────────────────────────────
async function callGemini(message, env, geminiApiKeys, geminiModel) {
  if (!geminiApiKeys || geminiApiKeys.length === 0) return null;

  const systemPrompt = `당신은 CloudPress의 친절한 고객 지원 AI입니다.
CloudPress는 Cloudflare Workers + GitHub Storage 기반의 서버리스 WordPress 호스팅 플랫폼입니다.
주요 특징: Cloudflare D1 DB, KV 캐시, 자동 SSL/CDN, GitHub 파일 저장, PHP WebAssembly 실행.
요금: Free(무료,1사이트), Starter($5,3사이트), Pro($15,10사이트), Business($39,무제한).
항상 한국어로 간결하고 친절하게 답변하세요. 마크다운 사용 가능. 모르는 내용은 "직접 문의"를 안내하세요.`;

  const model = geminiModel || "gemini-2.5-flash-lite-preview-06-17";

  // 여러 API 키 중 랜덤 선택 (부하 분산)
  const apiKey = geminiApiKeys[Math.floor(Math.random() * geminiApiKeys.length)];

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: message }] }],
          generationConfig: { maxOutputTokens: 512, temperature: 0.7 },
        }),
      }
    );
    if (!res.ok) {
      console.warn("[Gemini] HTTP", res.status);
      return null;
    }
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (e) {
    console.warn("[Gemini] 오류:", e.message);
    return null;
  }
}

// ── GET 지원 스크립트 목록 ─────────────────────────────────────────────────
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  if (url.pathname.endsWith("/scripts")) {
    return jsonOk({
      success: true,
      scripts: SCRIPTS.map(s => ({
        id: s.id,
        keywords: s.keywords,
        childCount: s.children?.length || 0,
      })),
    });
  }
  return jsonErr("Not found", 404);
}

// ── POST /api/chat ─────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 직접 문의 저장
  if (url.pathname.endsWith("/inquiry")) {
    return handleInquiry(context);
  }

  let body;
  try { body = await request.json(); } catch { return jsonErr("요청 형식 오류", 400); }

  const message = (body.message || "").trim();
  if (!message) return jsonErr("메시지가 필요합니다.", 400);

  // 1단계: 스크립트 매칭 (즉시 응답)
  const scriptAnswer = matchScript(message);
  if (scriptAnswer) {
    return jsonOk({ success: true, answer: scriptAnswer, source: "script" });
  }

  // 2단계: Cloudflare AI
  const cfAnswer = await callCloudflareAI(message, env);
  if (cfAnswer) {
    return jsonOk({ success: true, answer: cfAnswer, source: "cloudflare-ai" });
  }

  // 3단계: Gemini 폴백 - DB에서 API 키 조회
  let geminiKeys = [];
  let geminiModel = "gemini-2.5-flash-lite-preview-06-17";
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS gemini_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key TEXT NOT NULL,
      label TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`).run().catch(() => {});
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ai_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT ''
    )`).run().catch(() => {});

    const keys = await env.DB.prepare("SELECT api_key FROM gemini_settings").all().catch(() => ({ results: [] }));
    geminiKeys = (keys.results || []).map(r => r.api_key).filter(Boolean);

    const modelRow = await env.DB.prepare("SELECT value FROM ai_settings WHERE key='gemini_model'").first().catch(() => null);
    if (modelRow?.value) geminiModel = modelRow.value;
  } catch (e) {
    console.warn("[chat] DB 조회 오류:", e.message);
  }

  const geminiAnswer = await callGemini(message, env, geminiKeys, geminiModel);
  if (geminiAnswer) {
    return jsonOk({ success: true, answer: geminiAnswer, source: "gemini" });
  }

  // 모두 실패 시 기본 응답
  return jsonOk({
    success: true,
    answer: `죄송합니다. 현재 AI 응답에 문제가 발생했습니다. 😅\n\n더 자세한 도움이 필요하시면 **직접 문의** 버튼을 이용해주세요. 빠르게 답변드리겠습니다!`,
    source: "fallback",
  });
}

// ── 직접 문의 저장 ─────────────────────────────────────────────────────────
async function handleInquiry(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); } catch { return jsonErr("요청 형식 오류", 400); }

  const { name, email, subject, message, user_id } = body;
  if (!name || !email || !message) return jsonErr("이름, 이메일, 메시지는 필수입니다.", 400);

  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS support_inquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      subject TEXT DEFAULT '',
      message TEXT NOT NULL,
      user_id TEXT DEFAULT NULL,
      status TEXT DEFAULT 'open',
      admin_reply TEXT DEFAULT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      replied_at TEXT DEFAULT NULL
    )`).run().catch(() => {});

    await env.DB.prepare(
      "INSERT INTO support_inquiries (name, email, subject, message, user_id) VALUES (?, ?, ?, ?, ?)"
    ).bind(name, email, subject || "", message, user_id || null).run();

    return jsonOk({ success: true, message: "문의가 접수되었습니다. 빠른 시일 내에 답변드리겠습니다!" });
  } catch (e) {
    return jsonErr("문의 저장 실패: " + e.message, 500);
  }
}
