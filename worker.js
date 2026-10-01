export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders()
      });
    }

    try {

      // =====================================================
      // دریافت آزمون
      // =====================================================
      if (
        request.method === "GET" &&
        url.pathname === "/api/exam"
      ) {
        const examId = Number(
          url.searchParams.get("id") || 1
        );

        const exam = await env.DB.prepare(`
          SELECT
            id,
            title,
            price,
            duration_seconds
          FROM exams
          WHERE id = ?
            AND active = 1
        `)
          .bind(examId)
          .first();

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
        `)
          .bind(examId)
          .all();

        return json({
          ok: true,
          exam,
          questions: questions.results || []
        });
      }


      // =====================================================
      // ایجاد سفارش
      // =====================================================
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
          SELECT
            id,
            title,
            price
          FROM exams
          WHERE id = ?
            AND active = 1
        `)
          .bind(examId)
          .first();

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
        `)
          .bind(
            orderId,
            exam.id,
            name,
            phone,
            exam.price,
            new Date().toISOString()
          )
          .run();

        return json({
          ok: true,
          orderId,
          amount: exam.price,
          examTitle: exam.title
        });
      }


      // =====================================================
      // پرداخت آزمایشی
      // =====================================================
      if (
        request.method === "POST" &&
        url.pathname === "/api/demo-pay"
      ) {
        const body = await request.json();

        const orderId = String(
          body.orderId || ""
        );

        if (!orderId) {
          return json({
            ok: false,
            error: "شناسه سفارش ارسال نشده."
          }, 400);
        }

        const order = await env.DB.prepare(`
          SELECT
            id,
            status
          FROM orders
          WHERE id = ?
        `)
          .bind(orderId)
          .first();

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
        `)
          .bind(
            new Date().toISOString(),
            orderId
          )
          .run();

        return json({
          ok: true,
          paid: true,
          message: "پرداخت آزمایشی با موفقیت انجام شد."
        });
      }


      // =====================================================
      // شروع آزمون
      // =====================================================
      if (
        request.method === "POST" &&
        url.pathname === "/api/start"
      ) {
        const body = await request.json();

        const orderId = String(
          body.orderId || ""
        );

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
        `)
          .bind(orderId)
          .first();

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

        // اگر قبلاً آزمون شروع شده، همان آزمون را برگردان
        const existing = await env.DB.prepare(`
          SELECT
            id,
            started_at,
            current_question,
            question_started_at,
            finished_at
          FROM attempts
          WHERE order_id = ?
          ORDER BY started_at DESC
          LIMIT 1
        `)
          .bind(orderId)
          .first();

        if (existing) {

          if (existing.finished_at) {
            return json({
              ok: false,
              error: "این آزمون قبلاً به پایان رسیده است."
            }, 400);
          }

          const currentIndex =
            Number(existing.current_question || 0);

          const currentQuestion = await getQuestion(
            env,
            order.exam_id,
            currentIndex
          );

          if (!currentQuestion) {
            return json({
              ok: false,
              error: "سؤال فعلی پیدا نشد."
            }, 400);
          }

          return json({
            ok: true,
            attemptId: existing.id,
            startedAt: existing.started_at,
            currentQuestion: currentIndex,
            questionStartedAt:
              existing.question_started_at,
            alreadyStarted: true,
            question: publicQuestion(currentQuestion)
          });
        }

        const firstQuestion = await getQuestion(
          env,
          order.exam_id,
          0
        );

        if (!firstQuestion) {
          return json({
            ok: false,
            error: "برای این آزمون سؤال ثبت نشده."
          }, 400);
        }

        const attemptId = crypto.randomUUID();

        const startedAt =
          new Date().toISOString();

        await env.DB.prepare(`
          INSERT INTO attempts (
            id,
            order_id,
            started_at,
            current_question,
            question_started_at
          )
          VALUES (?, ?, ?, 0, ?)
        `)
          .bind(
            attemptId,
            orderId,
            startedAt,
            startedAt
          )
          .run();

        return json({
          ok: true,
          attemptId,
          startedAt,
          currentQuestion: 0,
          questionStartedAt: startedAt,
          alreadyStarted: false,
          question: publicQuestion(firstQuestion)
        });
      }


      // =====================================================
      // ثبت پاسخ یک سؤال
      // =====================================================
      if (
        request.method === "POST" &&
        url.pathname === "/api/answer"
      ) {
        const body = await request.json();

        const attemptId = String(
          body.attemptId || ""
        );

        const questionIndex =
          Number(body.questionIndex);

        let selectedIndex = null;

        if (
          body.selectedIndex !== null &&
          body.selectedIndex !== undefined &&
          body.selectedIndex !== ""
        ) {
          selectedIndex =
            Number(body.selectedIndex);
        }

        if (!attemptId) {
          return json({
            ok: false,
            error: "شناسه آزمون ارسال نشده."
          }, 400);
        }

        if (
          !Number.isInteger(questionIndex) ||
          questionIndex < 0
        ) {
          return json({
            ok: false,
            error: "شماره سؤال نامعتبر است."
          }, 400);
        }

        if (
          selectedIndex !== null &&
          (
            !Number.isInteger(selectedIndex) ||
            selectedIndex < 0 ||
            selectedIndex > 3
          )
        ) {
          return json({
            ok: false,
            error: "گزینه انتخابی نامعتبر است."
          }, 400);
        }

        const attempt = await env.DB.prepare(`
          SELECT
            a.id,
            a.order_id,
            a.started_at,
            a.finished_at,
            a.current_question,
            a.question_started_at,
            o.exam_id,
            o.status
          FROM attempts a
          JOIN orders o
            ON o.id = a.order_id
          WHERE a.id = ?
        `)
          .bind(attemptId)
          .first();

        if (!attempt) {
          return json({
            ok: false,
            error: "آزمون پیدا نشد."
          }, 404);
        }

        if (attempt.status !== "paid") {
          return json({
            ok: false,
            error: "پرداخت تأیید نشده است."
          }, 403);
        }

        if (attempt.finished_at) {
          return json({
            ok: false,
            error: "آزمون قبلاً به پایان رسیده است."
          }, 400);
        }

        // جلوگیری از پاسخ دادن به سؤال قبلی یا بعدی
        if (
          Number(attempt.current_question) !==
          questionIndex
        ) {
          return json({
            ok: false,
            error: "این سؤال دیگر قابل پاسخ‌گویی نیست."
          }, 409);
        }

        const question = await getQuestion(
          env,
          attempt.exam_id,
          questionIndex
        );

        if (!question) {
          return json({
            ok: false,
            error: "سؤال پیدا نشد."
          }, 404);
        }

        const now = new Date();

        const questionStarted =
          new Date(
            attempt.question_started_at
          );

        const elapsedSeconds =
          (now.getTime() -
            questionStarted.getTime()) / 1000;

        const duration =
          Number(question.duration_seconds || 30);

        // اگر زمان تمام شده باشد، پاسخ کاربر نادیده گرفته می‌شود
        if (elapsedSeconds > duration) {
          selectedIndex = null;
        }

        // ثبت پاسخ
        await env.DB.prepare(`
          INSERT INTO attempt_answers (
            attempt_id,
            question_index,
            selected_index,
            answered_at
          )
          VALUES (?, ?, ?, ?)
        `)
          .bind(
            attemptId,
            questionIndex,
            selectedIndex,
            now.toISOString()
          )
          .run();

        const nextIndex =
          questionIndex + 1;

        const nextQuestion =
          await getQuestion(
            env,
            attempt.exam_id,
            nextIndex
          );

        // اگر سؤال دیگری وجود دارد
        if (nextQuestion) {

          await env.DB.prepare(`
            UPDATE attempts
            SET
              current_question = ?,
              question_started_at = ?
            WHERE id = ?
          `)
            .bind(
              nextIndex,
              now.toISOString(),
              attemptId
            )
            .run();

          return json({
            ok: true,
            finished: false,
            timedOut:
              elapsedSeconds > duration,
            currentQuestion: nextIndex,
            questionStartedAt:
              now.toISOString(),
            question:
              publicQuestion(nextQuestion)
          });
        }

        // اگر سؤال آخر بوده
        await env.DB.prepare(`
          UPDATE attempts
          SET
            current_question = ?,
            question_started_at = NULL
          WHERE id = ?
        `)
          .bind(
            nextIndex,
            attemptId
          )
          .run();

        return json({
          ok: true,
          finished: true,
          timedOut:
            elapsedSeconds > duration
        });
      }


      // =====================================================
      // پایان و محاسبه نتیجه
      // =====================================================
      if (
        request.method === "POST" &&
        url.pathname === "/api/submit"
      ) {
        const body = await request.json();

        const attemptId = String(
          body.attemptId || ""
        );

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
        `)
          .bind(attemptId)
          .first();

        if (!attempt) {
          return json({
            ok: false,
            error: "آزمون پیدا نشد."
          }, 404);
        }

        if (attempt.status !== "paid") {
          return json({
            ok: false,
            error: "پرداخت تأیید نشده است."
          }, 403);
        }

        if (attempt.finished_at) {

          return await buildResult(
            env,
            attemptId
          );
        }

        const questions = await env.DB.prepare(`
          SELECT
            id,
            question_text,
            option_a,
            option_b,
            option_c,
            option_d,
            correct_index
          FROM questions
          WHERE exam_id = ?
          ORDER BY id
        `)
          .bind(attempt.exam_id)
          .all();

        const rows =
          questions.results || [];

        const answers = await env.DB.prepare(`
          SELECT
            question_index,
            selected_index
          FROM attempt_answers
          WHERE attempt_id = ?
          ORDER BY question_index
        `)
          .bind(attemptId)
          .all();

        const answerRows =
          answers.results || [];

        let correct = 0;
        let wrong = 0;
        let empty = 0;

        const answerMap = {};

        for (const a of answerRows) {
          answerMap[
            Number(a.question_index)
          ] = a.selected_index === null
            ? null
            : Number(a.selected_index);
        }

        const sheet = [];

        for (
          let i = 0;
          i < rows.length;
          i++
        ) {

          const q = rows[i];

          const selected =
            Object.prototype.hasOwnProperty.call(
              answerMap,
              i
            )
              ? answerMap[i]
              : null;

          if (selected === null) {
            empty++;
          } else if (
            selected === Number(q.correct_index)
          ) {
            correct++;
          } else {
            wrong++;
          }

          sheet.push({
            number: i + 1,
            question: q.question_text,
            selected,
            correct:
              Number(q.correct_index),
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
          ? Number(
              (
                (correct / total) * 100
              ).toFixed(2)
            )
          : 0;

        const finishedAt =
          new Date().toISOString();

        await env.DB.prepare(`
          UPDATE attempts
          SET
            finished_at = ?,
            score = ?,
            correct_count = ?,
            wrong_count = ?,
            empty_count = ?
          WHERE id = ?
        `)
          .bind(
            finishedAt,
            score,
            correct,
            wrong,
            empty,
            attemptId
          )
          .run();

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


      // =====================================================
      // فایل‌های سایت
      // =====================================================
      if (!url.pathname.startsWith("/api/")) {
        return env.ASSETS.fetch(request);
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
        detail:
          error?.message ||
          String(error)
      }, 500);
    }
  }
};


