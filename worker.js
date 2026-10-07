export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = getCorsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {

      // ===== POST /api/teacher/login =====
      if (request.method === "POST" && url.pathname === "/api/teacher/login") {
        const body = await request.json().catch(() => ({}));
        const username = String(body.username || "").trim();
        const password = String(body.password || "");
        const expectedUser = String(env.TEACHER_USERNAME || "");
        const expectedPass = String(env.TEACHER_PASSWORD || "");

        if (!expectedUser || !expectedPass || username !== expectedUser || password !== expectedPass) {
          return json({ ok: false, error: "نام کاربری یا رمز عبور اشتباه است" }, 401, cors);
        }

        const token = crypto.randomUUID() + "-" + crypto.randomUUID() + "-" + crypto.randomUUID();
        const tokenHash = await hashToken(token);
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const sessionId = crypto.randomUUID();
