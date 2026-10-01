export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    try {

      // -----------------------------
      // دریافت اطلاعات آزمون
      // -----------------------------
      if (
        url.pathname === "/api/exam" &&
        request.method === "GET"
      ) {
        const examId = Number(
          url.searchParams.get("id") || 1
        );

        const exam = await env.DB
          .prepare(`
            SELECT id, title, price, duration_seconds
            FROM exams
            WHERE id = ? AND active = 1
          `)
          .bind(examId)
          .first();

        if (!exam) {
          return json(
            { error: "آزمون پیدا نشد" },
            404,
            cors
          );
        }

        const { results } = await env.DB
          .prepare(`
            SELECT
              id,
              question_text,
              option_a,
              option_b,
              option_c,
              option_d
            FROM questions
            WHERE exam_id = ?
            ORDER BY id
          `)
          .bind(examId)
          .all();

        return json(
          {
            exam,
            questions: results
          },
          200,
          cors
        );
      }


      // -----------------------------
      // ایجاد سفارش
      // -----------------------------
      if (
        url.pathname === "/api/create-order" &&
        request.method === "POST"
      ) {
        const body = await request.json();

        const name = String(
          body.name || ""
        ).trim();

        let phone = String(
          body.phone || ""
        ).trim();

        const examId = Number(
          body.examId || 1
        );

        // تبدیل اعداد فارسی به انگلیسی
        phone = phone
          .replace(/[۰-۹]/g, d =>
            "۰۱۲۳۴۵۶۷۸۹".indexOf(d)
          )
          .replace(/[٠-٩]/g, d =>
            "٠١٢٣٤٥٦٧٨٩".indexOf(d)
          );

        if (!name) {
          return json(
            {
              error:
                "نام و نام خانوادگی را وارد کنید"
            },
            400,
            cors
          );
        }

        if (!/^09\d{9}$/.test(phone)) {
          return json(
            {
              error:
                "شماره موبایل باید 11 رقم باشد"
            },
            400,
            cors
          );
        }

        const exam = await env.DB
          .prepare(`
            SELECT id, price
            FROM exams
            WHERE id = ? AND active = 1
          `)
          .bind(examId)
          .first();

        if (!exam) {
          return json(
            { error: "آزمون نامعتبر است" },
            404,
            cors
          );
        }

        const orderId =
          crypto.randomUUID();

        const now =
          new Date().toISOString();

        await env.DB
          .prepare(`
            INSERT INTO orders
            (
              id,
              exam_id,
              name,
              phone,
              amount,
              status,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            orderId,
            exam.id,
            name,
            phone,
            exam.price,
            "pending",
            now
          )
          .run();

        return json(
          {
            orderId,
            amount: exam.price,
            status: "pending"
          },
          200,
          cors
        );
      }


      // -----------------------------
      // پرداخت آزمایشی
      // -----------------------------
      if (
        url.pathname === "/api/demo-pay" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const orderId =
          String(body.orderId || "");

        const order = await env.DB
          .prepare(`
            SELECT id
            FROM orders
            WHERE id = ?
            AND status = 'pending'
          `)
          .bind(orderId)
          .first();

        if (!order) {
          return json(
            {
              error:
                "سفارش معتبر نیست"
            },
            404,
            cors
          );
        }

        await env.DB
          .prepare(`
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

        return json(
          {
            paid: true,
            orderId
          },
          200,
          cors
        );
      }


      // -----------------------------
      // شروع آزمون
      // -----------------------------
      if (
        url.pathname === "/api/start" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const orderId =
          String(body.orderId || "");

        const order = await env.DB
          .prepare(`
            SELECT id
            FROM orders
            WHERE id = ?
            AND status = 'paid'
          `)
          .bind(orderId)
          .first();

        if (!order) {
          return json(
            {
              error:
                "پرداخت تأیید نشده است"
            },
            403,
            cors
          );
        }

        const existing =
          await env.DB
            .prepare(`
              SELECT id
              FROM attempts
              WHERE order_id = ?
              AND finished_at IS NULL
            `)
            .bind(orderId)
            .first();

        if (existing) {
          return json(
            {
              attemptId: existing.id
            },
            200,
            cors
          );
        }

        const attemptId =
          crypto.randomUUID();

        await env.DB
          .prepare(`
            INSERT INTO attempts
            (
              id,
              order_id,
              started_at
            )
            VALUES (?, ?, ?)
          `)
          .bind(
            attemptId,
            orderId,
            new Date().toISOString()
          )
          .run();

        return json(
          {
            attemptId
          },
          200,
          cors
        );
      }


      // -----------------------------
      // ثبت و محاسبه نتیجه آزمون
      // -----------------------------
      if (
        url.pathname === "/api/submit" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const attemptId =
          String(body.attemptId || "");

        const answers =
          Array.isArray(body.answers)
            ? body.answers
            : [];

        const attempt =
          await env.DB
            .prepare(`
              SELECT
                a.id,
                o.exam_id
              FROM attempts a
              JOIN orders o
                ON o.id = a.order_id
              WHERE a.id = ?
              AND a.finished_at IS NULL
            `)
            .bind(attemptId)
            .first();

        if (!attempt) {
          return json(
            {
              error:
                "آزمون معتبر نیست یا قبلاً پایان یافته"
            },
            403,
            cors
          );
        }

        // جواب صحیح فقط روی سرور خوانده می‌شود
        const { results: questions } =
          await env.DB
            .prepare(`
              SELECT
                id,
                correct_index
              FROM questions
              WHERE exam_id = ?
              ORDER BY id
            `)
            .bind(attempt.exam_id)
            .all();

        let correct = 0;
        let wrong = 0;
        let empty = 0;

        const sheet = [];

        for (
          let i = 0;
          i < questions.length;
          i++
        ) {
          const selected =
            Number.isInteger(answers[i])
              ? answers[i]
              : -1;

          const correctAnswer =
            questions[i].correct_index;

          let status;

          if (selected === -1) {
            empty++;
            status = "empty";
          }
          else if (
            selected === correctAnswer
          ) {
            correct++;
            status = "correct";
          }
          else {
            wrong++;
            status = "wrong";
          }

          sheet.push({
            question: i + 1,
            selected,
            correct: correctAnswer,
            status
          });
        }

        const total =
          questions.length;

        const score =
          total > 0
            ? Math.round(
                (correct / total) *
                10000
              ) / 100
            : 0;

        await env.DB
          .prepare(`
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
            new Date().toISOString(),
            score,
            correct,
            wrong,
            empty,
            attemptId
          )
          .run();

        return json(
          {
            score,
            correct,
            wrong,
            empty,
            total,
            sheet
          },
          200,
          cors
        );
      }


      // -----------------------------
      // مسیر نامعتبر
      // -----------------------------
      return json(
        {
          error: "مسیر پیدا نشد"
        },
        404,
        cors
      );

    } catch (error) {

      return json(
        {
          error: "خطای سرور",
          detail: String(
            error.message || error
          )
        },
        500,
        cors
      );
    }
  }
};


// ارسال JSON
function json(
  data,
  status = 200,
  cors = {}
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=UTF-8",
        ...cors
      }
    }
  );
}
