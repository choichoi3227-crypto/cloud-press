// functions/api/payment.js
// POST /api/payment/request   → 토스 결제 요청 데이터 생성
// POST /api/payment/confirm   → 토스 결제 승인 (서버사이드)
// GET  /api/payment/history   → 결제 내역 조회
// GET  /api/payment/site-plan?site_id= → 특정 호스팅 플랜 조회

import { jsonOk, jsonErr, requireAuth } from "../_shared.js";

// ── 설정 조회 ───────────────────────────────────────────────────────────────
async function getSettings(env) {
  const rows = await env.DB.prepare("SELECT key, value FROM admin_settings").all()
    .catch(() => ({ results: [] }));
  const s = {};
  for (const r of (rows.results || [])) s[r.key] = r.value;
  return s;
}

// ── 플랜 가격 정의 ─────────────────────────────────────────────────────────
// product_type: hosting | cpdb | cp3 | cachecloud
const PLANS = {
  // 워드프레스 호스팅 (호스팅당)
  hosting: {
    starter:    { monthly: 9900,  yearly: 7920  },
    pro:        { monthly: 24900, yearly: 19920 },
    enterprise: { monthly: 59900, yearly: 47920 },
  },
  // CloudPressDB (계정 단위)
  cpdb: {
    basic:    { monthly: 5900,  yearly: 4720  },
    standard: { monthly: 14900, yearly: 11920 },
    pro:      { monthly: 39900, yearly: 31920 },
  },
  // CP3 오브젝트 스토리지 (계정 단위)
  cp3: {
    basic:    { monthly: 3900,  yearly: 3120  },
    standard: { monthly: 9900,  yearly: 7920  },
    pro:      { monthly: 29900, yearly: 23920 },
  },
  // CacheCloud (계정 단위)
  cachecloud: {
    basic:    { monthly: 4900,  yearly: 3920  },
    standard: { monthly: 12900, yearly: 10320 },
    pro:      { monthly: 29900, yearly: 23920 },
  },
};

// 상품 타입별 유효 플랜
const VALID_PLANS = {
  hosting:    ["starter", "pro", "enterprise"],
  cpdb:       ["basic", "standard", "pro"],
  cp3:        ["basic", "standard", "pro"],
  cachecloud: ["basic", "standard", "pro"],
};

const PRODUCT_NAMES = {
  hosting:    "워드프레스 호스팅",
  cpdb:       "CloudPressDB",
  cp3:        "CP3",
  cachecloud: "CacheCloud",
};

