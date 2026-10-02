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


        // =================================================
        // اگر قبلاً آزمون شروع شده
        // =================================================
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


          // -----------------------------------------------
          // آزمون جدید با attempt_questions
          // -----------------------------------------------
          const savedQuestions = await env.DB.prepare(`
            SELECT
              id,
              question_id,
              question_order,
              question_text_snapshot,
              option_a_snapshot,
              option_b_snapshot,
              option_c_snapshot,
              option_d_snapshot,
              duration_seconds_snapshot,
              started_at
            FROM attempt_questions
            WHERE attempt_id = ?
            ORDER BY question_order
          `)
            .bind(existing.id)
            .all();

          const savedRows =
            savedQuestions.results || [];

          if (savedRows.length > 0) {

            const currentIndex =
              Number(existing.current_question || 0);

            let currentQuestion =
              savedRows.find(
                q =>
                  Number(q.question_order) ===
                  currentIndex
              );

            if (!currentQuestion) {
              return json({
                ok: false,
                error: "سؤال فعلی پیدا نشد."
              }, 400);
            }


            // اگر سؤال فعلی هنوز شروع نشده، زمان شروع را ثبت کن
            let questionStartedAt =
              currentQuestion.started_at;

            if (!questionStartedAt) {

              questionStartedAt =
                new Date().toISOString();

              await env.DB.prepare(`
                UPDATE attempt_questions
                SET started_at = ?
                WHERE id = ?
              `)
                .bind(
                  questionStartedAt,
                  currentQuestion.id
                )
                .run();

              await env.DB.prepare(`
                UPDATE attempts
                SET question_started_at = ?
                WHERE id = ?
              `)
                .bind(
                  questionStartedAt,
                  existing.id
                )
                .run();
            }

            return json({
              ok: true,
              attemptId: existing.id,
              startedAt: existing.started_at,
              currentQuestion: currentIndex,
              questionStartedAt,
              alreadyStarted: true,
              question:
                publicSnapshotQuestion(
                  currentQuestion
                )
            });
          }


          // -----------------------------------------------
          // سازگاری با آزمون‌های قدیمی
          // -----------------------------------------------
          const currentIndex =
            Number(existing.current_question || 0);

          const currentQuestion =
            await getQuestion(
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
            question:
              publicQuestion(currentQuestion)
          });
        }


        // =================================================
        // آزمون جدید
        // انتخاب سؤال از پوشه‌ها
        // =================================================
        const selectedQuestions =
          await selectQuestionsForExam(
            env,
            order.exam_id
          );

        if (!selectedQuestions.length) {
          return json({
            ok: false,
            error:
              "برای این آزمون سؤال قابل انتخاب وجود ندارد."
          }, 400);
        }


        const attemptId =
          crypto.randomUUID();

        const startedAt =
          new Date().toISOString();


        // -----------------------------------------------
        // ساخت attempt
        // -----------------------------------------------
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


        // -----------------------------------------------
        // ذخیره Snapshot سؤال‌ها
        // -----------------------------------------------
        for (
          let i = 0;
          i < selectedQuestions.length;
          i++
        ) {

          const q =
            selectedQuestions[i];

          await env.DB.prepare(`
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
            .run();
        }


        const firstQuestion =
          selectedQuestions[0];


        return json({
          ok: true,
          attemptId,
          startedAt,
          currentQuestion: 0,
          questionStartedAt: startedAt,
          alreadyStarted: false,
          question:
            publicQuestion(
              firstQuestion
            )
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

        if (
          Number(attempt.current_question) !==
          questionIndex
        ) {
          return json({
            ok: false,
            error:
              "این سؤال دیگر قابل پاسخ‌گویی نیست."
          }, 409);
        }


        // =================================================
        // سؤال Snapshot شده
        // =================================================
        let question =
          await env.DB.prepare(`
            SELECT
              id,
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
            FROM attempt_questions
            WHERE attempt_id = ?
              AND question_order = ?
          `)
            .bind(
              attemptId,
              questionIndex
            )
            .first();


        // =================================================
        // سازگاری با آزمون‌های قدیمی
        // =================================================
        let isSnapshot = true;

        if (!question) {

          isSnapshot = false;

          question =
            await getQuestion(
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
        }


        const now =
          new Date();


        const questionStarted =
          isSnapshot
            ? new Date(
                question.started_at ||
                attempt.question_started_at
              )
            : new Date(
                attempt.question_started_at
              );


        const elapsedSeconds =
          (
            now.getTime() -
            questionStarted.getTime()
          ) / 1000;


        const duration =
          isSnapshot
            ? Number(
                question.duration_seconds_snapshot ||
                30
              )
            : Number(
                question.duration_seconds ||
                30
              );


        // اگر زمان تمام شده باشد
        if (elapsedSeconds > duration) {
          selectedIndex = null;
        }


        // =================================================
        // ثبت پاسخ
        // =================================================
        if (isSnapshot) {

          const isCorrect =
            selectedIndex !== null &&
            selectedIndex ===
              Number(
                question.correct_index_snapshot
              )
              ? 1
              : 0;


          await env.DB.prepare(`
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
              now.toISOString(),
              Math.round(elapsedSeconds),
              isCorrect,
              attemptId,
              questionIndex
            )
            .run();

        } else {

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
        }


        // =================================================
        // سؤال بعدی
        // =================================================
        const nextIndex =
          questionIndex + 1;


        if (isSnapshot) {

          const nextQuestion =
            await env.DB.prepare(`
              SELECT
                id,
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
              FROM attempt_questions
              WHERE attempt_id = ?
                AND question_order = ?
            `)
              .bind(
                attemptId,
                nextIndex
              )
              .first();


          if (nextQuestion) {

            const nextStartedAt =
              now.toISOString();


            await env.DB.prepare(`
              UPDATE attempt_questions
              SET started_at = ?
              WHERE attempt_id = ?
                AND question_order = ?
            `)
              .bind(
                nextStartedAt,
                attemptId,
                nextIndex
              )
              .run();


            await env.DB.prepare(`
              UPDATE attempts
              SET
                current_question = ?,
                question_started_at = ?
              WHERE id = ?
            `)
              .bind(
                nextIndex,
                nextStartedAt,
                attemptId
              )
              .run();


            return json({
              ok: true,
              finished: false,
              timedOut:
                elapsedSeconds > duration,
              currentQuestion:
                nextIndex,
              questionStartedAt:
                nextStartedAt,
              question:
                publicSnapshotQuestion(
                  nextQuestion
                )
            });
          }


          // ---------------------------------------------
          // پایان آزمون Snapshot
          // ---------------------------------------------
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


        // =================================================
        // مسیر قدیمی
        // =================================================
        const nextQuestion =
          await getQuestion(
            env,
            attempt.exam_id,
            nextIndex
          );


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
            currentQuestion:
              nextIndex,
            questionStartedAt:
              now.toISOString(),
            question:
              publicQuestion(
                nextQuestion
              )
          });
        }


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


        // =================================================
        // اگر Snapshot وجود دارد
        // =================================================
        const savedQuestions =
          await env.DB.prepare(`
            SELECT
              question_order,
              question_text_snapshot,
              option_a_snapshot,
              option_b_snapshot,
              option_c_snapshot,
              option_d_snapshot,
              correct_index_snapshot,
              selected_index,
              elapsed_seconds
            FROM attempt_questions
            WHERE attempt_id = ?
            ORDER BY question_order
          `)
            .bind(attemptId)
            .all();


        const savedRows =
          savedQuestions.results || [];


        if (savedRows.length > 0) {

          let correct = 0;
          let wrong = 0;
          let empty = 0;

          const sheet = [];


          for (const q of savedRows) {

            const selected =
              q.selected_index === null ||
              q.selected_index === undefined
                ? null
                : Number(
                    q.selected_index
                  );


            const correctIndex =
              Number(
                q.correct_index_snapshot
              );


            if (selected === null) {
              empty++;
            } else if (
              selected === correctIndex
            ) {
              correct++;
            } else {
              wrong++;
            }


            sheet.push({
              number:
                Number(q.question_order) + 1,

              question:
                q.question_text_snapshot,

              selected,

              correct:
                correctIndex,

              elapsedSeconds:
                q.elapsed_seconds === null
                  ? null
                  : Number(
                      q.elapsed_seconds
                    ),

              options: [
                q.option_a_snapshot,
                q.option_b_snapshot,
                q.option_c_snapshot,
                q.option_d_snapshot
              ]
            });
          }


          const total =
            savedRows.length;


          const score =
            total > 0
              ? Number(
                  (
                    (correct / total) *
                    100
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
              score,
              startedAt: attempt.started_at,
              finishedAt: finishedAt
            },

            sheet
          });
        }


        // =================================================
        // نتیجه آزمون‌های قدیمی
        // =================================================
        return await buildLegacyResult(
          env,
          attempt
        );
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
// انتخاب سؤال برای آزمون
// =====================================================

