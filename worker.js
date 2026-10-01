export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders()
      });
    }

    try {
      // -----------------------------
      // GET EXAM
      // -----------------------------
      if (request.method === "GET" && url.pathname === "/api/exam") {
        const examId = Number(url.searchParams.get("id") || 1);

        const exam = await env.DB.prepare(`
          SELECT
            id,
            title,
            price,
            duration_seconds
          FROM exams
          WHERE id = ?
            AND active = 1
        `).bind(examId).first();

        if (!exam) {
          return json({
            ok: false,
            error: "آزمون پیدا نشد."
          }, 404);
        }

        const questions = await env.DB.prepare(`
          SELECT
            id,
            question_text,
            option_a,
            option_b,
            option_c,
            option_d,
            duration_seconds
          FROM questions
          WHERE exam_id = ?
          ORDER BY id
        `).bind(examId).all();

        return json({
          ok: true,
          exam,
          questions: questions.results || []
        });
      }

      // -----------------------------
      // CREATE ORDER
      // -----------------------------
      if (
        request.method === "POST" &&
        url.pathname === "/api/create-order"
      ) {
        const body = await request.json();

        const examId = Number(body.examId);
        const name = String(body.name || "").trim();
        const phone = normalizePhone(body.phone);

        if (!examId || !name || !phone) {
          return json({
            ok: false,
            error: "اطلاعات ناقص است."
          }, 400);
        }

        if (!/^09\d{9}$/.test(phone)) {
          return json({
            ok: false,
            error: "شماره موبایل صحیح نیست."
          }, 400);
        }

        const exam = await env.DB.prepare(`
          SELECT id, title, price
          FROM exams
          WHERE id = ?
            AND active = 1
        `).bind(examId).first();

        if (!exam) {
          return json({
            ok: false,
            error: "آزمون پیدا نشد."
          }, 404);
        }

        const orderId = crypto.randomUUID();

        await env.DB.prepare(`
          INSERT INTO orders (
            id,
            exam_id,
            name,
            phone,
            amount,
            status,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, 'pending', ?)
        `).bind(
          orderId,
          exam.id,
          name,
          phone,
          exam.price,
          new Date().toISOString()
        ).run();

        return json({
          ok: true,
          orderId,
          amount: exam.price,
          examTitle: exam.title
        });
      }

      // -----------------------------
      // DEMO PAYMENT
      // -----------------------------
      if (
        request.method === "POST" &&
        url.pathname === "/api/demo-pay"
      ) {
        const body = await request.json();
        const orderId = String(body.orderId || "");

        if (!orderId) {
          return json({
            ok: false,
            error: "شناسه سفارش ارسال نشده."
          }, 400);
        }

        const order = await env.DB.prepare(`
          SELECT id, status
          FROM orders
          WHERE id = ?
        `).bind(orderId).first();

        if (!order) {
          return json({
            ok: false,
            error: "سفارش پیدا نشد."
          }, 404);
        }

        await env.DB.prepare(`
          UPDATE orders
          SET
            status = 'paid',
            paid_at = ?
          WHERE id = ?
        `).bind(
          new Date().toISOString(),
          orderId
        ).run();

        return json({
          ok: true,
          paid: true,
          message: "پرداخت آزمایشی با موفقیت انجام شد."
        });
      }

      // -----------------------------
      // START EXAM
      // -----------------------------
      if (
        request.method === "POST" &&
        url.pathname === "/api/start"
      ) {
        const body = await request.json();

        const orderId = String(body.orderId || "");

        if (!orderId) {
          return json({
            ok: false,
            error: "شناسه سفارش ارسال نشده."
          }, 400);
        }

        const order = await env.DB.prepare(`
          SELECT
            id,
            exam_id,
            status
          FROM orders
          WHERE id = ?
        `).bind(orderId).first();

        if (!order) {
          return json({
            ok: false,
            error: "سفارش پیدا نشد."
          }, 404);
        }

        if (order.status !== "paid") {
          return json({
            ok: false,
            error: "ابتدا باید پرداخت انجام شود."
          }, 403);
        }

        // جلوگیری از ساخت چند attempt برای یک سفارش
        const existing = await env.DB.prepare(`
          SELECT
            id,
            started_at
          FROM attempts
          WHERE order_id = ?
          ORDER BY started_at DESC
          LIMIT 1
        `).bind(orderId).first();

        if (existing) {
          return json({
            ok: true,
            attemptId: existing.id,
            startedAt: existing.started_at,
            alreadyStarted: true
          });
        }

        const firstQuestion = await env.DB.prepare(`
          SELECT
            id,
            duration_seconds
          FROM questions
          WHERE exam_id = ?
          ORDER BY id
          LIMIT 1
        `).bind(order.exam_id).first();

        if (!firstQuestion) {
          return json({
            ok: false,
            error: "برای این آزمون سؤال ثبت نشده."
          }, 400);
        }

        const attemptId = crypto.randomUUID();
        const startedAt = new Date().toISOString();

        await env.DB.prepare(`
          INSERT INTO attempts (
            id,
            order_id,
            started_at
          )
          VALUES (?, ?, ?)
        `).bind(
          attemptId,
          orderId,
          startedAt
        ).run();

        return json({
          ok: true,
          attemptId,
          startedAt,
          questionDuration: firstQuestion.duration_seconds || 30
        });
      }

      // -----------------------------
      // SUBMIT EXAM
      // -----------------------------
      if (
        request.method === "POST" &&
        url.pathname === "/api/submit"
      ) {
        const body = await request.json();

        const attemptId = String(body.attemptId || "");
        const answers = Array.isArray(body.answers)
          ? body.answers
          : [];

        if (!attemptId) {
          return json({
            ok: false,
            error: "شناسه آزمون ارسال نشده."
          }, 400);
        }

        const attempt = await env.DB.prepare(`
          SELECT
            a.id,
            a.order_id,
            a.started_at,
            a.finished_at,
            o.exam_id,
            o.status
          FROM attempts a
          JOIN orders o
            ON o.id = a.order_id
          WHERE a.id = ?
        `).bind(attemptId).first();

        if (!attempt) {
          return json({
            ok: false,
            error: "آزمون پیدا نشد."
          }, 404);
        }

        if (attempt.status !== "paid") {
          return json({
            ok: false,
            error: "پرداخت این آزمون تأیید نشده."
          }, 403);
        }

        if (attempt.finished_at) {
          return json({
            ok: false,
            error: "این آزمون قبلاً ثبت شده است."
          }, 400);
        }

        const questions = await env.DB.prepare(`
          SELECT
            id,
            question_text,
            option_a,
            option_b,
            option_c,
            option_d,
            correct_index,
            duration_seconds
          FROM questions
          WHERE exam_id = ?
          ORDER BY id
        `).bind(attempt.exam_id).all();

        const rows = questions.results || [];

        let correct = 0;
        let wrong = 0;
        let empty = 0;

        const sheet = [];

        for (let i = 0; i < rows.length; i++) {
          const q = rows[i];

          let selected = null;

          if (
            answers[i] !== undefined &&
            answers[i] !== null &&
            answers[i] !== ""
          ) {
            selected = Number(answers[i]);
          }

          if (selected === null || Number.isNaN(selected)) {
            empty++;
          } else if (selected === Number(q.correct_index)) {
            correct++;
          } else {
            wrong++;
          }

          sheet.push({
            number: i + 1,
            question: q.question_text,
            selected,
            correct: Number(q.correct_index),
            options: [
              q.option_a,
              q.option_b,
              q.option_c,
              q.option_d
            ]
          });
        }

        const total = rows.length;

        const score = total > 0
          ? Number(((correct / total) * 100).toFixed(2))
          : 0;

        const finishedAt = new Date().toISOString();

        await env.DB.prepare(`
          UPDATE attempts
          SET
            finished_at = ?,
            score = ?,
            correct_count = ?,
            wrong_count = ?,
            empty_count = ?
          WHERE id = ?
        `).bind(
          finishedAt,
          score,
          correct,
          wrong,
          empty,
          attemptId
        ).run();

        return json({
          ok: true,
          result: {
            total,
            correct,
            wrong,
            empty,
            score
          },
          sheet
        });
      }

      // -----------------------------
      // HEALTH CHECK
      // -----------------------------
      if (
        request.method === "GET" &&
        url.pathname === "/"
      ) {
        return json({
          ok: true,
          message: "Math Exam Worker is running."
        });
      }

      return json({
        ok: false,
        error: "مسیر درخواست پیدا نشد."
      }, 404);

    } catch (error) {
      console.error(error);

      return json({
        ok: false,
        error: "خطای داخلی سرور.",
        detail: error?.message || String(error)
      }, 500);
    }
  }
};


// =====================================
// HELPERS
// =====================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8"
  };
}


function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: corsHeaders()
    }
  );
}


function normalizePhone(value) {
  let phone = String(value || "");

  const persian = "۰۱۲۳۴۵۶۷۸۹";
  const arabic = "٠١٢٣٤٥٦٧٨٩";

  phone = phone.replace(/[۰-۹]/g, d => {
    return String(persian.indexOf(d));
  });

  phone = phone.replace(/[٠-٩]/g, d => {
    return String(arabic.indexOf(d));
  });

  phone = phone.replace(/\D/g, "");

  if (phone.startsWith("98")) {
    phone = "0" + phone.substring(2);
  }

  if (phone.startsWith("0098")) {
    phone = "0" + phone.substring(4);
  }

  return phone.substring(0, 11);
}
