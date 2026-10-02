export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // -----------------------------
    // CORS
    // -----------------------------
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors,
      });
    }

    try {

      // =========================================================
      // GET /api/exam
      // =========================================================
      if (request.method === "GET" && url.pathname === "/api/exam") {
        const examId = Number(url.searchParams.get("id") || 1);

        const exam = await env.DB
          .prepare(`
            SELECT
              id,
              title,
              price,
              duration_seconds,
              active
            FROM exams
            WHERE id = ?
          `)
          .bind(examId)
          .first();

        if (!exam) {
          return json(
            {
              ok: false,
              error: "آزمون پیدا نشد",
            },
            404,
            cors
          );
        }

        const result = await env.DB
          .prepare(`
            SELECT
              id,
              question_text,
              option_a,
              option_b,
              option_c,
              option_d,
              correct_index,
              duration_seconds,
              folder_id,
              active
            FROM questions
            WHERE exam_id = ?
              AND active = 1
            ORDER BY id
          `)
          .bind(examId)
          .all();

        return json(
          {
            ok: true,
            exam,
            questions: result.results || [],
          },
          200,
          cors
        );
      }


      // =========================================================
      // POST /api/create-order
      // =========================================================
      if (
        request.method === "POST" &&
        url.pathname === "/api/create-order"
      ) {
        const body = await request.json();

        const name = String(body.name || "").trim();
        const phone = normalizePhone(body.phone);
        const examId = Number(body.examId || 1);

        if (!name || !phone) {
          return json(
            {
              ok: false,
              error: "نام و شماره موبایل الزامی است",
            },
            400,
            cors
          );
        }

        const exam = await env.DB
          .prepare(`
            SELECT id, price, active
            FROM exams
            WHERE id = ?
          `)
          .bind(examId)
          .first();

        if (!exam) {
          return json(
            {
              ok: false,
              error: "آزمون پیدا نشد",
            },
            404,
            cors
          );
        }

        if (!exam.active) {
          return json(
            {
              ok: false,
              error: "این آزمون فعال نیست",
            },
            400,
            cors
          );
        }

        const orderId = crypto.randomUUID();
        const createdAt = new Date().toISOString();

        await env.DB
          .prepare(`
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
            examId,
            name,
            phone,
            exam.price,
            createdAt
          )
          .run();

        return json(
          {
            ok: true,
            orderId,
            amount: exam.price,
          },
          200,
          cors
        );
      }


      // =========================================================
      // POST /api/demo-pay
      // =========================================================
      if (
        request.method === "POST" &&
        url.pathname === "/api/demo-pay"
      ) {
        const body = await request.json();

        const orderId = String(body.orderId || "").trim();

        if (!orderId) {
          return json(
            {
              ok: false,
              error: "orderId الزامی است",
            },
            400,
            cors
          );
        }

        const order = await env.DB
          .prepare(`
            SELECT id, status
            FROM orders
            WHERE id = ?
          `)
          .bind(orderId)
          .first();

        if (!order) {
          return json(
            {
              ok: false,
              error: "سفارش پیدا نشد",
            },
            404,
            cors
          );
        }

        const paidAt = new Date().toISOString();

        await env.DB
          .prepare(`
            UPDATE orders
            SET
              status = 'paid',
              paid_at = ?
            WHERE id = ?
          `)
          .bind(paidAt, orderId)
          .run();

        return json(
          {
            ok: true,
            orderId,
            status: "paid",
            paidAt,
          },
          200,
          cors
        );
      }


      // =========================================================
      // POST /api/start
      // =========================================================
      if (
        request.method === "POST" &&
        url.pathname === "/api/start"
      ) {
        const body = await request.json();

        const orderId = String(body.orderId || "").trim();

        if (!orderId) {
          return json(
            {
              ok: false,
              error: "orderId الزامی است",
            },
            400,
            cors
          );
        }

        const order = await env.DB
          .prepare(`
            SELECT *
            FROM orders
            WHERE id = ?
          `)
          .bind(orderId)
          .first();

        if (!order) {
          return json(
            {
              ok: false,
              error: "سفارش پیدا نشد",
            },
            404,
            cors
          );
        }

        if (order.status !== "paid") {
          return json(
            {
              ok: false,
              error: "ابتدا باید پرداخت انجام شود",
            },
            400,
            cors
          );
        }

        // -------------------------------------------------------
        // اگر قبلاً آزمون شروع شده
        // -------------------------------------------------------
        const existingAttempt = await env.DB
          .prepare(`
            SELECT *
            FROM attempts
            WHERE order_id = ?
            ORDER BY started_at DESC
            LIMIT 1
          `)
          .bind(orderId)
          .first();

        if (existingAttempt) {

          if (existingAttempt.finished_at) {
            return json(
              {
                ok: false,
                error: "این آزمون قبلاً تمام شده است",
              },
              400,
              cors
            );
          }

          const snapshots = await env.DB
            .prepare(`
              SELECT *
              FROM attempt_questions
              WHERE attempt_id = ?
              ORDER BY question_order
            `)
            .bind(existingAttempt.id)
            .all();

          if (snapshots.results && snapshots.results.length > 0) {

            let currentQuestion =
              Number(existingAttempt.current_question || 0);

            if (
              currentQuestion < 0 ||
              currentQuestion >= snapshots.results.length
            ) {
              currentQuestion = 0;
            }

            const current = snapshots.results[currentQuestion];

            if (!current.started_at) {
              const now = new Date().toISOString();

              await env.DB
                .prepare(`
                  UPDATE attempt_questions
                  SET started_at = ?
                  WHERE attempt_id = ?
                    AND question_order = ?
                `)
                .bind(
                  now,
                  existingAttempt.id,
                  currentQuestion
                )
                .run();

              await env.DB
                .prepare(`
                  UPDATE attempts
                  SET question_started_at = ?
                  WHERE id = ?
                `)
                .bind(
                  now,
                  existingAttempt.id
                )
                .run();

              current.started_at = now;
            }

            return json(
              {
                ok: true,
                resumed: true,
                attemptId: existingAttempt.id,
                currentQuestion,
                totalQuestions: snapshots.results.length,
                question: publicSnapshotQuestion(current),
              },
              200,
              cors
            );
          }

          // -----------------------------------------------------
          // Legacy attempt
          // -----------------------------------------------------
          const questions = await selectQuestionsForExam(
            env,
            order.exam_id
          );

          return json(
            {
              ok: true,
              resumed: true,
              attemptId: existingAttempt.id,
              currentQuestion:
                Number(existingAttempt.current_question || 0),
              totalQuestions: questions.length,
              question: publicQuestion(
                questions[
                  Number(existingAttempt.current_question || 0)
                ]
              ),
            },
            200,
            cors
          );
        }

        // -------------------------------------------------------
        // ایجاد آزمون جدید
        // -------------------------------------------------------
        const questions = await selectQuestionsForExam(
          env,
          order.exam_id
        );

        if (!questions.length) {
          return json(
            {
              ok: false,
              error: "برای این آزمون سوالی وجود ندارد",
            },
            400,
            cors
          );
        }

        const attemptId = crypto.randomUUID();
        const startedAt = new Date().toISOString();

        await env.DB
          .prepare(`
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

        const statements = [];

        for (let i = 0; i < questions.length; i++) {

          const q = questions[i];

          statements.push(
            env.DB
              .prepare(`
                INSERT INTO attempt_questions (
                  attempt_id,
                  question_id,
                  question_order,
                  question_text_snapshot,
                  option_a_snapshot,
                  option_b_snapshot,
                  option_c_snapshot,
                  option_d_snapshot,
                  correct_index_snapshot,
                  duration_seconds_snapshot,
                  started_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `)
              .bind(
                attemptId,
                q.id,
                i,
                q.question_text,
                q.option_a,
                q.option_b,
                q.option_c,
                q.option_d,
                q.correct_index,
                Number(q.duration_seconds || 30),
                i === 0 ? startedAt : null
              )
          );
        }

        if (statements.length) {
          await env.DB.batch(statements);
        }

        return json(
          {
            ok: true,
            resumed: false,
            attemptId,
            currentQuestion: 0,
            totalQuestions: questions.length,
            question: publicQuestion(questions[0]),
          },
          200,
          cors
        );
      }


      // =========================================================
      // POST /api/answer
      // =========================================================
      if (
        request.method === "POST" &&
        url.pathname === "/api/answer"
      ) {
        const body = await request.json();

        const attemptId = String(body.attemptId || "").trim();
        const questionIndex = Number(body.questionIndex);
        let selectedIndex =
          body.selectedIndex === null ||
          body.selectedIndex === undefined ||
          body.selectedIndex === ""
            ? null
            : Number(body.selectedIndex);

        if (!attemptId || !Number.isInteger(questionIndex)) {
          return json(
            {
              ok: false,
              error: "اطلاعات پاسخ ناقص است",
            },
            400,
            cors
          );
        }

        const attempt = await env.DB
          .prepare(`
            SELECT
              a.*,
              o.status AS order_status,
              o.exam_id
            FROM attempts a
            JOIN orders o
              ON o.id = a.order_id
            WHERE a.id = ?
          `)
          .bind(attemptId)
          .first();

        if (!attempt) {
          return json(
            {
              ok: false,
              error: "آزمون پیدا نشد",
            },
            404,
            cors
          );
        }

        if (attempt.order_status !== "paid") {
          return json(
            {
              ok: false,
              error: "پرداخت معتبر نیست",
            },
            400,
            cors
          );
        }

        if (attempt.finished_at) {
          return json(
            {
              ok: false,
              error: "آزمون تمام شده است",
            },
            400,
            cors
          );
        }

        const currentQuestion =
          Number(attempt.current_question || 0);

        if (questionIndex !== currentQuestion) {
          return json(
            {
              ok: false,
              error: "شماره سوال صحیح نیست",
            },
            400,
            cors
          );
        }

        let snapshot = await env.DB
          .prepare(`
            SELECT *
            FROM attempt_questions
            WHERE attempt_id = ?
              AND question_order = ?
          `)
          .bind(
            attemptId,
            questionIndex
          )
          .first();

        // -------------------------------------------------------
        // Snapshot path
        // -------------------------------------------------------
        if (snapshot) {

          const startedAt =
            snapshot.started_at ||
            attempt.question_started_at ||
            attempt.started_at;

          const startedMs =
            new Date(startedAt).getTime();

          const nowMs = Date.now();

          let elapsedSeconds = Math.max(
            0,
            Math.floor(
              (nowMs - startedMs) / 1000
            )
          );

          const durationSeconds =
            Number(
              snapshot.duration_seconds_snapshot || 30
            );

          let timedOut =
            elapsedSeconds >= durationSeconds;

          if (timedOut) {
            selectedIndex = null;
            elapsedSeconds = durationSeconds;
          }

          let isCorrect = null;

          if (
            selectedIndex !== null &&
            selectedIndex >= 0 &&
            selectedIndex <= 3
          ) {
            isCorrect =
              selectedIndex ===
              Number(snapshot.correct_index_snapshot)
                ? 1
                : 0;
          }

          const answeredAt =
            new Date().toISOString();

          await env.DB
            .prepare(`
              UPDATE attempt_questions
              SET
                selected_index = ?,
                answered_at = ?,
                elapsed_seconds = ?,
                is_correct = ?
              WHERE attempt_id = ?
                AND question_order = ?
            `)
            .bind(
              selectedIndex,
              answeredAt,
              elapsedSeconds,
              isCorrect,
              attemptId,
              questionIndex
            )
            .run();

          const nextQuestion =
            questionIndex + 1;

          const totalQuestionsResult =
            await env.DB
              .prepare(`
                SELECT COUNT(*) AS count
                FROM attempt_questions
                WHERE attempt_id = ?
              `)
              .bind(attemptId)
              .first();

          const totalQuestions =
            Number(
              totalQuestionsResult?.count || 0
            );

          // -----------------------------------------------------
          // پایان آزمون
          // -----------------------------------------------------
          if (
            nextQuestion >= totalQuestions
          ) {

            await env.DB
              .prepare(`
                UPDATE attempts
                SET
                  current_question = ?,
                  finished_at = ?
                WHERE id = ?
              `)
              .bind(
                totalQuestions,
                answeredAt,
                attemptId
              )
              .run();

            return json(
              {
                ok: true,
                finished: true,
                nextQuestion: totalQuestions,
                totalQuestions,
                timedOut,
              },
              200,
              cors
            );
          }

          // -----------------------------------------------------
          // شروع سوال بعدی
          // -----------------------------------------------------
          await env.DB
            .prepare(`
              UPDATE attempt_questions
              SET started_at = ?
              WHERE attempt_id = ?
                AND question_order = ?
            `)
            .bind(
              answeredAt,
              attemptId,
              nextQuestion
            )
            .run();

          await env.DB
            .prepare(`
              UPDATE attempts
              SET
                current_question = ?,
                question_started_at = ?
              WHERE id = ?
            `)
            .bind(
              nextQuestion,
              answeredAt,
              attemptId
            )
            .run();

          const next =
            await env.DB
              .prepare(`
                SELECT *
                FROM attempt_questions
                WHERE attempt_id = ?
                  AND question_order = ?
              `)
              .bind(
                attemptId,
                nextQuestion
              )
              .first();

          return json(
            {
              ok: true,
              finished: false,
              nextQuestion,
              totalQuestions,
              timedOut,
              question:
                publicSnapshotQuestion(next),
            },
            200,
            cors
          );
        }

        // -------------------------------------------------------
        // Legacy path
        // -------------------------------------------------------
        const question =
          await getQuestion(
            env,
            attempt.exam_id,
            questionIndex
          );

        if (!question) {
          return json(
            {
              ok: false,
              error: "سوال پیدا نشد",
            },
            404,
            cors
          );
        }

        const questionStarted =
          attempt.question_started_at ||
          attempt.started_at;

        const elapsedSeconds = Math.max(
          0,
          Math.floor(
            (
              Date.now() -
              new Date(questionStarted).getTime()
            ) / 1000
          )
        );

        const durationSeconds =
          Number(question.duration_seconds || 30);

        let timedOut =
          elapsedSeconds >= durationSeconds;

        if (timedOut) {
          selectedIndex = null;
        }

        const answeredAt =
          new Date().toISOString();

        await env.DB
          .prepare(`
            INSERT INTO attempt_answers (
              attempt_id,
              question_index,
              selected_index,
              answered_at
            )
            VALUES (?, ?, ?, ?)
            ON CONFLICT(attempt_id, question_index)
            DO UPDATE SET
              selected_index = excluded.selected_index,
              answered_at = excluded.answered_at
          `)
          .bind(
            attemptId,
            questionIndex,
            selectedIndex,
            answeredAt
          )
          .run();

        const questions =
          await selectQuestionsForExam(
            env,
            attempt.exam_id
          );

        const nextQuestion =
          questionIndex + 1;

        if (
          nextQuestion >= questions.length
        ) {

          await env.DB
            .prepare(`
              UPDATE attempts
              SET
                current_question = ?,
                finished_at = ?
              WHERE id = ?
            `)
            .bind(
              questions.length,
              answeredAt,
              attemptId
            )
            .run();

          return json(
            {
              ok: true,
              finished: true,
              nextQuestion: questions.length,
              totalQuestions: questions.length,
              timedOut,
            },
            200,
            cors
          );
        }

        await env.DB
          .prepare(`
            UPDATE attempts
            SET
              current_question = ?,
              question_started_at = ?
            WHERE id = ?
          `)
          .bind(
            nextQuestion,
            answeredAt,
            attemptId
          )
          .run();

        return json(
          {
            ok: true,
            finished: false,
            nextQuestion,
            totalQuestions: questions.length,
            timedOut,
            question:
              publicQuestion(
                questions[nextQuestion]
              ),
          },
          200,
          cors
        );
      }


      // =========================================================
      // POST /api/submit
      // =========================================================
      if (
        request.method === "POST" &&
        url.pathname === "/api/submit"
      ) {
        const body = await request.json();

        const attemptId =
          String(body.attemptId || "").trim();

        if (!attemptId) {
          return json(
            {
              ok: false,
              error: "attemptId الزامی است",
            },
            400,
            cors
          );
        }

        const attempt =
          await env.DB
            .prepare(`
              SELECT *
              FROM attempts
              WHERE id = ?
            `)
            .bind(attemptId)
            .first();

        if (!attempt) {
          return json(
            {
              ok: false,
              error: "آزمون پیدا نشد",
            },
            404,
            cors
          );
        }

        if (attempt.finished_at) {
          return json(
            await buildResult(env, attemptId),
            200,
            cors
          );
        }

        const rows =
          await env.DB
            .prepare(`
              SELECT *
              FROM attempt_questions
              WHERE attempt_id = ?
              ORDER BY question_order
            `)
            .bind(attemptId)
            .all();

        if (
          rows.results &&
          rows.results.length > 0
        ) {

          let correct = 0;
          let wrong = 0;
          let empty = 0;

          for (const row of rows.results) {

            if (
              row.selected_index === null ||
              row.selected_index === undefined
            ) {
              empty++;
            } else if (
              Number(row.selected_index) ===
              Number(row.correct_index_snapshot)
            ) {
              correct++;
            } else {
              wrong++;
            }
          }

          const total =
            rows.results.length;

          const score =
            calculateScore20(
              correct,
              total
            );

          const finishedAt =
            new Date().toISOString();

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
              finishedAt,
              score,
              correct,
              wrong,
              empty,
              attemptId
            )
            .run();

          return json(
            await buildResult(
              env,
              attemptId
            ),
            200,
            cors
          );
        }

        return json(
          await buildLegacyResult(
            env,
            attemptId
          ),
          200,
          cors
        );
      }


      // =========================================================
      // GET /api/teacher/students
      // =========================================================
      if (
        request.method === "GET" &&
        url.pathname === "/api/teacher/students"
      ) {

        const examId =
          Number(
            url.searchParams.get("examId") || 1
          );

        const result =
          await env.DB
            .prepare(`
              SELECT
                o.id AS order_id,
                o.exam_id,
                o.name,
                o.phone,
                o.amount,
                o.status AS payment_status,
                o.created_at,
                o.paid_at,

                a.id AS attempt_id,
                a.started_at,
                a.finished_at,

                (
                  SELECT COUNT(*)
                  FROM attempt_questions aq
                  WHERE aq.attempt_id = a.id
                    AND aq.is_correct = 1
                ) AS correct_count,

                (
                  SELECT COUNT(*)
                  FROM attempt_questions aq
                  WHERE aq.attempt_id = a.id
                    AND aq.is_correct = 0
                ) AS wrong_count,

                (
                  SELECT COUNT(*)
                  FROM attempt_questions aq
                  WHERE aq.attempt_id = a.id
                    AND aq.selected_index IS NULL
                ) AS empty_count

              FROM orders o

              LEFT JOIN attempts a
                ON a.id = (
                  SELECT a2.id
                  FROM attempts a2
                  WHERE a2.order_id = o.id
                  ORDER BY a2.started_at DESC
                  LIMIT 1
                )

              WHERE o.exam_id = ?

              ORDER BY o.created_at DESC
            `)
            .bind(examId)
            .all();

        const students =
          (result.results || []).map(row => {

            let status;

            if (row.payment_status !== "paid") {
              status = "unpaid";
            } else if (!row.attempt_id) {
              status = "paid_not_started";
            } else if (!row.finished_at) {
              status = "in_progress";
            } else {
              status = "finished";
            }

            const correct =
              Number(row.correct_count || 0);

            const wrong =
              Number(row.wrong_count || 0);

            const empty =
              Number(row.empty_count || 0);

            const total =
              correct + wrong + empty;

            const score =
              total > 0
                ? calculateScore20(correct, total)
                : null;

            return {
              orderId: row.order_id,
              attemptId: row.attempt_id || null,
              examId: row.exam_id,
              name: row.name,
              phone: row.phone,
              amount: row.amount,

              paymentStatus:
                row.payment_status,

              status,

              createdAt:
                row.created_at,

              paidAt:
                row.paid_at,

              startedAt:
                row.started_at || null,

              finishedAt:
                row.finished_at || null,

              score,

              correct,
              wrong,
              empty,
            };
          });

        return json(
          {
            ok: true,
            examId,
            students,
          },
          200,
          cors
        );
      }


      // =========================================================
      // GET /api/teacher/attempt
      // =========================================================
      if (
        request.method === "GET" &&
        url.pathname === "/api/teacher/attempt"
      ) {

        const attemptId =
          String(
            url.searchParams.get("attemptId") || ""
          ).trim();

        if (!attemptId) {
          return json(
            {
              ok: false,
              error: "attemptId الزامی است",
            },
            400,
            cors
          );
        }

        const data =
          await env.DB
            .prepare(`
              SELECT
                a.id AS attempt_id,
                a.order_id,
                a.started_at,
                a.finished_at,

                o.exam_id,
                o.name,
                o.phone,
                o.amount,
                o.status AS payment_status,
                o.created_at,
                o.paid_at

              FROM attempts a
              JOIN orders o
                ON o.id = a.order_id

              WHERE a.id = ?
            `)
            .bind(attemptId)
            .first();

        if (!data) {
          return json(
            {
              ok: false,
              error: "آزمون پیدا نشد",
            },
            404,
            cors
          );
        }

        const rows =
          await env.DB
            .prepare(`
              SELECT *
              FROM attempt_questions
              WHERE attempt_id = ?
              ORDER BY question_order
            `)
            .bind(attemptId)
            .all();

        const questions =
          (rows.results || []).map(row => {

            let result = "empty";

            if (
              row.selected_index !== null &&
              row.selected_index !== undefined
            ) {
              result =
                Number(row.selected_index) ===
                Number(row.correct_index_snapshot)
                  ? "correct"
                  : "wrong";
            }

            return {
              number:
                Number(row.question_order) + 1,

              questionId:
                row.question_id,

              question:
                row.question_text_snapshot,

              options: [
                row.option_a_snapshot,
                row.option_b_snapshot,
                row.option_c_snapshot,
                row.option_d_snapshot,
              ],

              selectedIndex:
                row.selected_index,

              correctIndex:
                row.correct_index_snapshot,

              result,

              isCorrect:
                result === "correct",

              durationSeconds:
                row.duration_seconds_snapshot,

              startedAt:
                row.started_at || null,

              answeredAt:
                row.answered_at || null,

              elapsedSeconds:
                row.elapsed_seconds === null ||
                row.elapsed_seconds === undefined
                  ? null
                  : Number(row.elapsed_seconds),
            };
          });

        const correct =
          questions.filter(
            q => q.result === "correct"
          ).length;

        const wrong =
          questions.filter(
            q => q.result === "wrong"
          ).length;

        const empty =
          questions.filter(
            q => q.result === "empty"
          ).length;

        const total =
          questions.length;

        const score =
          total > 0
            ? calculateScore20(correct, total)
            : 0;

        return json(
          {
            ok: true,

            student: {
              name: data.name,
              phone: data.phone,
            },

            payment: {
              amount: data.amount,
              status: data.payment_status,
              createdAt: data.created_at,
              paidAt: data.paid_at,
            },

            attempt: {
              id: data.attempt_id,
              orderId: data.order_id,
              examId: data.exam_id,

              startedAt:
                data.started_at,

              finishedAt:
                data.finished_at,

              score,

              correct,
              wrong,
              empty,

              total,
            },

            questions,
          },
          200,
          cors
        );
      }


      // =========================================================
      // DELETE /api/teacher/student
      // حذف یک دانش‌آموز
      // =========================================================
      if (
        request.method === "DELETE" &&
        url.pathname === "/api/teacher/student"
      ) {

        const orderId =
          String(
            url.searchParams.get("orderId") || ""
          ).trim();

        if (!orderId) {
          return json(
            {
              ok: false,
              error: "orderId الزامی است",
            },
            400,
            cors
          );
        }

        const order =
          await env.DB
            .prepare(`
              SELECT
                id,
                exam_id,
                name,
                phone
              FROM orders
              WHERE id = ?
            `)
            .bind(orderId)
            .first();

        if (!order) {
          return json(
            {
              ok: false,
              error: "دانش‌آموز پیدا نشد",
            },
            404,
            cors
          );
        }

        const attemptCount =
          await env.DB
            .prepare(`
              SELECT COUNT(*) AS count
              FROM attempts
              WHERE order_id = ?
            `)
            .bind(orderId)
            .first();

        const attemptQuestionsCount =
          await env.DB
            .prepare(`
              SELECT COUNT(*) AS count
              FROM attempt_questions aq
              JOIN attempts a
                ON a.id = aq.attempt_id
              WHERE a.order_id = ?
            `)
            .bind(orderId)
            .first();

        const attemptAnswersCount =
          await env.DB
            .prepare(`
              SELECT COUNT(*) AS count
              FROM attempt_answers aa
              JOIN attempts a
                ON a.id = aa.attempt_id
              WHERE a.order_id = ?
            `)
            .bind(orderId)
            .first();

        await env.DB.batch([

          env.DB
            .prepare(`
              DELETE FROM attempt_answers
              WHERE attempt_id IN (
                SELECT id
                FROM attempts
                WHERE order_id = ?
              )
            `)
            .bind(orderId),

          env.DB
            .prepare(`
              DELETE FROM attempt_questions
              WHERE attempt_id IN (
                SELECT id
                FROM attempts
                WHERE order_id = ?
              )
            `)
            .bind(orderId),

          env.DB
            .prepare(`
              DELETE FROM attempts
              WHERE order_id = ?
            `)
            .bind(orderId),

          env.DB
            .prepare(`
              DELETE FROM orders
              WHERE id = ?
            `)
            .bind(orderId),
        ]);

        return json(
          {
            ok: true,

            message:
              "دانش‌آموز و تمام اطلاعات آزمون او حذف شد",

            student: {
              orderId: order.id,
              examId: order.exam_id,
              name: order.name,
              phone: order.phone,
            },

            deleted: {
              orders: 1,
              attempts:
                Number(attemptCount?.count || 0),
              attemptQuestions:
                Number(
                  attemptQuestionsCount?.count || 0
                ),
              attemptAnswers:
                Number(
                  attemptAnswersCount?.count || 0
                ),
            },
          },
          200,
          cors
        );
      }


      // =========================================================
      // DELETE /api/teacher/students
      // حذف تمام دانش‌آموزان یک آزمون
      // =========================================================
      if (
        request.method === "DELETE" &&
        url.pathname === "/api/teacher/students"
      ) {

        const examId =
          Number(
            url.searchParams.get("examId") || 1
          );

        if (!Number.isInteger(examId) || examId <= 0) {
          return json(
            {
              ok: false,
              error: "examId نامعتبر است",
            },
            400,
            cors
          );
        }

        const orderCount =
          await env.DB
            .prepare(`
              SELECT COUNT(*) AS count
              FROM orders
              WHERE exam_id = ?
            `)
            .bind(examId)
            .first();

        const attemptCount =
          await env.DB
            .prepare(`
              SELECT COUNT(*) AS count
              FROM attempts a
              JOIN orders o
                ON o.id = a.order_id
              WHERE o.exam_id = ?
            `)
            .bind(examId)
            .first();

        const attemptQuestionsCount =
          await env.DB
            .prepare(`
              SELECT COUNT(*) AS count
              FROM attempt_questions aq
              JOIN attempts a
                ON a.id = aq.attempt_id
              JOIN orders o
                ON o.id = a.order_id
              WHERE o.exam_id = ?
            `)
            .bind(examId)
            .first();

        const attemptAnswersCount =
          await env.DB
            .prepare(`
              SELECT COUNT(*) AS count
              FROM attempt_answers aa
              JOIN attempts a
                ON a.id = aa.attempt_id
              JOIN orders o
                ON o.id = a.order_id
              WHERE o.exam_id = ?
            `)
            .bind(examId)
            .first();

        await env.DB.batch([

          env.DB
            .prepare(`
              DELETE FROM attempt_answers
              WHERE attempt_id IN (
                SELECT a.id
                FROM attempts a
                JOIN orders o
                  ON o.id = a.order_id
                WHERE o.exam_id = ?
              )
            `)
            .bind(examId),

          env.DB
            .prepare(`
              DELETE FROM attempt_questions
              WHERE attempt_id IN (
                SELECT a.id
                FROM attempts a
                JOIN orders o
                  ON o.id = a.order_id
                WHERE o.exam_id = ?
              )
            `)
            .bind(examId),

          env.DB
            .prepare(`
              DELETE FROM attempts
              WHERE order_id IN (
                SELECT id
                FROM orders
                WHERE exam_id = ?
              )
            `)
            .bind(examId),

          env.DB
            .prepare(`
              DELETE FROM orders
              WHERE exam_id = ?
            `)
            .bind(examId),
        ]);

        return json(
          {
            ok: true,

            message:
              "تمام دانش‌آموزان و اطلاعات آزمون آنها حذف شدند",

            examId,

            deleted: {
              orders:
                Number(orderCount?.count || 0),

              attempts:
                Number(attemptCount?.count || 0),

              attemptQuestions:
                Number(
                  attemptQuestionsCount?.count || 0
                ),

              attemptAnswers:
                Number(
                  attemptAnswersCount?.count || 0
                ),
            },
          },
          200,
          cors
        );
      }


      // =========================================================
      // Static files
      // =========================================================
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return json(
        {
          ok: false,
          error: "مسیر پیدا نشد",
        },
        404,
        cors
      );

    } catch (error) {

      console.error(error);

      return json(
        {
          ok: false,
          error:
            error?.message ||
            "خطای داخلی سرور",
        },
        500,
        cors
      );
    }
  },
};


