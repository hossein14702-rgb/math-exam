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
      if (
        request.method === "GET" &&
        url.pathname === "/api/exam"
      ) {
        const examId =
          Number(
            url.searchParams.get("id") || 1
          );

        const exam =
          await env.DB
            .prepare(`
              SELECT
                id,
                title,
                price,
                duration_seconds,
                active,
                discount_enabled,
                discount_percent,
                discount_start_at,
                discount_end_at
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

        const pricing =
          getEffectivePrice(exam);

        const rulesResult =
          await env.DB
            .prepare(`
              SELECT
                selection_count
              FROM exam_folder_rules efr
              JOIN question_folders f
                ON f.id = efr.folder_id
              WHERE efr.exam_id = ?
                AND f.active = 1
            `)
            .bind(examId)
            .all();

        const rules =
          rulesResult.results || [];

        let questionCount = 0;

        if (rules.length) {
          questionCount =
            rules.reduce(
              (sum, row) =>
                sum +
                Number(
                  row.selection_count || 0
                ),
              0
            );
        }

        const publicExam = {
          id: exam.id,
          title: exam.title,

          price:
            pricing.finalPrice,

          basePrice:
            pricing.basePrice,

          finalPrice:
            pricing.finalPrice,

          discountEnabled:
            pricing.discountEnabled,

          discountActive:
            pricing.discountActive,

          discountPercent:
            pricing.discountPercent,

          discountStartAt:
            pricing.discountStartAt,

          discountEndAt:
            pricing.discountEndAt,

          duration_seconds:
            exam.duration_seconds,

          active:
            exam.active,
        };

        const result =
          await env.DB
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

            exam:
              publicExam,

            questionCount,

            questions:
              result.results || [],
          },
          200,
          cors
        );
      }


      // =========================================================
      // GET /api/teacher/exam-settings
      // =========================================================
      if (
        request.method === "GET" &&
        url.pathname === "/api/teacher/exam-settings"
      ) {
        const examId =
          Number(
            url.searchParams.get("examId") || 1
          );

        if (
          !Number.isInteger(examId) ||
          examId <= 0
        ) {
          return json(
            {
              ok: false,
              error:
                "examId نامعتبر است",
            },
            400,
            cors
          );
        }

        const exam =
          await env.DB
            .prepare(`
              SELECT
                id,
                title,
                price,
                active,
                discount_enabled,
                discount_percent,
                discount_start_at,
                discount_end_at
              FROM exams
              WHERE id = ?
            `)
            .bind(examId)
            .first();

        if (!exam) {
          return json(
            {
              ok: false,
              error:
                "آزمون پیدا نشد",
            },
            404,
            cors
          );
        }

        const pricing =
          getEffectivePrice(exam);

        return json(
          {
            ok: true,

            exam: {
              id:
                exam.id,

              title:
                exam.title,

              active:
                exam.active,

              price:
                Number(
                  exam.price || 0
                ),

              discountEnabled:
                Number(
                  exam.discount_enabled || 0
                ) === 1,

              discountPercent:
                Number(
                  exam.discount_percent || 0
                ),

              discountStartAt:
                exam.discount_start_at ||
                null,

              discountEndAt:
                exam.discount_end_at ||
                null,
            },

            pricing,
          },
          200,
          cors
        );
      }


      // =========================================================
      // POST /api/teacher/exam-settings
      // =========================================================
      if (
        request.method === "POST" &&
        url.pathname === "/api/teacher/exam-settings"
      ) {
        const body =
          await request.json();

        const examId =
          Number(
            body.examId || 1
          );

        const price =
          Number(
            body.price
          );

        const discountEnabled =
          body.discountEnabled === true ||
          body.discountEnabled === 1 ||
          body.discountEnabled === "1";

        const discountPercent =
          Number(
            body.discountPercent || 0
          );

        let discountStartAt =
          body.discountStartAt
            ? String(
                body.discountStartAt
              ).trim()
            : null;

        let discountEndAt =
          body.discountEndAt
            ? String(
                body.discountEndAt
              ).trim()
            : null;

        if (
          !Number.isInteger(examId) ||
          examId <= 0
        ) {
          return json(
            {
              ok: false,
              error:
                "examId نامعتبر است",
            },
            400,
            cors
          );
        }

        if (
          !Number.isFinite(price) ||
          price <= 0
        ) {
          return json(
            {
              ok: false,
              error:
                "قیمت اصلی باید بیشتر از صفر باشد",
            },
            400,
            cors
          );
        }

        if (
          !Number.isInteger(price)
        ) {
          return json(
            {
              ok: false,
              error:
                "قیمت اصلی باید عدد صحیح باشد",
            },
            400,
            cors
          );
        }

        if (
          !Number.isFinite(
            discountPercent
          ) ||
          discountPercent < 0 ||
          discountPercent > 100
        ) {
          return json(
            {
              ok: false,
              error:
                "درصد تخفیف باید بین صفر تا 100 باشد",
            },
            400,
            cors
          );
        }

        if (discountEnabled) {

          if (
            !discountStartAt ||
            !discountEndAt
          ) {
            return json(
              {
                ok: false,
                error:
                  "برای فعال کردن تخفیف، تاریخ شروع و پایان الزامی است",
              },
              400,
              cors
            );
          }

          const startMs =
            new Date(
              discountStartAt
            ).getTime();

          const endMs =
            new Date(
              discountEndAt
            ).getTime();

          if (
            !Number.isFinite(
              startMs
            ) ||
            !Number.isFinite(
              endMs
            )
          ) {
            return json(
              {
                ok: false,
                error:
                  "تاریخ یا ساعت تخفیف نامعتبر است",
              },
              400,
              cors
            );
          }

          if (
            endMs <= startMs
          ) {
            return json(
              {
                ok: false,
                error:
                  "تاریخ پایان باید بعد از تاریخ شروع باشد",
              },
              400,
              cors
            );
          }
        }

        await env.DB
          .prepare(`
            UPDATE exams
            SET
              price = ?,
              discount_enabled = ?,
              discount_percent = ?,
              discount_start_at = ?,
              discount_end_at = ?
            WHERE id = ?
          `)
          .bind(
            price,
            discountEnabled
              ? 1
              : 0,
            discountPercent,
            discountStartAt,
            discountEndAt,
            examId
          )
          .run();

        const exam =
          await env.DB
            .prepare(`
              SELECT
                id,
                title,
                price,
                active,
                discount_enabled,
                discount_percent,
                discount_start_at,
                discount_end_at
              FROM exams
              WHERE id = ?
            `)
            .bind(examId)
            .first();

        const pricing =
          getEffectivePrice(exam);

        return json(
          {
            ok: true,

            message:
              "تنظیمات قیمت با موفقیت ذخیره شد",

            exam: {
              id:
                exam.id,

              title:
                exam.title,

              active:
                exam.active,

              price:
                Number(
                  exam.price || 0
                ),

              discountEnabled:
                Number(
                  exam.discount_enabled ||
                  0
                ) === 1,

              discountPercent:
                Number(
                  exam.discount_percent ||
                  0
                ),

              discountStartAt:
                exam.discount_start_at ||
                null,

              discountEndAt:
                exam.discount_end_at ||
                null,
            },

            pricing,
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
        const body =
          await request.json();

        const name =
          String(
            body.name || ""
          ).trim();

        const phone =
          normalizePhone(
            body.phone
          );

        const examId =
          Number(
            body.examId || 1
          );

        if (!name || !phone) {
          return json(
            {
              ok: false,
              error:
                "نام و شماره موبایل الزامی است",
            },
            400,
            cors
          );
        }

        const exam =
          await env.DB
            .prepare(`
              SELECT
                id,
                price,
                active,
                discount_enabled,
                discount_percent,
                discount_start_at,
                discount_end_at
              FROM exams
              WHERE id = ?
            `)
            .bind(examId)
            .first();

        if (!exam) {
          return json(
            {
              ok: false,
              error:
                "آزمون پیدا نشد",
            },
            404,
            cors
          );
        }

        if (!exam.active) {
          return json(
            {
              ok: false,
              error:
                "این آزمون فعال نیست",
            },
            400,
            cors
          );
        }

        const pricing =
          getEffectivePrice(exam);

        const amount =
          pricing.finalPrice;

        const orderId =
          crypto.randomUUID();

        const createdAt =
          new Date().toISOString();

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
            amount,
            createdAt
          )
          .run();

        return json(
          {
            ok: true,

            orderId,

            amount,

            pricing: {
              basePrice:
                pricing.basePrice,

              finalPrice:
                pricing.finalPrice,

              discountEnabled:
                pricing.discountEnabled,

              discountActive:
                pricing.discountActive,

              discountPercent:
                pricing.discountPercent,

              discountStartAt:
                pricing.discountStartAt,

              discountEndAt:
                pricing.discountEndAt,
            },
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
        const body =
          await request.json();

        const orderId =
          String(
            body.orderId || ""
          ).trim();

        if (!orderId) {
          return json(
            {
              ok: false,
              error:
                "orderId الزامی است",
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
                status
              FROM orders
              WHERE id = ?
            `)
            .bind(orderId)
            .first();

        if (!order) {
          return json(
            {
              ok: false,
              error:
                "سفارش پیدا نشد",
            },
            404,
            cors
          );
        }

        const paidAt =
          new Date().toISOString();

        await env.DB
          .prepare(`
            UPDATE orders
            SET
              status = 'paid',
              paid_at = ?
            WHERE id = ?
          `)
          .bind(
            paidAt,
            orderId
          )
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
        const body =
          await request.json();

        const orderId =
          String(
            body.orderId || ""
          ).trim();

        if (!orderId) {
          return json(
            {
              ok: false,
              error:
                "orderId الزامی است",
            },
            400,
            cors
          );
        }

        const order =
          await env.DB
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
              error:
                "سفارش پیدا نشد",
            },
            404,
            cors
          );
        }

        if (
          order.status !== "paid"
        ) {
          return json(
            {
              ok: false,
              error:
                "ابتدا باید پرداخت انجام شود",
            },
            400,
            cors
          );
        }

        const existingAttempt =
          await env.DB
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

          if (
            existingAttempt.finished_at
          ) {
            return json(
              {
                ok: false,
                error:
                  "این آزمون قبلاً تمام شده است",
              },
              400,
              cors
            );
          }

          const snapshots =
            await env.DB
              .prepare(`
                SELECT *
                FROM attempt_questions
                WHERE attempt_id = ?
                ORDER BY question_order
              `)
              .bind(
                existingAttempt.id
              )
              .all();

          if (
            snapshots.results &&
            snapshots.results.length > 0
          ) {

            let currentQuestion =
              Number(
                existingAttempt.current_question ||
                0
              );

            if (
              currentQuestion < 0 ||
              currentQuestion >=
                snapshots.results.length
            ) {
              currentQuestion = 0;
            }

            const current =
              snapshots.results[
                currentQuestion
              ];

            if (
              !current.started_at
            ) {

              const now =
                new Date().toISOString();

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

              current.started_at =
                now;
            }

            return json(
              {
                ok: true,

                resumed: true,

                attemptId:
                  existingAttempt.id,

                currentQuestion,

                totalQuestions:
                  snapshots.results.length,

                questionStartedAt:
                  current.started_at,

                question:
                  publicSnapshotQuestion(
                    current
                  ),
              },
              200,
              cors
            );
          }

          const questions =
            await selectQuestionsForExam(
              env,
              order.exam_id
            );

          const legacyIndex =
            Math.min(
              Math.max(
                Number(
                  existingAttempt.current_question ||
                  0
                ),
                0
              ),
              Math.max(
                questions.length - 1,
                0
              )
            );

          const legacyQuestion =
            questions[
              legacyIndex
            ];

          return json(
            {
              ok: true,

              resumed: true,

              attemptId:
                existingAttempt.id,

              currentQuestion:
                legacyIndex,

              totalQuestions:
                questions.length,

              questionStartedAt:
                existingAttempt.question_started_at ||
                existingAttempt.started_at,

              question:
                publicQuestion(
                  legacyQuestion
                ),
            },
            200,
            cors
          );
        }

        const questions =
          await selectQuestionsForExam(
            env,
            order.exam_id
          );

        if (!questions.length) {
          return json(
            {
              ok: false,
              error:
                "برای این آزمون سوالی وجود ندارد",
            },
            400,
            cors
          );
        }

        const attemptId =
          crypto.randomUUID();

        const startedAt =
          new Date().toISOString();

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

        for (
          let i = 0;
          i < questions.length;
          i++
        ) {

          const q =
            questions[i];

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
                Number(
                  q.duration_seconds || 30
                ),
                i === 0
                  ? startedAt
                  : null
              )
          );
        }

        if (statements.length) {
          await env.DB.batch(
            statements
          );
        }

        return json(
          {
            ok: true,

            resumed: false,

            attemptId,

            currentQuestion: 0,

            totalQuestions:
              questions.length,

            questionStartedAt:
              startedAt,

            question:
              publicQuestion(
                questions[0]
              ),
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
        const body =
          await request.json();

        const attemptId =
          String(
            body.attemptId || ""
          ).trim();

        const questionIndex =
          Number(
            body.questionIndex
          );

        let selectedIndex =
          body.selectedIndex === null ||
          body.selectedIndex === undefined ||
          body.selectedIndex === ""
            ? null
            : Number(
                body.selectedIndex
              );

        if (
          !attemptId ||
          !Number.isInteger(
            questionIndex
          )
        ) {
          return json(
            {
              ok: false,
              error:
                "اطلاعات پاسخ ناقص است",
            },
            400,
            cors
          );
        }

        if (
          selectedIndex !== null &&
          (
            !Number.isInteger(
              selectedIndex
            ) ||
            selectedIndex < 0 ||
            selectedIndex > 3
          )
        ) {
          return json(
            {
              ok: false,
              error:
                "گزینه انتخاب‌شده نامعتبر است",
            },
            400,
            cors
          );
        }

        const attempt =
          await env.DB
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
              error:
                "آزمون پیدا نشد",
            },
            404,
            cors
          );
        }

        if (
          attempt.order_status !==
          "paid"
        ) {
          return json(
            {
              ok: false,
              error:
                "پرداخت معتبر نیست",
            },
            400,
            cors
          );
        }

        if (
          attempt.finished_at
        ) {
          return json(
            {
              ok: false,
              error:
                "آزمون تمام شده است",
            },
            400,
            cors
          );
        }

        const currentQuestion =
          Number(
            attempt.current_question ||
            0
          );

        if (
          questionIndex !==
          currentQuestion
        ) {
          return json(
            {
              ok: false,
              error:
                "شماره سوال صحیح نیست",
            },
            400,
            cors
          );
        }

        let snapshot =
          await env.DB
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

        if (snapshot) {

          const startedAt =
            snapshot.started_at ||
            attempt.question_started_at ||
            attempt.started_at;

          const startedMs =
            new Date(
              startedAt
            ).getTime();

          const nowMs =
            Date.now();

          let elapsedSeconds =
            Math.max(
              0,
              Math.floor(
                (
                  nowMs -
                  startedMs
                ) / 1000
              )
            );

          const durationSeconds =
            Number(
              snapshot.duration_seconds_snapshot ||
              30
            );

          let timedOut =
            elapsedSeconds >=
            durationSeconds;

          if (timedOut) {
            selectedIndex = null;

            elapsedSeconds =
              durationSeconds;
          }

          let isCorrect = null;

          if (
            selectedIndex !== null
          ) {
            isCorrect =
              selectedIndex ===
              Number(
                snapshot.correct_index_snapshot
              )
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
              .bind(
                attemptId
              )
              .first();

          const totalQuestions =
            Number(
              totalQuestionsResult?.count ||
              0
            );

          if (
            nextQuestion >=
            totalQuestions
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

                nextQuestion:
                  totalQuestions,

                currentQuestion:
                  totalQuestions,

                totalQuestions,

                timedOut,
              },
              200,
              cors
            );
          }

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

              currentQuestion:
                nextQuestion,

              totalQuestions,

              timedOut,

              questionStartedAt:
                next.started_at,

              question:
                publicSnapshotQuestion(
                  next
                ),
            },
            200,
            cors
          );
        }

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
              error:
                "سوال پیدا نشد",
            },
            404,
            cors
          );
        }

        const questionStarted =
          attempt.question_started_at ||
          attempt.started_at;

        const elapsedSeconds =
          Math.max(
            0,
            Math.floor(
              (
                Date.now() -
                new Date(
                  questionStarted
                ).getTime()
              ) / 1000
            )
          );

        const durationSeconds =
          Number(
            question.duration_seconds ||
            30
          );

        let timedOut =
          elapsedSeconds >=
          durationSeconds;

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
          nextQuestion >=
          questions.length
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

              nextQuestion:
                questions.length,

              currentQuestion:
                questions.length,

              totalQuestions:
                questions.length,

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

            currentQuestion:
              nextQuestion,

            totalQuestions:
              questions.length,

            timedOut,

            questionStartedAt:
              answeredAt,

            question:
              publicQuestion(
                questions[
                  nextQuestion
                ]
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
        const body =
          await request.json();

        const attemptId =
          String(
            body.attemptId || ""
          ).trim();

        if (!attemptId) {
          return json(
            {
              ok: false,
              error:
                "attemptId الزامی است",
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
              error:
                "آزمون پیدا نشد",
            },
            404,
            cors
          );
        }

        if (
          attempt.finished_at
        ) {
          return json(
            await buildResult(
              env,
              attemptId
            ),
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

          for (
            const row of rows.results
          ) {

            if (
              row.selected_index === null ||
              row.selected_index === undefined
            ) {
              empty++;

            } else if (
              Number(
                row.selected_index
              ) ===
              Number(
                row.correct_index_snapshot
              )
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
            url.searchParams.get(
              "examId"
            ) || 1
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
          (
            result.results || []
          ).map(row => {

            let status;

            if (
              row.payment_status !==
              "paid"
            ) {
              status =
                "unpaid";

            } else if (
              !row.attempt_id
            ) {
              status =
                "paid_not_started";

            } else if (
              !row.finished_at
            ) {
              status =
                "in_progress";

            } else {
              status =
                "finished";
            }

            const correct =
              Number(
                row.correct_count || 0
              );

            const wrong =
              Number(
                row.wrong_count || 0
              );

            const empty =
              Number(
                row.empty_count || 0
              );

            const total =
              correct +
              wrong +
              empty;

            const score =
              total > 0
                ? calculateScore20(
                    correct,
                    total
                  )
                : null;

            return {
              orderId:
                row.order_id,

              attemptId:
                row.attempt_id || null,

              examId:
                row.exam_id,

              name:
                row.name,

              phone:
                row.phone,

              amount:
                row.amount,

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
            url.searchParams.get(
              "attemptId"
            ) || ""
          ).trim();

        if (!attemptId) {
          return json(
            {
              ok: false,
              error:
                "attemptId الزامی است",
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
              error:
                "آزمون پیدا نشد",
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
          (
            rows.results || []
          ).map(row => {

            let result =
              "empty";

            if (
              row.selected_index !== null &&
              row.selected_index !== undefined
            ) {

              result =
                Number(
                  row.selected_index
                ) ===
                Number(
                  row.correct_index_snapshot
                )
                  ? "correct"
                  : "wrong";
            }

            return {
              number:
                Number(
                  row.question_order
                ) + 1,

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
                  : Number(
                      row.elapsed_seconds
                    ),
            };
          });

        const correct =
          questions.filter(
            q =>
              q.result ===
              "correct"
          ).length;

        const wrong =
          questions.filter(
            q =>
              q.result ===
              "wrong"
          ).length;

        const empty =
          questions.filter(
            q =>
              q.result ===
              "empty"
          ).length;

        const total =
          questions.length;

        const score =
          total > 0
            ? calculateScore20(
                correct,
                total
              )
            : 0;

        return json(
          {
            ok: true,

            student: {
              name:
                data.name,

              phone:
                data.phone,
            },

            payment: {
              amount:
                data.amount,

              status:
                data.payment_status,

              createdAt:
                data.created_at,

              paidAt:
                data.paid_at,
            },

            attempt: {
              id:
                data.attempt_id,

              orderId:
                data.order_id,

              examId:
                data.exam_id,

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
      // =========================================================
      if (
        request.method === "DELETE" &&
        url.pathname ===
          "/api/teacher/student"
      ) {

        const orderId =
          String(
            url.searchParams.get(
              "orderId"
            ) || ""
          ).trim();

        if (!orderId) {
          return json(
            {
              ok: false,
              error:
                "orderId الزامی است",
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
              error:
                "دانش‌آموز پیدا نشد",
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
              orderId:
                order.id,

              examId:
                order.exam_id,

              name:
                order.name,

              phone:
                order.phone,
            },

            deleted: {
              orders: 1,

              attempts:
                Number(
                  attemptCount?.count || 0
                ),

              attemptQuestions:
                Number(
                  attemptQuestionsCount?.count ||
                  0
                ),

              attemptAnswers:
                Number(
                  attemptAnswersCount?.count ||
                  0
                ),
            },
          },
          200,
          cors
        );
      }


      // =========================================================
      // DELETE /api/teacher/students
      // =========================================================
      if (
        request.method === "DELETE" &&
        url.pathname ===
          "/api/teacher/students"
      ) {

        const examId =
          Number(
            url.searchParams.get(
              "examId"
            ) || 1
          );

        if (
          !Number.isInteger(examId) ||
          examId <= 0
        ) {
          return json(
            {
              ok: false,
              error:
                "examId نامعتبر است",
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
                Number(
                  orderCount?.count || 0
                ),

              attempts:
                Number(
                  attemptCount?.count || 0
                ),

              attemptQuestions:
                Number(
                  attemptQuestionsCount?.count ||
                  0
                ),

              attemptAnswers:
                Number(
                  attemptAnswersCount?.count ||
                  0
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
        return env.ASSETS.fetch(
          request
        );
      }

      return json(
        {
          ok: false,
          error:
            "مسیر پیدا نشد",
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
// قیمت مؤثر آزمون
// =============================================================
function getEffectivePrice(
  exam,
  now = new Date()
) {

  const basePrice =
    Math.max(
      0,
      Math.round(
        Number(
          exam?.price || 0
        )
      )
    );

  const discountEnabled =
    Number(
      exam?.discount_enabled || 0
    ) === 1;

  const discountPercent =
    Math.max(
      0,
      Math.min(
        100,
        Number(
          exam?.discount_percent || 0
        )
      )
    );

  const discountStartAt =
    exam?.discount_start_at ||
    null;

  const discountEndAt =
    exam?.discount_end_at ||
    null;

  if (
    !discountEnabled
  ) {
    return {
      basePrice,
      finalPrice:
        basePrice,

      discountEnabled:
        false,

      discountActive:
        false,

      discountPercent:
        0,

      discountStartAt,
      discountEndAt,
    };
  }

  if (
    discountPercent <= 0
  ) {
    return {
      basePrice,
      finalPrice:
        basePrice,

      discountEnabled:
        true,

      discountActive:
        false,

      discountPercent:
        0,

      discountStartAt,
      discountEndAt,
    };
  }

  if (
    !discountStartAt ||
    !discountEndAt
  ) {
    return {
      basePrice,
      finalPrice:
        basePrice,

      discountEnabled:
        true,

      discountActive:
        false,

      discountPercent,

      discountStartAt,
      discountEndAt,
    };
  }

  const nowMs =
    new Date(
      now
    ).getTime();

  const startMs =
    new Date(
      discountStartAt
    ).getTime();

  const endMs =
    new Date(
      discountEndAt
    ).getTime();

  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs)
  ) {
    return {
      basePrice,
      finalPrice:
        basePrice,

      discountEnabled:
        true,

      discountActive:
        false,

      discountPercent,

      discountStartAt,
      discountEndAt,
    };
  }

  const discountActive =
    nowMs >= startMs &&
    nowMs <= endMs;

  if (!discountActive) {
    return {
      basePrice,
      finalPrice:
        basePrice,

      discountEnabled:
        true,

      discountActive:
        false,

      discountPercent,

      discountStartAt,
      discountEndAt,
    };
  }

  const finalPrice =
    Math.max(
      0,
      Math.round(
        basePrice *
        (
          1 -
          discountPercent / 100
        )
      )
    );

  return {
    basePrice,

    finalPrice,

    discountEnabled:
      true,

    discountActive:
      true,

    discountPercent,

    discountStartAt,
    discountEndAt,
  };
}


// =============================================================
// انتخاب سوالات آزمون
// =============================================================
async function selectQuestionsForExam(
  env,
  examId
) {

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

  for (
    const rule of rules
  ) {

    const count =
      Number(
        rule.selection_count || 0
      );

    if (count <= 0) {
      continue;
    }

    let rows = [];

    if (
      rule.selection_mode ===
      "manual"
    ) {

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
            ORDER BY
              emq.sort_order,
              q.id
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

    if (
      rows.length < count
    ) {
      throw new Error(
        `در پوشه ${rule.folder_id} به تعداد ${count} سوال فعال وجود ندارد`
      );
    }

    selected.push(
      ...rows
    );
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

  const duration =
    Number(
      q.duration_seconds || 30
    );

  return {

    id:
      q.id,

    question:
      q.question_text,

    options: [
      q.option_a,
      q.option_b,
      q.option_c,
      q.option_d,
    ],

    durationSeconds:
      duration,

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
      duration,
  };
}


// =============================================================
// سوال snapshot برای student
// =============================================================
function publicSnapshotQuestion(q) {

  if (!q) {
    return null;
  }

  const duration =
    Number(
      q.duration_seconds_snapshot ||
      30
    );

  return {

    id:
      q.question_id,

    question:
      q.question_text_snapshot,

    options: [
      q.option_a_snapshot,
      q.option_b_snapshot,
      q.option_c_snapshot,
      q.option_d_snapshot,
    ],

    durationSeconds:
      duration,

    question_text:
      q.question_text_snapshot,

    option_a:
      q.option_a_snapshot,

    option_b:
      q.option_b_snapshot,

    option_c:
      q.option_c_snapshot,

    option_d:
      q.option_d_snapshot,

    duration_seconds:
      duration,
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
    questions[
      questionIndex
    ] || null
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
    Number(
      correct || 0
    );

  total =
    Number(
      total || 0
    );

  if (
    total <= 0
  ) {
    return 0;
  }

  const score =
    (
      correct /
      total
    ) * 20;

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
    throw new Error(
      "آزمون پیدا نشد"
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
    rows.results || [];

  let correct = 0;
  let wrong = 0;
  let empty = 0;

  const sheet =
    questions.map(
      row => {

        let result =
          "empty";

        if (
          row.selected_index !== null &&
          row.selected_index !== undefined
        ) {

          if (
            Number(
              row.selected_index
            ) ===
            Number(
              row.correct_index_snapshot
            )
          ) {

            correct++;

            result =
              "correct";

          } else {

            wrong++;

            result =
              "wrong";
          }

        } else {

          empty++;
        }

        return {

          number:
            Number(
              row.question_order
            ) + 1,

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
      }
    );

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

    startedAt:
      attempt.started_at || null,

    finishedAt:
      attempt.finished_at || null,

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
    throw new Error(
      "آزمون پیدا نشد"
    );
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

  for (
    const answer of answers
  ) {

    answerMap.set(
      Number(
        answer.question_index
      ),
      answer.selected_index
    );
  }

  let correct = 0;
  let wrong = 0;
  let empty = 0;

  const sheet =
    questions.map(
      (q, index) => {

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
          Number(
            selectedIndex
          ) ===
          Number(
            q.correct_index
          )
        ) {

          correct++;

          result =
            "correct";

        } else {

          wrong++;

          result =
            "wrong";
        }

        return {

          number:
            index + 1,

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
      }
    );

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
          COALESCE(
            finished_at,
            ?
          ),
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
function normalizePhone(
  value
) {

  let phone =
    String(
      value || ""
    )
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