// =====================================================
// توابع کمکی
// =====================================================

async function getQuestion(
  env,
  examId,
  questionIndex
) {

  return await env.DB.prepare(`
    SELECT
      id,
      question_text,
      option_a,
      option_b,
      option_c,
      option_d,
      duration_seconds,
      correct_index
    FROM questions
    WHERE exam_id = ?
    ORDER BY id
    LIMIT 1 OFFSET ?
  `)
    .bind(
      examId,
      questionIndex
    )
    .first();
}


function publicQuestion(q) {

  return {
    id: q.id,
    question_text:
      q.question_text,
    option_a:
      q.option_a,
    option_b:
      q.option_b,
    option_c:
      q.option_c,
    option_d:
      q.option_d,
    duration_seconds:
      Number(
        q.duration_seconds || 30
      )
  };
}


async function buildResult(
  env,
  attemptId
) {

  const attempt = await env.DB.prepare(`
    SELECT
      a.id,
      a.order_id,
      o.exam_id
    FROM attempts a
    JOIN orders o
      ON o.id = a.order_id
    WHERE a.id = ?
  `)
    .bind(attemptId)
    .first();

  const questions = await env.DB.prepare(`
    SELECT
      id,
      question_text,
      option_a,
      option_b,
      option_c,
      option_d,
      correct_index
    FROM questions
    WHERE exam_id = ?
    ORDER BY id
  `)
    .bind(attempt.exam_id)
    .all();

  const answers = await env.DB.prepare(`
    SELECT
      question_index,
      selected_index
    FROM attempt_answers
    WHERE attempt_id = ?
    ORDER BY question_index
  `)
    .bind(attemptId)
    .all();

  const rows =
    questions.results || [];

  const answerRows =
    answers.results || [];

  const answerMap = {};

  for (const a of answerRows) {
    answerMap[
      Number(a.question_index)
    ] =
      a.selected_index === null
        ? null
        : Number(a.selected_index);
  }

  let correct = 0;
  let wrong = 0;
  let empty = 0;

  const sheet = [];

  for (
    let i = 0;
    i < rows.length;
    i++
  ) {

    const q = rows[i];

    const selected =
      Object.prototype.hasOwnProperty.call(
        answerMap,
        i
      )
        ? answerMap[i]
        : null;

    if (selected === null) {
      empty++;
    } else if (
      selected === Number(q.correct_index)
    ) {
      correct++;
    } else {
      wrong++;
    }

    sheet.push({
      number: i + 1,
      question:
        q.question_text,
      selected,
      correct:
        Number(q.correct_index),
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
    ? Number(
        (
          (correct / total) *
          100
        ).toFixed(2)
      )
    : 0;

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


function corsHeaders() {

  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type",
    "Content-Type":
      "application/json; charset=utf-8"
  };
}


function json(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers:
        corsHeaders()
    }
  );
}


function normalizePhone(value) {

  let phone =
    String(value || "");

  const persian =
    "۰۱۲۳۴۵۶۷۸۹";

  const arabic =
    "٠١٢٣٤٥٦٧٨٩";

  phone =
    phone.replace(
      /[۰-۹]/g,
      d =>
        String(
          persian.indexOf(d)
        )
    );

  phone =
    phone.replace(
      /[٠-٩]/g,
      d =>
        String(
          arabic.indexOf(d)
        )
    );

  phone =
    phone.replace(
      /\D/g,
      ""
    );

  if (
    phone.startsWith("0098")
  ) {
    phone =
      "0" +
      phone.substring(4);
  }

  if (
    phone.startsWith("98")
  ) {
    phone =
      "0" +
      phone.substring(2);
  }

  return phone.substring(
    0,
    11
  );
}