// ── payments 테이블 보장 ──────────────────────────────────────────────────
async function ensureTable(db) {
  // 기존 테이블의 site_id가 NOT NULL인지 확인하여 문제 있으면 재생성
  try {
    const tableInfo = await db.prepare("PRAGMA table_info(payments)").all().catch(() => ({ results: [] }));
    const siteIdCol = (tableInfo.results || []).find(c => c.name === 'site_id');
    if (siteIdCol && siteIdCol.notnull === 1) {
      // NOT NULL 제약 있는 경우 — 새 테이블로 교체
      await db.prepare("ALTER TABLE payments RENAME TO payments_old").run().catch(() => {});
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS payments (
          id               TEXT PRIMARY KEY,
          user_id          TEXT NOT NULL,
          site_id          TEXT,
          product_type     TEXT NOT NULL DEFAULT 'hosting',
          plan             TEXT NOT NULL,
          billing_cycle    TEXT NOT NULL DEFAULT 'monthly',
          amount           INTEGER NOT NULL,
          status           TEXT NOT NULL DEFAULT 'pending',
          toss_order_id    TEXT UNIQUE,
          toss_payment_key TEXT,
          toss_receipt_url TEXT,
          expires_at       TEXT,
          created_at       TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `).run().catch(() => {});
      // 기존 데이터 이전
      await db.prepare("INSERT OR IGNORE INTO payments SELECT * FROM payments_old").run().catch(() => {});
      await db.prepare("DROP TABLE IF EXISTS payments_old").run().catch(() => {});
    }
  } catch (_) {}

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS payments (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      site_id          TEXT,
      product_type     TEXT NOT NULL DEFAULT 'hosting',
      plan             TEXT NOT NULL,
      billing_cycle    TEXT NOT NULL DEFAULT 'monthly',
      amount           INTEGER NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      toss_order_id    TEXT UNIQUE,
      toss_payment_key TEXT,
      toss_receipt_url TEXT,
      expires_at       TEXT,
      created_at       TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run().catch(() => {});

  // 기존 테이블에 product_type 컬럼 추가 (없으면)
  await db.prepare("ALTER TABLE payments ADD COLUMN product_type TEXT DEFAULT 'hosting'").run().catch(() => {});
  await db.prepare("ALTER TABLE payments ADD COLUMN site_id TEXT").run().catch(() => {});

  // sites 테이블에 plan 컬럼 추가 (없으면)
  await db.prepare("ALTER TABLE sites ADD COLUMN site_plan TEXT DEFAULT 'free'").run().catch(() => {});
  await db.prepare("ALTER TABLE sites ADD COLUMN plan_expires_at TEXT").run().catch(() => {});

  // 상품 구독 테이블
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS user_product_subscriptions (
      user_id      TEXT NOT NULL,
      product_type TEXT NOT NULL,
      plan         TEXT NOT NULL DEFAULT 'basic',
      status       TEXT NOT NULL DEFAULT 'inactive',
      expires_at   TEXT,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, product_type)
    )
  `).run().catch(() => {});
}

// ── path 추출 ─────────────────────────────────────────────────────────────
function getSubPath(context) {
  if (context.params?.path) {
    const p = Array.isArray(context.params.path)
      ? context.params.path.join("/") : context.params.path;
    return p.replace(/^\/+|\/+$/g, "");
  }
  const url = new URL(context.request.url);
  return url.pathname.replace(/^.*\/api\/payment\/?/, "").replace(/\?.*$/, "").replace(/^\/+|\/+$/g, "");
}

// ── GET ───────────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  await ensureTable(env.DB);
  const sub = getSubPath(context);
  const url = new URL(request.url);

  // 결제 내역
  if (sub === "history" || sub === "") {
    const rows = await env.DB.prepare(
      `SELECT p.id, p.site_id, s.site_name, p.plan, p.billing_cycle,
              p.amount, p.status, p.expires_at, p.created_at, p.toss_receipt_url
       FROM payments p
       LEFT JOIN sites s ON p.site_id = s.id
       WHERE p.user_id = ?
       ORDER BY p.rowid DESC LIMIT 50`
    ).bind(payload.id).all().catch(() => ({ results: [] }));
    return jsonOk({ success: true, payments: rows.results || [] });
  }

  // 특정 호스팅 플랜 조회
  if (sub === "site-plan") {
    const siteId = url.searchParams.get("site_id");
    if (!siteId) return jsonErr("site_id 필요", 400);
    const site = await env.DB.prepare(
      "SELECT id, site_plan, plan_expires_at FROM sites WHERE id = ? AND user_id = ?"
    ).bind(siteId, payload.id).first();
    if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
    return jsonOk({
      success: true,
      site_id: site.id,
      plan: site.site_plan || "free",
      expires_at: site.plan_expires_at || null,
      is_active: !site.plan_expires_at || new Date(site.plan_expires_at) > new Date(),
    });
  }

  // 토스 클라이언트 키 조회 (프론트엔드용)
  if (sub === "client-key") {
    const settings = await getSettings(env);
    const clientKey = settings.toss_client_key || "";
    if (!clientKey) return jsonErr("결제 설정이 되어있지 않습니다. 관리자에게 문의하세요.", 503);
    return jsonOk({ success: true, client_key: clientKey });
  }

  return jsonErr("알 수 없는 경로", 404);
}

// ── POST ──────────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  await ensureTable(env.DB);
  const sub = getSubPath(context);

  let body;
  try { body = await request.json(); } catch { return jsonErr("요청 형식 오류", 400); }

  // ── 결제 요청 초기화 ──────────────────────────────────────────────────
  if (sub === "request") {
    const { product_type = "hosting", site_id, plan, billing_cycle = "monthly" } = body;

    if (!["hosting", "cpdb", "cp3", "cachecloud"].includes(product_type))
      return jsonErr("유효하지 않은 상품 타입입니다.", 400);
    if (!plan || !VALID_PLANS[product_type]?.includes(plan))
      return jsonErr(`유효하지 않은 플랜입니다. (${VALID_PLANS[product_type]?.join(", ")})`, 400);
    if (!["monthly", "yearly"].includes(billing_cycle))
      return jsonErr("billing_cycle은 monthly 또는 yearly여야 합니다.", 400);

    let siteName = null;

    // 호스팅은 site_id 필수
    if (product_type === "hosting") {
      if (!site_id) return jsonErr("hosting 결제에는 site_id가 필요합니다.", 400);
      const site = await env.DB.prepare(
        "SELECT id, site_name FROM sites WHERE id = ? AND user_id = ?"
      ).bind(site_id, payload.id).first();
      if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
      siteName = site.site_name;
    }

    const amount = PLANS[product_type][plan][billing_cycle];
    const shortId = (site_id || payload.id).slice(0, 8);
    const orderId = `cp-${product_type}-${shortId}-${Date.now()}`;
    const productLabel = PRODUCT_NAMES[product_type] || product_type;
    const planLabel = { starter: "스타터", pro: "프로", enterprise: "엔터프라이즈", basic: "베이직", standard: "스탠다드" }[plan] || plan;
    const cycleLabel = billing_cycle === "monthly" ? "월간" : "연간";
    const orderName = siteName
      ? `${productLabel} ${planLabel} (${cycleLabel}) - ${siteName}`
      : `${productLabel} ${planLabel} (${cycleLabel})`;

    // 결제 레코드 생성 (pending)
    await env.DB.prepare(
      `INSERT INTO payments (id, user_id, site_id, product_type, plan, billing_cycle, amount, status, toss_order_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).bind(
      crypto.randomUUID(), payload.id, site_id || null,
      product_type, plan, billing_cycle,
      amount, orderId, new Date().toISOString()
    ).run();

    return jsonOk({
      success:        true,
      order_id:       orderId,
      amount,
      order_name:     orderName,
      product_type,
      customer_email: payload.email,
      customer_name:  payload.email.split("@")[0],
      site_name:      siteName,
    });
  }

  // ── 결제 승인 (토스 페이먼츠 서버사이드 confirm) ─────────────────────
  if (sub === "confirm") {
    const { payment_key, order_id, amount } = body;

    if (!payment_key || !order_id || !amount)
      return jsonErr("payment_key, order_id, amount 모두 필요합니다.", 400);

    // DB에서 pending 결제 확인
    const payment = await env.DB.prepare(
      "SELECT * FROM payments WHERE toss_order_id = ? AND user_id = ? AND status = 'pending'"
    ).bind(order_id, payload.id).first();

    if (!payment) return jsonErr("결제 정보를 찾을 수 없습니다.", 404);
    if (payment.amount !== parseInt(amount))
      return jsonErr("결제 금액이 일치하지 않습니다.", 400);

    // 토스 서버사이드 승인 요청
    const settings = await getSettings(env);
    const secretKey = settings.toss_secret_key || env.TOSS_SECRET_KEY || "";

    if (!secretKey) return jsonErr("결제 설정이 완료되지 않았습니다.", 503);

    const tossRes = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(secretKey + ":")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ paymentKey: payment_key, orderId: order_id, amount }),
    });

    const tossData = await tossRes.json();

    if (!tossRes.ok) {
      // 결제 실패 기록
      await env.DB.prepare(
        "UPDATE payments SET status = 'failed' WHERE toss_order_id = ?"
      ).bind(order_id).run().catch(() => {});
      return jsonErr(
        tossData.message || "결제 승인에 실패했습니다. 다시 시도해주세요.",
        tossRes.status
      );
    }

    // 만료일 계산
    const now = new Date();
    const expiresAt = new Date(now);
    if (payment.billing_cycle === "yearly") {
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    } else {
      expiresAt.setMonth(expiresAt.getMonth() + 1);
    }

    // 결제 성공 → DB 업데이트
    await env.DB.prepare(
      `UPDATE payments
       SET status = 'paid', toss_payment_key = ?, toss_receipt_url = ?, expires_at = ?
       WHERE toss_order_id = ?`
    ).bind(
      payment_key,
      tossData.receipt?.url || "",
      expiresAt.toISOString(),
      order_id
    ).run();

    const productType = payment.product_type || "hosting";
    const planLabels = { starter: "스타터", pro: "프로", enterprise: "엔터프라이즈", basic: "베이직", standard: "스탠다드" };

    // 상품 타입별 구독 처리
    if (productType === "hosting" && payment.site_id) {
      // 호스팅: 해당 사이트 플랜 업그레이드
      await env.DB.prepare(
        "UPDATE sites SET site_plan = ?, plan_expires_at = ? WHERE id = ?"
      ).bind(payment.plan, expiresAt.toISOString(), payment.site_id).run();
    } else if (["cpdb", "cp3", "cachecloud"].includes(productType)) {
      // 유료 상품: user_product_subscriptions 업데이트
      await env.DB.prepare(
        `INSERT INTO user_product_subscriptions (user_id, product_type, plan, status, expires_at, created_at)
         VALUES (?, ?, ?, 'active', ?, ?)
         ON CONFLICT(user_id, product_type) DO UPDATE SET
           plan = excluded.plan, status = 'active', expires_at = excluded.expires_at`
      ).bind(
        payment.user_id, productType, payment.plan,
        expiresAt.toISOString(), new Date().toISOString()
      ).run().catch(() => {});
    }

    return jsonOk({
      success:      true,
      message:      `${PRODUCT_NAMES[productType] || productType} ${planLabels[payment.plan] || payment.plan} 플랜이 활성화되었습니다!`,
      product_type: productType,
      plan:         payment.plan,
      expires_at:   expiresAt.toISOString(),
      receipt_url:  tossData.receipt?.url || null,
    });
  }

  // ── 빌링키 등록 확인 (토스 requestBillingAuth 완료 후) ─────────────
  if (sub === "billing-key") {
    const { auth_key, customer_key } = body;

    if (!auth_key || !customer_key)
      return jsonErr("auth_key, customer_key 모두 필요합니다.", 400);

    const settings = await getSettings(env);
    const secretKey = settings.toss_secret_key || env.TOSS_SECRET_KEY || "";

    if (!secretKey) return jsonErr("결제 설정이 완료되지 않았습니다.", 503);

    // 토스 빌링키 발급 요청
    const tossRes = await fetch(`https://api.tosspayments.com/v1/billing/authorizations/${auth_key}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(secretKey + ":")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ customerKey: customer_key }),
    });

    const tossData = await tossRes.json();

    if (!tossRes.ok) {
      return jsonErr(tossData.message || "빌링키 발급에 실패했습니다.", tossRes.status);
    }

    // 카드 정보 추출
    const card = tossData.card || {};
    const billingKey = tossData.billingKey || "";
    const brand = card.issuerCode
      ? ({"3K":"기업BC","46":"광주","71":"롯데","71M":"롯데","36":"하나","31":"비씨","51":"삼성","38":"새마을","41":"신한","62":"신협","67":"우리","21":"이베스트","61":"우리","43":"우체국","카카오":"카카오","토스":"토스","현대":"현대","NH":"농협","KB":"국민","IBK":"기업","하나":"하나"})[card.issuerCode] || card.issuerCode || "카드"
      : "카드";
    const last4 = card.number ? card.number.slice(-4) : "";
    const expMonth = card.validThru ? card.validThru.slice(0, 2) : "";
    const expYear  = card.validThru ? "20" + card.validThru.slice(3) : "";

    // payment_cards 테이블에 저장
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS payment_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        billing_key TEXT NOT NULL,
        card_name TEXT NOT NULL DEFAULT '카드',
        brand TEXT NOT NULL DEFAULT '',
        last4 TEXT NOT NULL DEFAULT '',
        exp_month TEXT NOT NULL DEFAULT '',
        exp_year TEXT NOT NULL DEFAULT '',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `).run().catch(() => {});

    const existing = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM payment_cards WHERE user_id = ?"
    ).bind(payload.id).first();
    const isDefault = (existing?.cnt || 0) === 0 ? 1 : 0;

    await env.DB.prepare(
      `INSERT INTO payment_cards (user_id, billing_key, card_name, brand, last4, exp_month, exp_year, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).bind(
      payload.id,
      billingKey,
      brand + (last4 ? " " + last4 : ""),
      brand,
      last4,
      expMonth,
      expYear,
      isDefault
    ).run();

    return jsonOk({
      success: true,
      message: "카드가 등록되었습니다.",
      card: { brand, last4 },
    });
  }

  // ── PayPal 주문 생성 ──────────────────────────────────────────────────────
  if (sub === "paypal-create") {
    const { product_type = "hosting", site_id, plan, billing_cycle = "monthly" } = body;

    if (!["hosting", "cpdb", "cp3", "cachecloud"].includes(product_type))
      return jsonErr("유효하지 않은 상품 타입입니다.", 400);
    if (!plan || !VALID_PLANS[product_type]?.includes(plan))
      return jsonErr(`유효하지 않은 플랜입니다.`, 400);

    const settings = await getSettings(env);
    const clientId = settings.paypal_client_id || env.PAYPAL_CLIENT_ID || "";
    const secret   = settings.paypal_secret     || env.PAYPAL_SECRET     || "";
    const sandbox  = settings.paypal_sandbox !== "false";

    if (!clientId || !secret) return jsonErr("PayPal 설정이 완료되지 않았습니다.", 503);

    const amount = PLANS[product_type][plan][billing_cycle];
    // PayPal은 USD 단위 (원화 → USD 변환: 1USD ≈ 1350원)
    const amountUsd = (amount / 1350).toFixed(2);

    const baseUrl = sandbox
      ? "https://api-m.sandbox.paypal.com"
      : "https://api-m.paypal.com";

    // Access Token 획득
    const tokenRes = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(clientId + ":" + secret)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) return jsonErr("PayPal 인증 실패: " + (tokenData.error_description || ""), 503);

    const accessToken = tokenData.access_token;
    const orderId = `cp-pp-${(site_id || payload.id).slice(0, 8)}-${Date.now()}`;
    const productLabel = PRODUCT_NAMES[product_type] || product_type;
    const planLabel = { starter: "스타터", pro: "프로", enterprise: "엔터프라이즈", basic: "베이직", standard: "스탠다드" }[plan] || plan;

    // PayPal 주문 생성
    const orderRes = await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: orderId,
          description: `${productLabel} ${planLabel} (${billing_cycle === "monthly" ? "월간" : "연간"})`,
          amount: { currency_code: "USD", value: amountUsd },
        }],
        application_context: {
          brand_name: "CloudPress",
          locale: "ko-KR",
          user_action: "PAY_NOW",
        },
      }),
    });
    const orderData = await orderRes.json();
    if (!orderRes.ok) return jsonErr("PayPal 주문 생성 실패: " + (orderData.message || ""), 502);

    // DB에 pending 결제 저장
    await env.DB.prepare(
      `INSERT INTO payments (id, user_id, site_id, product_type, plan, billing_cycle, amount, status, toss_order_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).bind(
      crypto.randomUUID(), payload.id, site_id || null,
      product_type, plan, billing_cycle,
      amount, `paypal:${orderData.id}`, new Date().toISOString()
    ).run();

    return jsonOk({
      success: true,
      paypalOrderId: orderData.id,
      approveUrl: orderData.links?.find(l => l.rel === "approve")?.href,
      orderId,
      amount,
      amountUsd,
    });
  }

  // ── PayPal 결제 캡처 (승인 완료 후) ──────────────────────────────────────
  if (sub === "paypal-capture") {
    const { paypal_order_id } = body;
    if (!paypal_order_id) return jsonErr("paypal_order_id가 필요합니다.", 400);

    const settings = await getSettings(env);
    const clientId = settings.paypal_client_id || env.PAYPAL_CLIENT_ID || "";
    const secret   = settings.paypal_secret     || env.PAYPAL_SECRET     || "";
    const sandbox  = settings.paypal_sandbox !== "false";

    if (!clientId || !secret) return jsonErr("PayPal 설정이 완료되지 않았습니다.", 503);

    const baseUrl = sandbox
      ? "https://api-m.sandbox.paypal.com"
      : "https://api-m.paypal.com";

    // Access Token 재획득
    const tokenRes = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(clientId + ":" + secret)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) return jsonErr("PayPal 인증 실패", 503);

    // 결제 캡처
    const captureRes = await fetch(`${baseUrl}/v2/checkout/orders/${paypal_order_id}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
      },
    });
    const captureData = await captureRes.json();

    if (!captureRes.ok || captureData.status !== "COMPLETED") {
      await env.DB.prepare(
        "UPDATE payments SET status = 'failed' WHERE toss_order_id = ?"
      ).bind(`paypal:${paypal_order_id}`).run().catch(() => {});
      return jsonErr("PayPal 결제 실패: " + (captureData.message || captureData.status || ""), 402);
    }

    // DB에서 해당 결제 정보 조회
    const payment = await env.DB.prepare(
      "SELECT * FROM payments WHERE toss_order_id = ? AND user_id = ? AND status = 'pending'"
    ).bind(`paypal:${paypal_order_id}`, payload.id).first();

    if (!payment) return jsonErr("결제 정보를 찾을 수 없습니다.", 404);

    // 만료일 계산
    const now = new Date();
    const expiresAt = new Date(now);
    if (payment.billing_cycle === "yearly") expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    else expiresAt.setMonth(expiresAt.getMonth() + 1);

    // 결제 성공 → DB 업데이트
    await env.DB.prepare(
      `UPDATE payments SET status = 'paid', toss_payment_key = ?, expires_at = ? WHERE toss_order_id = ?`
    ).bind(
      `paypal:${paypal_order_id}:captured`,
      expiresAt.toISOString(),
      `paypal:${paypal_order_id}`
    ).run();

    const productType = payment.product_type || "hosting";
    // 구독 업데이트
    if (productType === "hosting" && payment.site_id) {
      await env.DB.prepare(
        "UPDATE sites SET site_plan = ?, plan_expires_at = ? WHERE id = ?"
      ).bind(payment.plan, expiresAt.toISOString(), payment.site_id).run();
    } else if (["cpdb", "cp3", "cachecloud"].includes(productType)) {
      await env.DB.prepare(
        `INSERT INTO user_product_subscriptions (user_id, product_type, plan, status, expires_at, created_at)
         VALUES (?, ?, ?, 'active', ?, ?)
         ON CONFLICT(user_id, product_type) DO UPDATE SET
           plan = excluded.plan, status = 'active', expires_at = excluded.expires_at`
      ).bind(
        payment.user_id, productType, payment.plan,
        expiresAt.toISOString(), new Date().toISOString()
      ).run().catch(() => {});
    }

    const planLabels = { starter: "스타터", pro: "프로", enterprise: "엔터프라이즈", basic: "베이직", standard: "스탠다드" };
    return jsonOk({
      success: true,
      message: `${PRODUCT_NAMES[productType] || productType} ${planLabels[payment.plan] || payment.plan} 플랜이 활성화되었습니다! (PayPal)`,
      product_type: productType,
      plan: payment.plan,
      expires_at: expiresAt.toISOString(),
      paypal_order_id,
    });
  }

  return jsonErr("알 수 없는 경로", 404);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