// =============================================================
// انتخاب سوالات آزمون
// =============================================================
async function selectQuestionsForExam(env, examId) {

  const rulesResult =
    await env.DB
      .prepare(`
        SELECT
          efr.folder_id,
          efr.selection_count,
          efr.selection_mode
        FROM exam_folder_rules efr
        JOIN question_folders f
          ON f.id = efr.folder_id
        WHERE efr.exam_id = ?
          AND f.active = 1
        ORDER BY efr.id
      `)
      .bind(examId)
      .all();

  const rules =
    rulesResult.results || [];

  // -----------------------------------------------------------
  // اگر قانون پوشه‌ای وجود نداشت → حالت قدیمی
  // -----------------------------------------------------------
  if (!rules.length) {

    const result =
      await env.DB
        .prepare(`
          SELECT *
          FROM questions
          WHERE exam_id = ?
            AND active = 1
          ORDER BY id
        `)
        .bind(examId)
        .all();

    return result.results || [];
  }

  const selected = [];

  for (const rule of rules) {

    const count =
      Number(rule.selection_count || 0);

    if (count <= 0) {
      continue;
    }

    let rows = [];

    // ---------------------------------------------------------
    // manual
    // ---------------------------------------------------------
    if (rule.selection_mode === "manual") {

      const result =
        await env.DB
          .prepare(`
            SELECT q.*
            FROM exam_manual_questions emq
            JOIN questions q
              ON q.id = emq.question_id
            WHERE emq.exam_id = ?
              AND q.exam_id = ?
              AND q.folder_id = ?
              AND q.active = 1
            ORDER BY emq.sort_order, q.id
            LIMIT ?
          `)
          .bind(
            examId,
            examId,
            rule.folder_id,
            count
          )
          .all();

      rows =
        result.results || [];

    } else {

      // -------------------------------------------------------
      // random
      // -------------------------------------------------------
      const result =
        await env.DB
          .prepare(`
            SELECT *
            FROM questions
            WHERE exam_id = ?
              AND folder_id = ?
              AND active = 1
            ORDER BY RANDOM()
            LIMIT ?
          `)
          .bind(
            examId,
            rule.folder_id,
            count
          )
          .all();

      rows =
        result.results || [];
    }

    if (rows.length < count) {

      throw new Error(
        `در پوشه ${rule.folder_id} به تعداد ${count} سوال فعال وجود ندارد`
      );
    }

    selected.push(...rows);
  }

  return selected;
}