async function selectQuestionsForExam(
  env,
  examId
) {

  const rules =
    await env.DB.prepare(`
      SELECT
        r.id,
        r.folder_id,
        r.selection_count,
        r.selection_mode,
        f.name AS folder_name
      FROM exam_folder_rules r
      JOIN question_folders f
        ON f.id = r.folder_id
      WHERE r.exam_id = ?
        AND f.active = 1
        AND r.selection_count > 0
      ORDER BY r.id
    `)
      .bind(examId)
      .all();

  const ruleRows =
    rules.results || [];

  const selected = [];


  for (const rule of ruleRows) {

    const count =
      Number(
        rule.selection_count || 0
      );


    if (count <= 0) {
      continue;
    }


    const mode =
      String(
        rule.selection_mode ||
        "random"
      ).toLowerCase();


    let rows = [];


    // ===================================================
    // حالت دستی
    // ===================================================
    if (mode === "manual") {

      const manual =
        await env.DB.prepare(`
          SELECT
            q.id,
            q.question_text,
            q.option_a,
            q.option_b,
            q.option_c,
            q.option_d,
            q.correct_index,
            q.duration_seconds
          FROM exam_manual_questions m
          JOIN questions q
            ON q.id = m.question_id
          WHERE m.exam_id = ?
            AND q.folder_id = ?
          ORDER BY m.sort_order, q.id
          LIMIT ?
        `)
          .bind(
            examId,
            rule.folder_id,
            count
          )
          .all();


      rows =
        manual.results || [];

    } else {

      // =================================================
      // حالت تصادفی
      // =================================================
      const random =
        await env.DB.prepare(`
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
          WHERE folder_id = ?
            AND (
              active IS NULL
              OR active = 1
            )
          ORDER BY RANDOM()
          LIMIT ?
        `)
          .bind(
            rule.folder_id,
            count
          )
          .all();


      rows =
        random.results || [];
    }


    // اگر سؤال کافی نبود، آزمون را ناقص شروع نکن
    if (rows.length < count) {
      throw new Error(
        `در ${rule.folder_name} فقط ${rows.length} سؤال موجود است ولی ${count} سؤال لازم است.`
      );
    }


    selected.push(...rows);
  }


  // =====================================================
  // اگر هیچ Rule ثبت نشده بود
  // برای سازگاری با آزمون فعلی
  // =====================================================
  if (selected.length === 0) {

    const legacy =
      await env.DB.prepare(`
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
      `)
        .bind(examId)
        .all();


    return legacy.results || [];
  }


  return selected;
}


