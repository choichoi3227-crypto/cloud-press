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
const PLANS = {
  starter: { monthly: 9900,  yearly: 7920  },
  pro:     { monthly: 29900, yearly: 23920 },
};

// ── payments 테이블 보장 ──────────────────────────────────────────────────
async function ensureTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS payments (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      site_id       TEXT NOT NULL,
      plan          TEXT NOT NULL,
      billing_cycle TEXT NOT NULL DEFAULT 'monthly',
      amount        INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      toss_order_id TEXT UNIQUE,
      toss_payment_key TEXT,
      toss_receipt_url  TEXT,
      expires_at    TEXT,
      created_at    TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run().catch(() => {});

  // sites 테이블에 plan 컬럼 추가 (없으면)
  await db.prepare("ALTER TABLE sites ADD COLUMN site_plan TEXT DEFAULT 'free'").run().catch(() => {});
  await db.prepare("ALTER TABLE sites ADD COLUMN plan_expires_at TEXT").run().catch(() => {});
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
    const { site_id, plan, billing_cycle = "monthly" } = body;

    if (!site_id) return jsonErr("site_id가 필요합니다.", 400);
    if (!plan || !["starter", "pro"].includes(plan))
      return jsonErr("유효하지 않은 플랜입니다. (starter 또는 pro)", 400);
    if (!["monthly", "yearly"].includes(billing_cycle))
      return jsonErr("billing_cycle은 monthly 또는 yearly여야 합니다.", 400);

    // 사이트 존재 및 소유 확인
    const site = await env.DB.prepare(
      "SELECT id, site_name FROM sites WHERE id = ? AND user_id = ?"
    ).bind(site_id, payload.id).first();
    if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);

    const amount = PLANS[plan][billing_cycle];
    const orderId = `cp-${site_id.slice(0,8)}-${Date.now()}`;

    // 결제 레코드 생성 (pending)
    await env.DB.prepare(
      `INSERT INTO payments (id, user_id, site_id, plan, billing_cycle, amount, status, toss_order_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).bind(
      crypto.randomUUID(), payload.id, site_id, plan, billing_cycle,
      amount, orderId, new Date().toISOString()
    ).run();

    return jsonOk({
      success:       true,
      order_id:      orderId,
      amount,
      order_name:    `CloudPress ${plan === 'starter' ? '스타터' : '프로'} 플랜 (${billing_cycle === 'monthly' ? '월간' : '연간'}) - ${site.site_name}`,
      customer_email: payload.email,
      customer_name:  payload.email.split("@")[0],
      site_name:      site.site_name,
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

    // 호스팅 플랜 업그레이드
    await env.DB.prepare(
      "UPDATE sites SET site_plan = ?, plan_expires_at = ? WHERE id = ?"
    ).bind(payment.plan, expiresAt.toISOString(), payment.site_id).run();

    return jsonOk({
      success:      true,
      message:      `${payment.plan === 'starter' ? '스타터' : '프로'} 플랜이 활성화되었습니다!`,
      plan:         payment.plan,
      expires_at:   expiresAt.toISOString(),
      receipt_url:  tossData.receipt?.url || null,
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