// =============================================================
// سوال عمومی برای student
// =============================================================
function publicQuestion(q) {

  if (!q) {
    return null;
  }

  return {
    id: q.id,

    question:
      q.question_text,

    options: [
      q.option_a,
      q.option_b,
      q.option_c,
      q.option_d,
    ],

    durationSeconds:
      Number(q.duration_seconds || 30),
  };
}


// =============================================================
// سوال snapshot برای student
// =============================================================
function publicSnapshotQuestion(q) {

  if (!q) {
    return null;
  }

  return {
    id: q.question_id,

    question:
      q.question_text_snapshot,

    options: [
      q.option_a_snapshot,
      q.option_b_snapshot,
      q.option_c_snapshot,
      q.option_d_snapshot,
    ],

    durationSeconds:
      Number(
        q.duration_seconds_snapshot || 30
      ),
  };
}


// =============================================================
// گرفتن سوال در حالت legacy
// =============================================================
async function getQuestion(
  env,
  examId,
  questionIndex
) {

  const questions =
    await selectQuestionsForExam(
      env,
      examId
    );

  return (
    questions[questionIndex] ||
    null
  );
}


// =============================================================
// محاسبه نمره از 20
// =============================================================
function calculateScore20(
  correct,
  total
) {

  correct =
    Number(correct || 0);

  total =
    Number(total || 0);

  if (total <= 0) {
    return 0;
  }

  const score =
    (correct / total) * 20;

  return Math.round(
    score * 10
  ) / 10;
}