// =====================================================
// سؤال عمومی Snapshot
// =====================================================

function publicSnapshotQuestion(q) {

  return {
    id:
      q.question_id,

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
      Number(
        q.duration_seconds_snapshot || 30
      )
  };
}


// =====================================================
// سؤال معمولی
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


// =====================================================
// سؤال عمومی
// =====================================================

function publicQuestion(q) {

  return {
    id:
      q.id,

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


// =====================================================
// نتیجه آزمون Snapshot
// =====================================================

async function buildResult(
  env,
  attemptId
) {

  const attempt =
    await env.DB.prepare(`
      SELECT
        a.id,
        a.order_id,
        a.started_at,
        a.finished_at
      FROM attempts a
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


  const questions =
    await env.DB.prepare(`
      SELECT
        question_order,
        question_text_snapshot,
        option_a_snapshot,
        option_b_snapshot,
        option_c_snapshot,
        option_d_snapshot,
        correct_index_snapshot,
        selected_index,
        elapsed_seconds
      FROM attempt_questions
      WHERE attempt_id = ?
      ORDER BY question_order
    `)
      .bind(attemptId)
      .all();


  const rows =
    questions.results || [];


  let correct = 0;
  let wrong = 0;
  let empty = 0;


  const sheet = [];


  for (const q of rows) {

    const selected =
      q.selected_index === null ||
      q.selected_index === undefined
        ? null
        : Number(
            q.selected_index
          );


    const correctIndex =
      Number(
        q.correct_index_snapshot
      );


    if (selected === null) {
      empty++;
    } else if (
      selected === correctIndex
    ) {
      correct++;
    } else {
      wrong++;
    }


    sheet.push({
      number:
        Number(q.question_order) + 1,

      question:
        q.question_text_snapshot,

      selected,

      correct:
        correctIndex,

      elapsedSeconds:
        q.elapsed_seconds === null
          ? null
          : Number(
              q.elapsed_seconds
            ),

      options: [
        q.option_a_snapshot,
        q.option_b_snapshot,
        q.option_c_snapshot,
        q.option_d_snapshot
      ]
    });
  }


  const total =
    rows.length;


  const score =
    total > 0
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
      score,
      startedAt: attempt.started_at,
      finishedAt: attempt.finished_at
    },

    sheet
  });
}


// =====================================================
// نتیجه آزمون‌های قدیمی
// =====================================================

async function buildLegacyResult(
  env,
  attempt
) {

  const questions =
    await env.DB.prepare(`
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


  const answers =
    await env.DB.prepare(`
      SELECT
        question_index,
        selected_index
      FROM attempt_answers
      WHERE attempt_id = ?
      ORDER BY question_index
    `)
      .bind(attempt.id)
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
        : Number(
            a.selected_index
          );
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


  const total =
    rows.length;


  const score =
    total > 0
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
      score,
      startedAt: attempt.started_at,
      finishedAt: attempt.finished_at
    },

    sheet
  });
}


// =====================================================
// CORS
// =====================================================

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


// =====================================================
// JSON
// =====================================================

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


// =====================================================
// تبدیل شماره موبایل
// =====================================================

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