// =============================================================
// ساخت نتیجه
// =============================================================
async function buildResult(
  env,
  attemptId
) {

  const attempt =
    await env.DB
      .prepare(`
        SELECT *
        FROM attempts
        WHERE id = ?
      `)
      .bind(attemptId)
      .first();

  if (!attempt) {
    throw new Error("آزمون پیدا نشد");
  }

  const rows =
    await env.DB
      .prepare(`
        SELECT *
        FROM attempt_questions
        WHERE attempt_id = ?
        ORDER BY question_order
      `)
      .bind(attemptId)
      .all();

  const questions =
    rows.results || [];

  let correct = 0;
  let wrong = 0;
  let empty = 0;

  const sheet =
    questions.map(row => {

      let result =
        "empty";

      if (
        row.selected_index !== null &&
        row.selected_index !== undefined
      ) {

        if (
          Number(row.selected_index) ===
          Number(row.correct_index_snapshot)
        ) {

          correct++;
          result = "correct";

        } else {

          wrong++;
          result = "wrong";
        }

      } else {

        empty++;
      }

      return {
        number:
          Number(row.question_order) + 1,

        question:
          row.question_text_snapshot,

        options: [
          row.option_a_snapshot,
          row.option_b_snapshot,
          row.option_c_snapshot,
          row.option_d_snapshot,
        ],

        selectedIndex:
          row.selected_index,

        correctIndex:
          row.correct_index_snapshot,

        result,

        elapsedSeconds:
          row.elapsed_seconds,
      };
    });

  const total =
    questions.length;

  const score =
    calculateScore20(
      correct,
      total
    );

  return {
    ok: true,

    attemptId,

    score,

    correct,

    wrong,

    empty,

    total,

    sheet,
  };
}


// =============================================================
// نتیجه legacy
// =============================================================
async function buildLegacyResult(
  env,
  attemptId
) {

  const attempt =
    await env.DB
      .prepare(`
        SELECT
          a.*,
          o.exam_id
        FROM attempts a
        JOIN orders o
          ON o.id = a.order_id
        WHERE a.id = ?
      `)
      .bind(attemptId)
      .first();

  if (!attempt) {
    throw new Error("آزمون پیدا نشد");
  }

  const questions =
    await selectQuestionsForExam(
      env,
      attempt.exam_id
    );

  const answersResult =
    await env.DB
      .prepare(`
        SELECT *
        FROM attempt_answers
        WHERE attempt_id = ?
        ORDER BY question_index
      `)
      .bind(attemptId)
      .all();

  const answers =
    answersResult.results || [];

  const answerMap =
    new Map();

  for (const answer of answers) {

    answerMap.set(
      Number(answer.question_index),
      answer.selected_index
    );
  }

  let correct = 0;
  let wrong = 0;
  let empty = 0;

  const sheet =
    questions.map((q, index) => {

      const selectedIndex =
        answerMap.has(index)
          ? answerMap.get(index)
          : null;

      let result =
        "empty";

      if (
        selectedIndex === null ||
        selectedIndex === undefined
      ) {

        empty++;

      } else if (
        Number(selectedIndex) ===
        Number(q.correct_index)
      ) {

        correct++;
        result = "correct";

      } else {

        wrong++;
        result = "wrong";
      }

      return {
        number: index + 1,

        question:
          q.question_text,

        options: [
          q.option_a,
          q.option_b,
          q.option_c,
          q.option_d,
        ],

        selectedIndex,

        correctIndex:
          q.correct_index,

        result,
      };
    });

  const total =
    questions.length;

  const score =
    calculateScore20(
      correct,
      total
    );

  await env.DB
    .prepare(`
      UPDATE attempts
      SET
        finished_at =
          COALESCE(finished_at, ?),
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

  return {
    ok: true,

    attemptId,

    score,

    correct,

    wrong,

    empty,

    total,

    sheet,
  };
}


// =============================================================
// JSON Response
// =============================================================
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

        ...cors,
      },
    }
  );
}


// =============================================================
// شماره موبایل
// =============================================================
function normalizePhone(value) {

  let phone =
    String(value || "")
      .trim()
      .replace(/\s+/g, "")
      .replace(/-/g, "");

  if (
    phone.startsWith("+98")
  ) {

    phone =
      "0" +
      phone.slice(3);
  }

  if (
    phone.startsWith("98") &&
    phone.length === 12
  ) {

    phone =
      "0" +
      phone.slice(2);
  }

  return phone;
}
