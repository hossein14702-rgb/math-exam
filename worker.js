export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = getCorsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors,
      });
    }

    try {

      // =========================================================
      // POST /api/teacher/login
      // =========================================================
      if (
        request.method === "POST" &&
        url.pathname === "/api/teacher/login"
      ) {
        const body = await request.json().catch(() => ({}));
        const username = String(body.username || "").trim();
        const password = String(body.password || "");

        const expectedUser = String(env.TEACHER_USERNAME || "");
        const expectedPass = String(env.TEACHER_PASSWORD || "");

        if (
          !expectedUser ||
          !expectedPass ||
          username !== expectedUser ||
          password !== expectedPass
        ) {
          return json(
            {
              ok: false,
              error: "نام کاربری یا رمز عبور اشتباه است",
            },
            401,
            cors
          );
        }

        const token =
          crypto.randomUUID() +
          "-" +
          crypto.randomUUID() +
          "-" +
          crypto.randomUUID();

        const tokenHash = await hashToken(token);
        const now = new Date();
        const expiresAt = new Date(
          now.getTime() + 7 * 24 * 60 * 60 * 1000
        ).toISOString();
        const sessionId = crypto.randomUUID();

        await env.DB
          .prepare(`
            INSERT INTO teacher_sessions (
              id,
              token_hash,
              expires_at,
              created_at
            )
            VALUES (?, ?, ?, ?)
          `)
          .bind(
            sessionId,
            tokenHash,
            expiresAt,
            now.toISOString()
          )
          .run();

        const headers = {
          ...cors,
          "Set-Cookie": buildSessionCookie(token, 7 * 24 * 60 * 60),
        };

        return new Response(
          JSON.stringify({
            ok: true,
            message: "ورود با موفقیت انجام شد",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=UTF-8",
              ...headers,
            },
          }
        );
      }


      // =========================================================
      // POST /api/teacher/logout
      // =========================================================
      if (
        request.method === "POST" &&
        url.pathname === "/api/teacher/logout"
      ) {
        const token = getCookie(request, "teacher_session");

        if (token) {
          const tokenHash = await hashToken(token);
          await env.DB
            .prepare(`
              DELETE FROM teacher_sessions
              WHERE token_hash = ?
            `)
            .bind(tokenHash)
            .run();
        }

        const headers = {
          ...cors,
          "Set-Cookie": clearSessionCookie(),
        };

        return new Response(
          JSON.stringify({
            ok: true,
            message: "خروج با موفقیت انجام شد",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=UTF-8",
              ...headers,
            },
          }
        );
      }


      // =========================================================
      // محافظت تمام مسیرهای /api/teacher/*
      // =========================================================
      if (url.pathname.startsWith("/api/teacher/")) {
        const session = await getValidTeacherSession(request, env);
        if (!session) {
          return json(
            {
              ok: false,
              error: "احراز هویت لازم است. لطفاً وارد شوید.",
            },
            401,
            cors
          );
        }
      }


      // =========================================================
      // GET /api/exam
      // =========================================================
      if (
        request.method === "GET" &&
        url.pathname === "/api/exam"
      ) {
        const examId = Number(
          url.searchParams.get("id") || 1
        );

        if (
          !Number.isInteger(examId) ||
          examId <= 0
        ) {
          return json(
            {
              ok: false,
              error: "examId نامعتبر است",
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
                efr.id,
                efr.folder_id,
                efr.selection_count,
                efr.selection_mode,
                f.name AS folder_name
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

        let questionCount = 0;

        if (rules.length) {
          questionCount =
            rules.reduce(
              (sum, row) =>
                sum +
                Number(row.selection_count || 0),
              0
            );
        } else {
          const countResult =
            await env.DB
              .prepare(`
                SELECT COUNT(*) AS count
                FROM questions
                WHERE exam_id = ?
                  AND active = 1
              `)
              .bind(examId)
              .first();

          questionCount =
            Number(countResult?.count || 0);
        }

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

            exam: {
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
            },

            questionCount,

            questions:
              (result.results || []).map(
                q => publicQuestion(q)
              ),
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
              error: "examId نامعتبر است",
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
              error: "آزمون پیدا نشد",
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
              id: exam.id,
              title: exam.title,
              active: exam.active,

              price:
                Number(exam.price || 0),

              discountEnabled:
                Number(
                  exam.discount_enabled || 0
                ) === 1,

              discountPercent:
                Number(
                  exam.discount_percent || 0
                ),

              discountStartAt:
                exam.discount_start_at || null,

              discountEndAt:
                exam.discount_end_at || null,
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
          Number(body.examId || 1);

        const price =
          Number(body.price);

        const discountEnabled =
          body.discountEnabled === true ||
          body.discountEnabled === 1 ||
          body.discountEnabled === "1";

        const discountPercent =
          Number(body.discountPercent || 0);

        let discountStartAt =
          body.discountStartAt
            ? String(body.discountStartAt).trim()
            : null;

        let discountEndAt =
          body.discountEndAt
            ? String(body.discountEndAt).trim()
            : null;

        if (
          !Number.isInteger(examId) ||
          examId <= 0
        ) {
          return json(
            {
              ok: false,
              error: "examId نامعتبر است",
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

        if (!Number.isInteger(price)) {
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
          !Number.isFinite(discountPercent) ||
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
            new Date(discountStartAt).getTime();

          const endMs =
            new Date(discountEndAt).getTime();

          if (
            !Number.isFinite(startMs) ||
            !Number.isFinite(endMs)
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

          if (endMs <= startMs) {
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
            discountEnabled ? 1 : 0,
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
              id: exam.id,
              title: exam.title,
              active: exam.active,

              price:
                Number(exam.price || 0),

              discountEnabled:
                Number(
                  exam.discount_enabled || 0
                ) === 1,

              discountPercent:
                Number(
                  exam.discount_percent || 0
                ),

              discountStartAt:
                exam.discount_start_at || null,

              discountEndAt:
                exam.discount_end_at || null,
            },

            pricing,
          },
          200,
          cors
        );
      }


      // =========================================================
      // GET /api/teacher/folders
      // =========================================================
      if (
        request.method === "GET" &&
        url.pathname === "/api/teacher/folders"
      ) {
        const examId =
          Number(
            url.searchParams.get("examId") || 1
          );

        const result =
          await env.DB
            .prepare(`
              SELECT
                f.id,
                f.name,
                f.active,
                f.created_at,
                COUNT(q.id) AS question_count,
                SUM(
                  CASE
                    WHEN q.active = 1 THEN 1
                    ELSE 0
                  END
                ) AS active_question_count
              FROM question_folders f
              LEFT JOIN questions q
                ON q.folder_id = f.id
               AND q.exam_id = ?
              GROUP BY
                f.id,
                f.name,
                f.active,
                f.created_at
              ORDER BY f.id
            `)
            .bind(examId)
            .all();

        return json(
          {
            ok: true,
            examId,
            folders:
              (result.results || []).map(row => ({
                id: row.id,
                name: row.name,
                active:
                  Number(row.active || 0) === 1,
                createdAt:
                  row.created_at,
                questionCount:
                  Number(row.question_count || 0),
                activeQuestionCount:
                  Number(
                    row.active_question_count || 0
                  ),
              })),
          },
          200,
          cors
        );
      }


      // =========================================================
      // POST /api/teacher/folders
      // =========================================================
      if (
        request.method === "POST" &&
        url.pathname === "/api/teacher/folders"
      ) {
        const body =
          await request.json();

        const action =
          String(
            body.action || "create"
          ).trim();

        if (action === "create") {

          const name =
            String(
              body.name || ""
            ).trim();

          if (!name) {
            return json(
              {
                ok: false,
                error:
                  "نام پوشه الزامی است",
              },
              400,
              cors
            );
          }

          const exists =
            await env.DB
              .prepare(`
                SELECT id
                FROM question_folders
                WHERE name = ?
                LIMIT 1
              `)
              .bind(name)
              .first();

          if (exists) {
            return json(
              {
                ok: false,
                error:
                  "پوشه‌ای با این نام وجود دارد",
              },
              400,
              cors
            );
          }

          const result =
            await env.DB
              .prepare(`
                INSERT INTO question_folders (
                  name,
                  active
                )
                VALUES (?, 1)
              `)
              .bind(name)
              .run();

          const folder =
            await env.DB
              .prepare(`
                SELECT
                  id,
                  name,
                  active,
                  created_at
                FROM question_folders
                WHERE id = ?
              `)
              .bind(result.meta.last_row_id)
              .first();

          return json(
            {
              ok: true,
              message:
                "پوشه با موفقیت ایجاد شد",
              folder,
            },
            200,
            cors
          );
        }

        if (action === "update") {

          const folderId =
            Number(body.folderId);

          const name =
            String(
              body.name || ""
            ).trim();

          if (
            !Number.isInteger(folderId) ||
            folderId <= 0
          ) {
            return json(
              {
                ok: false,
                error:
                  "folderId نامعتبر است",
              },
              400,
              cors
            );
          }

          if (!name) {
            return json(
              {
                ok: false,
                error:
                  "نام پوشه الزامی است",
              },
              400,
              cors
            );
          }

          const exists =
            await env.DB
              .prepare(`
                SELECT id
                FROM question_folders
                WHERE name = ?
                  AND id != ?
                LIMIT 1
              `)
              .bind(name, folderId)
              .first();

          if (exists) {
            return json(
              {
                ok: false,
                error:
                  "پوشه‌ای با این نام وجود دارد",
              },
              400,
              cors
            );
          }

          await env.DB
            .prepare(`
              UPDATE question_folders
              SET name = ?
              WHERE id = ?
            `)
            .bind(name, folderId)
            .run();

          return json(
            {
              ok: true,
              message:
                "نام پوشه با موفقیت تغییر کرد",
            },
            200,
            cors
          );
        }

        if (action === "toggle") {

          const folderId =
            Number(body.folderId);

          const active =
            body.active === true ||
            body.active === 1 ||
            body.active === "1"
              ? 1
              : 0;

          if (
            !Number.isInteger(folderId) ||
            folderId <= 0
          ) {
            return json(
              {
                ok: false,
                error:
                  "folderId نامعتبر است",
              },
              400,
              cors
            );
          }

          await env.DB
            .prepare(`
              UPDATE question_folders
              SET active = ?
              WHERE id = ?
            `)
            .bind(active, folderId)
            .run();

          return json(
            {
              ok: true,
              message:
                active
                  ? "پوشه فعال شد"
                  : "پوشه غیرفعال شد",
            },
            200,
            cors
          );
        }

        if (action === "delete") {

          const folderId =
            Number(body.folderId);

          if (
            !Number.isInteger(folderId) ||
            folderId <= 0
          ) {
            return json(
              {
                ok: false,
                error:
                  "folderId نامعتبر است",
              },
              400,
              cors
            );
          }

          const count =
            await env.DB
              .prepare(`
                SELECT COUNT(*) AS count
                FROM questions
                WHERE folder_id = ?
              `)
              .bind(folderId)
              .first();

          if (
            Number(count?.count || 0) > 0
          ) {
            return json(
              {
                ok: false,
                error:
                  "این پوشه هنوز دارای سؤال است. ابتدا سؤال‌ها را منتقل کنید.",
              },
              400,
              cors
            );
          }

          await env.DB
            .prepare(`
              DELETE FROM exam_folder_rules
              WHERE folder_id = ?
            `)
            .bind(folderId)
            .run();

          await env.DB
            .prepare(`
              DELETE FROM question_folders
              WHERE id = ?
            `)
            .bind(folderId)
            .run();

          return json(
            {
              ok: true,
              message:
                "پوشه حذف شد",
            },
            200,
            cors
          );
        }

        return json(
          {
            ok: false,
            error:
              "action نامعتبر است",
          },
          400,
          cors
        );
      }


      // =========================================================
      // GET /api/teacher/questions
      // =========================================================
      if (
        request.method === "GET" &&
        url.pathname === "/api/teacher/questions"
      ) {
        const examId =
          Number(
            url.searchParams.get("examId") || 1
          );

        const folderParam =
          url.searchParams.get("folderId");

        const search =
          String(
            url.searchParams.get("search") || ""
          ).trim();

        const activeParam =
          url.searchParams.get("active");

        let sql = `
          SELECT
            q.id,
            q.exam_id,
            q.question_text,
            q.option_a,
            q.option_b,
            q.option_c,
            q.option_d,
            q.correct_index,
            q.duration_seconds,
            q.folder_id,
            q.active,
            f.name AS folder_name
          FROM questions q
          LEFT JOIN question_folders f
            ON f.id = q.folder_id
          WHERE q.exam_id = ?
        `;

        const binds = [examId];

        if (
          folderParam !== null &&
          folderParam !== "" &&
          folderParam !== "all"
        ) {
          const folderId =
            Number(folderParam);

          if (
            Number.isInteger(folderId) &&
            folderId > 0
          ) {
            sql += `
              AND q.folder_id = ?
            `;
            binds.push(folderId);
          }
        }

        if (search) {
          sql += `
            AND q.question_text LIKE ?
          `;
          binds.push(`%${search}%`);
        }

        if (
          activeParam === "0" ||
          activeParam === "1"
        ) {
          sql += `
            AND q.active = ?
          `;
          binds.push(
            Number(activeParam)
          );
        }

        sql += `
          ORDER BY q.id DESC
        `;

        const result =
          await env.DB
            .prepare(sql)
            .bind(...binds)
            .all();

        return json(
          {
            ok: true,
            examId,

            questions:
              (result.results || []).map(
                q => teacherQuestion(q)
              ),
          },
          200,
          cors
        );
      }


      // =========================================================
      // POST /api/teacher/questions
      // =========================================================
      if (
        request.method === "POST" &&
        url.pathname === "/api/teacher/questions"
      ) {
        const body =
          await request.json();

        const action =
          String(
            body.action || "create"
          ).trim();

        if (
          action === "create" ||
          action === "update"
        ) {

          const examId =
            Number(
              body.examId || 1
            );

          const questionId =
            Number(
              body.questionId
            );

          const questionText =
            String(
              body.questionText ??
              body.question ??
              ""
            ).trim();

          const optionsResult =
            normalizeOptionsFromBody(body);

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

          if (!questionText) {
            return json(
              {
                ok: false,
                error:
                  "متن سؤال الزامی است",
              },
              400,
              cors
            );
          }

          if (!optionsResult.ok) {
            return json(
              {
                ok: false,
                error:
                  optionsResult.error,
              },
              400,
              cors
            );
          }

          const options =
            optionsResult.options;

          const correctIndex =
            Number(
              body.correctIndex
            );

          if (
            !Number.isInteger(correctIndex) ||
            correctIndex < 0 ||
            correctIndex >= options.length
          ) {
            return json(
              {
                ok: false,
                error:
                  "پاسخ صحیح نامعتبر است",
              },
              400,
              cors
            );
          }

          const durationSeconds =
            Number(
              body.durationSeconds ??
              body.duration_seconds ??
              30
            );

          if (
            !Number.isInteger(durationSeconds) ||
            durationSeconds <= 0 ||
            durationSeconds > 3600
          ) {
            return json(
              {
                ok: false,
                error:
                  "زمان سؤال باید بین 1 تا 3600 ثانیه باشد",
              },
              400,
              cors
            );
          }

          let folderId = null;

          if (
            body.folderId !== null &&
            body.folderId !== undefined &&
            body.folderId !== "" &&
            Number(body.folderId) > 0
          ) {
            folderId =
              Number(body.folderId);

            const folder =
              await env.DB
                .prepare(`
                  SELECT id
                  FROM question_folders
                  WHERE id = ?
                    AND active = 1
                `)
                .bind(folderId)
                .first();

            if (!folder) {
              return json(
                {
                  ok: false,
                  error:
                    "پوشه انتخاب‌شده معتبر یا فعال نیست",
                },
                400,
                cors
              );
            }
          }

          const optionA =
            options[0] || "";

          const optionB =
            options[1] || "";

          const optionC =
            options[2] || "";

          const optionD =
            options[3] || "";

          if (action === "create") {

            const result =
              await env.DB
                .prepare(`
                  INSERT INTO questions (
                    exam_id,
                    question_text,
                    option_a,
                    option_b,
                    option_c,
                    option_d,
                    correct_index,
                    duration_seconds,
                    folder_id,
                    active
                  )
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                `)
                .bind(
                  examId,
                  questionText,
                  optionA,
                  optionB,
                  optionC,
                  optionD,
                  correctIndex,
                  durationSeconds,
                  folderId
                )
                .run();

            const question =
              await env.DB
                .prepare(`
                  SELECT
                    q.*,
                    f.name AS folder_name
                  FROM questions q
                  LEFT JOIN question_folders f
                    ON f.id = q.folder_id
                  WHERE q.id = ?
                `)
                .bind(result.meta.last_row_id)
                .first();

            return json(
              {
                ok: true,
                message:
                  "سؤال با موفقیت ایجاد شد",
                question:
                  teacherQuestion(question),
              },
              200,
              cors
            );
          }

          if (action === "update") {

            if (
              !Number.isInteger(questionId) ||
              questionId <= 0
            ) {
              return json(
                {
                  ok: false,
                  error:
                    "questionId نامعتبر است",
                },
                400,
                cors
              );
            }

            const exists =
              await env.DB
                .prepare(`
                  SELECT id
                  FROM questions
                  WHERE id = ?
                    AND exam_id = ?
                `)
                .bind(
                  questionId,
                  examId
                )
                .first();

            if (!exists) {
              return json(
                {
                  ok: false,
                  error:
                    "سؤال پیدا نشد",
                },
                404,
                cors
              );
            }

            await env.DB
              .prepare(`
                UPDATE questions
                SET
                  question_text = ?,
                  option_a = ?,
                  option_b = ?,
                  option_c = ?,
                  option_d = ?,
                  correct_index = ?,
                  duration_seconds = ?,
                  folder_id = ?
                WHERE id = ?
                  AND exam_id = ?
              `)
              .bind(
                questionText,
                optionA,
                optionB,
                optionC,
                optionD,
                correctIndex,
                durationSeconds,
                folderId,
                questionId,
                examId
              )
              .run();

            const question =
              await env.DB
                .prepare(`
                  SELECT
                    q.*,
                    f.name AS folder_name
                  FROM questions q
                  LEFT JOIN question_folders f
                    ON f.id = q.folder_id
                  WHERE q.id = ?
                `)
                .bind(questionId)
                .first();

            return json(
              {
                ok: true,
                message:
                  "سؤال با موفقیت ویرایش شد",
                question:
                  teacherQuestion(question),
              },
              200,
              cors
            );
          }
        }


        // =======================================================
        // TOGGLE
        // =======================================================
        if (action === "toggle") {

          const questionId =
            Number(body.questionId);

          const active =
            body.active === true ||
            body.active === 1 ||
            body.active === "1"
              ? 1
              : 0;

          if (
            !Number.isInteger(questionId) ||
            questionId <= 0
          ) {
            return json(
              {
                ok: false,
                error:
                  "questionId نامعتبر است",
              },
              400,
              cors
            );
          }

          await env.DB
            .prepare(`
              UPDATE questions
              SET active = ?
              WHERE id = ?
            `)
            .bind(
              active,
              questionId
            )
            .run();

          return json(
            {
              ok: true,
              message:
                active
                  ? "سؤال فعال شد"
                  : "سؤال غیرفعال شد",
            },
            200,
            cors
          );
        }


        // =======================================================
        // MOVE
        // =======================================================
        if (action === "move") {

          const questionId =
            Number(body.questionId);

          let folderId = null;

          if (
            body.folderId !== null &&
            body.folderId !== undefined &&
            body.folderId !== "" &&
            Number(body.folderId) > 0
          ) {
            folderId =
              Number(body.folderId);

            const folder =
              await env.DB
                .prepare(`
                  SELECT id
                  FROM question_folders
                  WHERE id = ?
                    AND active = 1
                `)
                .bind(folderId)
                .first();

            if (!folder) {
              return json(
                {
                  ok: false,
                  error:
                    "پوشه معتبر نیست",
                },
                400,
                cors
              );
            }
          }

          await env.DB
            .prepare(`
              UPDATE questions
              SET folder_id = ?
              WHERE id = ?
            `)
            .bind(
              folderId,
              questionId
            )
            .run();

          return json(
            {
              ok: true,
              message:
                "سؤال به پوشه جدید منتقل شد",
            },
            200,
            cors
          );
        }


        // =======================================================
        // DELETE
        // =======================================================
        if (action === "delete") {

          const questionId =
            Number(body.questionId);

          if (
            !Number.isInteger(questionId) ||
            questionId <= 0
          ) {
            return json(
              {
                ok: false,
                error:
                  "questionId نامعتبر است",
              },
              400,
              cors
            );
          }

          await env.DB
            .prepare(`
              DELETE FROM exam_manual_questions
              WHERE question_id = ?
            `)
            .bind(questionId)
            .run();

          await env.DB
            .prepare(`
              DELETE FROM questions
              WHERE id = ?
            `)
            .bind(questionId)
            .run();

          return json(
            {
              ok: true,
              message:
                "سؤال حذف شد",
            },
            200,
            cors
          );
        }


        return json(
          {
            ok: false,
            error:
              "action نامعتبر است",
          },
          400,
          cors
        );
      }


      // =========================================================
      // GET /api/teacher/exam-rules
      // =========================================================
      if (
        request.method === "GET" &&
        url.pathname === "/api/teacher/exam-rules"
      ) {
        const examId =
          Number(
            url.searchParams.get("examId") || 1
          );

        const result =
          await env.DB
            .prepare(`
              SELECT
                efr.id,
                efr.exam_id,
                efr.folder_id,
                efr.selection_count,
                efr.selection_mode,
                f.name AS folder_name
              FROM exam_folder_rules efr
              JOIN question_folders f
                ON f.id = efr.folder_id
              WHERE efr.exam_id = ?
              ORDER BY efr.id
            `)
            .bind(examId)
            .all();

        return json(
          {
            ok: true,
            examId,
            rules:
              (result.results || []).map(row => ({
                id: row.id,
                examId: row.exam_id,
                folderId: row.folder_id,
                folderName: row.folder_name,
                selectionCount:
                  Number(
                    row.selection_count || 0
                  ),
                selectionMode:
                  row.selection_mode || "random",
              })),
          },
          200,
          cors
        );
      }


      // =========================================================
      // POST /api/teacher/exam-rules
      // =========================================================
      if (
        request.method === "POST" &&
        url.pathname === "/api/teacher/exam-rules"
      ) {
        const body =
          await request.json();

        const action =
          String(
            body.action || "create"
          ).trim();

        const examId =
          Number(
            body.examId || 1
          );

        if (
          action === "create" ||
          action === "update"
        ) {

          const folderId =
            Number(body.folderId);

          const selectionCount =
            Number(
              body.selectionCount ??
              body.selection_count ??
              0
            );

          const selectionMode =
            String(
              body.selectionMode ??
              body.selection_mode ??
              "random"
            ).trim();

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
            !Number.isInteger(folderId) ||
            folderId <= 0
          ) {
            return json(
              {
                ok: false,
                error:
                  "folderId نامعتبر است",
              },
              400,
              cors
            );
          }

          if (
            !Number.isInteger(selectionCount) ||
            selectionCount < 0
          ) {
            return json(
              {
                ok: false,
                error:
                  "تعداد سؤال نامعتبر است",
              },
              400,
              cors
            );
          }

          if (
            selectionMode !== "random" &&
            selectionMode !== "manual"
          ) {
            return json(
              {
                ok: false,
                error:
                  "روش انتخاب باید random یا manual باشد",
              },
              400,
              cors
            );
          }

          const folder =
            await env.DB
              .prepare(`
                SELECT id
                FROM question_folders
                WHERE id = ?
              `)
              .bind(folderId)
              .first();

          if (!folder) {
            return json(
              {
                ok: false,
                error:
                  "پوشه پیدا نشد",
              },
              404,
              cors
            );
          }

          if (action === "update") {

            const ruleId =
              Number(body.ruleId);

            if (
              !Number.isInteger(ruleId) ||
              ruleId <= 0
            ) {
              return json(
                {
                  ok: false,
                  error:
                    "ruleId نامعتبر است",
                },
                400,
                cors
              );
            }

            await env.DB
              .prepare(`
                UPDATE exam_folder_rules
                SET
                  folder_id = ?,
                  selection_count = ?,
                  selection_mode = ?
                WHERE id = ?
                  AND exam_id = ?
              `)
              .bind(
                folderId,
                selectionCount,
                selectionMode,
                ruleId,
                examId
              )
              .run();

            return json(
              {
                ok: true,
                message:
                  "قانون آزمون ویرایش شد",
              },
              200,
              cors
            );
          }

          const duplicate =
            await env.DB
              .prepare(`
                SELECT id
                FROM exam_folder_rules
                WHERE exam_id = ?
                  AND folder_id = ?
                LIMIT 1
              `)
              .bind(
                examId,
                folderId
              )
              .first();

          if (duplicate) {
            return json(
              {
                ok: false,
                error:
                  "این پوشه قبلاً برای آزمون ثبت شده است",
              },
              400,
              cors
            );
          }

          const result =
            await env.DB
              .prepare(`
                INSERT INTO exam_folder_rules (
                  exam_id,
                  folder_id,
                  selection_count,
                  selection_mode
                )
                VALUES (?, ?, ?, ?)
              `)
              .bind(
                examId,
                folderId,
                selectionCount,
                selectionMode
              )
              .run();

          return json(
            {
              ok: true,
              message:
                "قانون انتخاب سؤال اضافه شد",
              ruleId:
                result.meta.last_row_id,
            },
            200,
            cors
          );
        }


        if (action === "delete") {

          const ruleId =
            Number(body.ruleId);

          if (
            !Number.isInteger(ruleId) ||
            ruleId <= 0
          ) {
            return json(
              {
                ok: false,
                error:
                  "ruleId نامعتبر است",
              },
              400,
              cors
            );
          }

          await env.DB
            .prepare(`
              DELETE FROM exam_folder_rules
              WHERE id = ?
                AND exam_id = ?
            `)
            .bind(
              ruleId,
              examId
            )
            .run();

          return json(
            {
              ok: true,
              message:
                "قانون حذف شد",
            },
            200,
            cors
          );
        }

        return json(
          {
            ok: false,
            error:
              "action نامعتبر است",
          },
          400,
          cors
        );
      }


      // =========================================================
      // GET /api/teacher/manual-questions
      // =========================================================
      if (
        request.method === "GET" &&
        url.pathname === "/api/teacher/manual-questions"
      ) {
        const examId =
          Number(
            url.searchParams.get("examId") || 1
          );

        const folderParam =
          url.searchParams.get("folderId");

        let sql = `
          SELECT
            emq.exam_id,
            emq.question_id,
            emq.sort_order,
            q.question_text,
            q.folder_id,
            f.name AS folder_name
          FROM exam_manual_questions emq
          JOIN questions q
            ON q.id = emq.question_id
          LEFT JOIN question_folders f
            ON f.id = q.folder_id
          WHERE emq.exam_id = ?
        `;

        const binds = [examId];

        if (
          folderParam !== null &&
          folderParam !== ""
        ) {
          const folderId =
            Number(folderParam);

          if (
            Number.isInteger(folderId) &&
            folderId > 0
          ) {
            sql += `
              AND q.folder_id = ?
            `;
            binds.push(folderId);
          }
        }

        sql += `
          ORDER BY
            emq.sort_order,
            emq.question_id
        `;

        const result =
          await env.DB
            .prepare(sql)
            .bind(...binds)
            .all();

        return json(
          {
            ok: true,
            examId,
            questions:
              result.results || [],
          },
          200,
          cors
        );
      }


      // =========================================================
      // POST /api/teacher/manual-questions
      // =========================================================
      if (
        request.method === "POST" &&
        url.pathname === "/api/teacher/manual-questions"
      ) {
        const body =
          await request.json();

        const action =
          String(
            body.action || "add"
          ).trim();

        const examId =
          Number(
            body.examId || 1
          );

        const questionId =
          Number(body.questionId);

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
          !Number.isInteger(questionId) ||
          questionId <= 0
        ) {
          return json(
            {
              ok: false,
              error:
                "questionId نامعتبر است",
            },
            400,
            cors
          );
        }

        if (action === "add") {

          const question =
            await env.DB
              .prepare(`
                SELECT
                  id,
                  exam_id
                FROM questions
                WHERE id = ?
                  AND exam_id = ?
                  AND active = 1
              `)
              .bind(
                questionId,
                examId
              )
              .first();

          if (!question) {
            return json(
              {
                ok: false,
                error:
                  "سؤال فعال برای این آزمون پیدا نشد",
              },
              404,
              cors
            );
          }

          const exists =
            await env.DB
              .prepare(`
                SELECT
                  exam_id,
                  question_id
                FROM exam_manual_questions
                WHERE exam_id = ?
                  AND question_id = ?
              `)
              .bind(
                examId,
                questionId
              )
              .first();

          if (exists) {
            return json(
              {
                ok: false,
                error:
                  "این سؤال قبلاً اضافه شده است",
              },
              400,
              cors
            );
          }

          const maxOrder =
            await env.DB
              .prepare(`
                SELECT
                  COALESCE(
                    MAX(sort_order),
                    -1
                  ) AS max_order
                FROM exam_manual_questions
                WHERE exam_id = ?
              `)
              .bind(examId)
              .first();

          const sortOrder =
            Number(
              maxOrder?.max_order ?? -1
            ) + 1;

          await env.DB
            .prepare(`
              INSERT INTO exam_manual_questions (
                exam_id,
                question_id,
                sort_order
              )
              VALUES (?, ?, ?)
            `)
            .bind(
              examId,
              questionId,
              sortOrder
            )
            .run();

          return json(
            {
              ok: true,
              message:
                "سؤال به انتخاب دستی اضافه شد",
            },
            200,
            cors
          );
        }

        if (action === "remove") {

          await env.DB
            .prepare(`
              DELETE FROM exam_manual_questions
              WHERE exam_id = ?
                AND question_id = ?
            `)
            .bind(
              examId,
              questionId
            )
            .run();

          return json(
            {
              ok: true,
              message:
                "سؤال از انتخاب دستی حذف شد",
            },
            200,
            cors
          );
        }

        if (action === "reorder") {

          const items =
            Array.isArray(body.items)
              ? body.items
              : [];

          if (!items.length) {
            return json(
              {
                ok: false,
                error:
                  "لیست ترتیب خالی است",
              },
              400,
              cors
            );
          }

          const statements = [];

          for (
            let i = 0;
            i < items.length;
            i++
          ) {
            const qid =
              Number(
                items[i]?.questionId
              );

            if (
              !Number.isInteger(qid) ||
              qid <= 0
            ) {
              continue;
            }

            statements.push(
              env.DB
                .prepare(`
                  UPDATE exam_manual_questions
                  SET sort_order = ?
                  WHERE exam_id = ?
                    AND question_id = ?
                `)
                .bind(
                  i,
                  examId,
                  qid
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
              message:
                "ترتیب سؤال‌ها ذخیره شد",
            },
            200,
            cors
          );
        }

        return json(
          {
            ok: false,
            error:
              "action نامعتبر است",
          },
          400,
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

        if (
          !/^09\d{9}$/.test(phone)
        ) {
          return json(
            {
              ok: false,
              error:
                "شماره موبایل نامعتبر است",
            },
            400,
            cors
          );
        }

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

        if (
          !Number.isInteger(amount) ||
          amount <= 0
        ) {
          return json(
            {
              ok: false,
              error:
                "مبلغ پرداخت نامعتبر است",
            },
            400,
            cors
          );
        }

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

        // =====================================================
        // اتصال به VPS پرداخت
        // =====================================================

        const vpsBase =
          String(
            env.VPS_BASE_URL || ""
          ).trim();

        if (!vpsBase) {
          return json(
            {
              ok: true,
              paymentReady: false,
              orderId,
              amount,
              message:
                "سفارش ایجاد شد. درگاه پرداخت هنوز فعال نشده است.",
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

        const callbackUrl =
          `\( {url.origin}/api/payment/callback?orderId= \){encodeURIComponent(orderId)}`;

        let paymentResponse;

        try {

          const vpsResponse =
            await fetch(
              `\( {vpsBase.replace(/\/+ \)/, "")}/pay`,
              {
                method: "POST",

                headers: {
                  "Content-Type":
                    "application/json",

                  ...(env.PAYMENT_VPS_SECRET
                    ? {
                        "X-Bridge-Secret":
                          String(
                            env.PAYMENT_VPS_SECRET
                          ),
                      }
                    : {}),
                },

                body:
                  JSON.stringify({
                    orderId,
                    amount,
                    description:
                      `پرداخت آزمون ${examId} - ${name}`,
                    callbackUrl,
                    phone,
                  }),
              }
            );

          paymentResponse =
            await vpsResponse.json();

        } catch (error) {

          console.error(
            "VPS payment request error:",
            error
          );

          return json(
            {
              ok: false,
              error:
                "ارتباط با سرور پرداخت برقرار نشد",
              orderId,
            },
            502,
            cors
          );
        }

        if (
          !paymentResponse ||
          paymentResponse.ok !== true ||
          !paymentResponse.authority ||
          !paymentResponse.paymentUrl
        ) {

          console.error(
            "Invalid VPS payment response:",
            paymentResponse
          );

          return json(
            {
              ok: false,
              error:
                paymentResponse?.error ||
                "ایجاد پرداخت ناموفق بود",
              orderId,
            },
            502,
            cors
          );
        }

        const authority =
          String(
            paymentResponse.authority
          ).trim();

        await env.DB
          .prepare(`
            UPDATE orders
            SET
              authority = ?
            WHERE id = ?
          `)
          .bind(
            authority,
            orderId
          )
          .run();

        return json(
          {
            ok: true,
            paymentReady: true,
            orderId,
            amount,
            authority,
            paymentUrl:
              paymentResponse.paymentUrl,

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
      // GET /api/payment/callback
      // =========================================================
      if (
        request.method === "GET" &&
        url.pathname === "/api/payment/callback"
      ) {

        const orderId =
          String(
            url.searchParams.get("orderId") || ""
          ).trim();

        const authority =
          String(
            url.searchParams.get("Authority") ||
            ""
          ).trim();

        const status =
          String(
            url.searchParams.get("Status") ||
            ""
          ).trim()
          .toUpperCase();

        if (!orderId) {
          return paymentRedirect(
            env,
            false,
            null,
            "شناسه سفارش وجود ندارد"
          );
        }

        const order =
          await env.DB
            .prepare(`
              SELECT
                id,
                exam_id,
                name,
                phone,
                amount,
                status,
                authority,
                ref_id
              FROM orders
              WHERE id = ?
            `)
            .bind(orderId)
            .first();

        if (!order) {
          return paymentRedirect(
            env,
            false,
            orderId,
            "سفارش پیدا نشد"
          );
        }

        if (order.status === "paid") {
          return paymentRedirect(
            env,
            true,
            orderId,
            "پرداخت قبلاً تأیید شده است"
          );
        }

        if (
          status !== "OK" ||
          !authority
        ) {
          return paymentRedirect(
            env,
            false,
            orderId,
            "پرداخت توسط درگاه تأیید نشد"
          );
        }

        const vpsBase =
          String(
            env.VPS_BASE_URL || ""
          ).trim();

        if (!vpsBase) {
          return paymentRedirect(
            env,
            false,
            orderId,
            "سرور پرداخت هنوز تنظیم نشده است"
          );
        }

        let verifyResponse;

        try {

          const vpsResponse =
            await fetch(
              `\( {vpsBase.replace(/\/+ \)/, "")}/verify`,
              {
                method: "POST",

                headers: {
                  "Content-Type":
                    "application/json",

                  ...(env.PAYMENT_VPS_SECRET
                    ? {
                        "X-Bridge-Secret":
                          String(
                            env.PAYMENT_VPS_SECRET
                          ),
                      }
                    : {}),
                },

                body:
                  JSON.stringify({
                    orderId,
                    authority,
                    amount:
                      Number(order.amount),
                  }),
              }
            );

          verifyResponse =
            await vpsResponse.json();

        } catch (error) {

          console.error(
            "VPS verify error:",
            error
          );

          return paymentRedirect(
            env,
            false,
            orderId,
            "ارتباط با سرور پرداخت برقرار نشد"
          );
        }

        if (
          !verifyResponse ||
          verifyResponse.ok !== true
        ) {

          return paymentRedirect(
            env,
            false,
            orderId,
            verifyResponse?.error ||
              "پرداخت تأیید نشد"
          );
        }

        const refId =
          verifyResponse.ref_id ??
          verifyResponse.refId ??
          null;

        const paidAt =
          new Date().toISOString();

        const updateResult =
          await env.DB
            .prepare(`
              UPDATE orders
              SET
                status = 'paid',
                authority = ?,
                ref_id = ?,
                paid_at = ?
              WHERE id = ?
                AND status = 'pending'
            `)
            .bind(
              authority,
              refId !== null
                ? String(refId)
                : null,
              paidAt,
              orderId
            )
            .run();

        if (
          Number(
            updateResult?.meta?.changes || 0
          ) === 0
        ) {

          const current =
            await env.DB
              .prepare(`
                SELECT status
                FROM orders
                WHERE id = ?
              `)
              .bind(orderId)
              .first();

          if (
            current?.status === "paid"
          ) {
            return paymentRedirect(
              env,
              true,
              orderId,
              "پرداخت تأیید شده است"
            );
          }

          return paymentRedirect(
            env,
            false,
            orderId,
            "وضعیت سفارش قابل تأیید نیست"
          );
        }

        return paymentRedirect(
          env,
          true,
          orderId,
          "پرداخت با موفقیت تأیید شد"
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

        if (order.status !== "paid") {
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

          if (existingAttempt.finished_at) {
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
              .bind(existingAttempt.id)
              .all();

          if (
            snapshots.results &&
            snapshots.results.length > 0
          ) {

            let currentQuestion =
              Number(
                existingAttempt.current_question || 0
              );

            if (
              currentQuestion < 0 ||
              currentQuestion >=
                snapshots.results.length
            ) {
              currentQuestion = 0;
            }

            const current =
              snapshots.results[currentQuestion];

            if (!current.started_at) {

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

              current.started_at = now;
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
                  publicSnapshotQuestion(current),
              },
              200,
              cors
            );
          }
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
            normalizeQuestionForSnapshot(
              questions[i]
            );

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
                q.duration_seconds,
                i === 0
                  ? startedAt
                  : null
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

            totalQuestions:
              questions.length,

            questionStartedAt:
              startedAt,

            question:
              publicQuestion(
                normalizeQuestionForSnapshot(
                  questions[0]
                )
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
            : Number(body.selectedIndex);

        if (
          !attemptId ||
          !Number.isInteger(questionIndex)
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
            !Number.isInteger(selectedIndex) ||
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
          attempt.order_status !== "paid"
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

        if (attempt.finished_at) {
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
            attempt.current_question || 0
          );

        if (
          questionIndex !== currentQuestion
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

        const snapshot =
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

        if (!snapshot) {
          return json(
            {
              ok: false,
              error:
                "سؤال آزمون پیدا نشد",
            },
            404,
            cors
          );
        }

        const startedAt =
          snapshot.started_at ||
          attempt.question_started_at ||
          attempt.started_at;

        const startedMs =
          new Date(startedAt).getTime();

        const nowMs =
          Date.now();

        let elapsedSeconds =
          Math.max(
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
          elapsedSeconds =
            durationSeconds;
        }

        let isCorrect = null;

        if (selectedIndex !== null) {
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

        const nextQuestion =
          questionIndex + 1;

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
              publicSnapshotQuestion(next),
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

        if (attempt.finished_at) {
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

            if (
              row.payment_status !== "paid"
            ) {
              status = "unpaid";

            } else if (
              !row.attempt_id
            ) {
              status = "paid_not_started";

            } else if (
              !row.finished_at
            ) {
              status = "in_progress";

            } else {
              status = "finished";
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
            url.searchParams.get("attemptId") || ""
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

              options: compactOptions([
                row.option_a_snapshot,
                row.option_b_snapshot,
                row.option_c_snapshot,
                row.option_d_snapshot,
              ]).options,

              selectedIndex:
                row.selected_index,

              correctIndex:
                remapCorrectIndex(
                  [
                    row.option_a_snapshot,
                    row.option_b_snapshot,
                    row.option_c_snapshot,
                    row.option_d_snapshot,
                  ],
                  Number(
                    row.correct_index_snapshot
                  )
                ),

              result,

              isCorrect:
                result === "correct",

              durationSeconds:
                Number(
                  row.duration_seconds_snapshot || 30
                ),

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
      // =========================================================
      if (
        request.method === "DELETE" &&
        url.pathname === "/api/teacher/students"
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
              DELETE from attempts
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
// CORS امن
// =============================================================
const ALLOWED_ORIGINS = [
  "https://azmoonmath.ir",
  "https://www.azmoonmath.ir",
  "https://azmon.hosseinkhorasani1.workers.dev",
];

function getCorsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
  };

  if (ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}


// =============================================================
// Session Helpers
// =============================================================
async function hashToken(token) {
  const data = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = cookieHeader.split(";").map(c => c.trim());
  for (const cookie of cookies) {
    if (cookie.startsWith(name + "=")) {
      return decodeURIComponent(cookie.slice(name.length + 1));
    }
  }
  return null;
}

function buildSessionCookie(token, maxAgeSeconds) {
  return `teacher_session=\( {encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age= \){maxAgeSeconds}`;
}

function clearSessionCookie() {
  return `teacher_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

async function getValidTeacherSession(request, env) {
  const token = getCookie(request, "teacher_session");
  if (!token) return null;

  const tokenHash = await hashToken(token);
  const now = new Date().toISOString();

  const session = await env.DB
    .prepare(`
      SELECT id, expires_at
      FROM teacher_sessions
      WHERE token_hash = ?
        AND expires_at > ?
      LIMIT 1
    `)
    .bind(tokenHash, now)
    .first();

  return session || null;
}


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
    exam?.discount_start_at || null;

  const discountEndAt =
    exam?.discount_end_at || null;

  if (!discountEnabled) {
    return {
      basePrice,
      finalPrice: basePrice,
      discountEnabled: false,
      discountActive: false,
      discountPercent: 0,
      discountStartAt,
      discountEndAt,
    };
  }

  if (discountPercent <= 0) {
    return {
      basePrice,
      finalPrice: basePrice,
      discountEnabled: true,
      discountActive: false,
      discountPercent: 0,
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
      finalPrice: basePrice,
      discountEnabled: true,
      discountActive: false,
      discountPercent,
      discountStartAt,
      discountEndAt,
    };
  }

  const nowMs =
    new Date(now).getTime();

  const startMs =
    new Date(discountStartAt).getTime();

  const endMs =
    new Date(discountEndAt).getTime();

  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs)
  ) {
    return {
      basePrice,
      finalPrice: basePrice,
      discountEnabled: true,
      discountActive: false,
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
      finalPrice: basePrice,
      discountEnabled: true,
      discountActive: false,
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
    discountEnabled: true,
    discountActive: true,
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
      rule.selection_mode === "manual"
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
// نرمال‌سازی گزینه‌ها
// =============================================================
function compactOptions(
  values,
  correctIndex = null
) {

  const options = [];
  let newCorrectIndex = null;

  for (
    let i = 0;
    i < values.length;
    i++
  ) {

    const value =
      String(
        values[i] ?? ""
      ).trim();

    if (!value) {
      continue;
    }

    if (
      correctIndex !== null &&
      Number(correctIndex) === i
    ) {
      newCorrectIndex =
        options.length;
    }

    options.push(value);
  }

  return {
    options,
    correctIndex:
      newCorrectIndex,
  };
}


// =============================================================
// نرمال‌سازی سؤال برای Snapshot
// =============================================================
function normalizeQuestionForSnapshot(q) {

  if (!q) {
    return null;
  }

  const compact =
    compactOptions(
      [
        q.option_a,
        q.option_b,
        q.option_c,
        q.option_d,
      ],
      Number(q.correct_index)
    );

  const options =
    compact.options;

  return {
    id:
      q.id,

    question_text:
      q.question_text,

    option_a:
      options[0] || "",

    option_b:
      options[1] || "",

    option_c:
      options[2] || "",

    option_d:
      options[3] || "",

    correct_index:
      compact.correctIndex === null
        ? 0
        : compact.correctIndex,

    duration_seconds:
      Number(
        q.duration_seconds || 30
      ),

    folder_id:
      q.folder_id ?? null,

    active:
      q.active,
  };
}


// =============================================================
// سوال عمومی برای student
// =============================================================
function publicQuestion(q) {

  if (!q) {
    return null;
  }

  const normalized =
    normalizeQuestionForSnapshot(q);

  const options =
    [
      normalized.option_a,
      normalized.option_b,
      normalized.option_c,
      normalized.option_d,
    ].filter(Boolean);

  const duration =
    Number(
      normalized.duration_seconds || 30
    );

  return {
    id:
      normalized.id,

    question:
      normalized.question_text,

    options,

    durationSeconds:
      duration,

    question_text:
      normalized.question_text,

    option_a:
      normalized.option_a,

    option_b:
      normalized.option_b,

    option_c:
      normalized.option_c,

    option_d:
      normalized.option_d,

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

  const values = [
    q.option_a_snapshot,
    q.option_b_snapshot,
    q.option_c_snapshot,
    q.option_d_snapshot,
  ];

  const compact =
    compactOptions(values);

  const duration =
    Number(
      q.duration_seconds_snapshot || 30
    );

  return {

    id:
      q.question_id,

    question:
      q.question_text_snapshot,

    options:
      compact.options,

    durationSeconds:
      duration,

    question_text:
      q.question_text_snapshot,

    option_a:
      q.option_a_snapshot || "",

    option_b:
      q.option_b_snapshot || "",

    option_c:
      q.option_c_snapshot || "",

    option_d:
      q.option_d_snapshot || "",

    duration_seconds:
      duration,
  };
}


// =============================================================
// سؤال برای teacher
// =============================================================
function teacherQuestion(q) {

  if (!q) {
    return null;
  }

  const compact =
    compactOptions(
      [
        q.option_a,
        q.option_b,
        q.option_c,
        q.option_d,
      ],
      Number(q.correct_index)
    );

  return {
    id:
      q.id,

    examId:
      q.exam_id,

    question:
      q.question_text,

    questionText:
      q.question_text,

    options:
      compact.options,

    optionA:
      q.option_a || "",

    optionB:
      q.option_b || "",

    optionC:
      q.option_c || "",

    optionD:
      q.option_d || "",

    correctIndex:
      compact.correctIndex === null
      ? 0
      : compact.correctIndex,

    durationSeconds:
      Number(
        q.duration_seconds || 30
      ),

    folderId:
      q.folder_id ?? null,

    folderName:
      q.folder_name || null,

    active:
      Number(q.active || 0) === 1,
  };
}


// =============================================================
// ساخت گزینه‌ها از Body
// =============================================================
function normalizeOptionsFromBody(body) {

  const raw = [
    body.optionA ??
      body.option_a ??
      "",

    body.optionB ??
      body.option_b ??
      "",

    body.optionC ??
      body.option_c ??
      "",

    body.optionD ??
      body.option_d ??
      "",
  ].map(
    value =>
      String(value ?? "").trim()
  );

  let count =
    body.optionCount ??
    body.optionsCount ??
    body.option_count;

  if (
    count !== undefined &&
    count !== null &&
    count !== ""
  ) {
    count =
      Number(count);

    if (
      !Number.isInteger(count) ||
      count < 2 ||
      count > 4
    ) {
      return {
        ok: false,
        error:
          "تعداد گزینه باید 2، 3 یا 4 باشد",
      };
    }

    for (
      let i = count;
      i < 4;
      i++
    ) {
      raw[i] = "";
    }
  }

  let actualCount = 0;

  for (
    let i = 0;
    i < 4;
    i++
  ) {
    if (raw[i]) {
      actualCount++;
    } else {
      break;
    }
  }

  if (
    actualCount < 2 ||
    actualCount > 4
  ) {
    return {
      ok: false,
      error:
        "سؤال باید حداقل 2 و حداکثر 4 گزینه داشته باشد",
    };
  }

  for (
    let i = actualCount;
    i < 4;
    i++
  ) {
    if (raw[i]) {
      return {
        ok: false,
        error:
          "گزینه‌ها باید پشت سر هم از A شروع شوند",
      };
    }
  }

  return {
    ok: true,
    options: raw,
  };
}


// =============================================================
// اصلاح correct index
// =============================================================
function remapCorrectIndex(
  values,
  originalIndex
) {

  const compact =
    compactOptions(
      values,
      originalIndex
    );

  return compact.correctIndex === null
    ? 0
    : compact.correctIndex;
}


// =============================================================
// گرفتن سوال legacy
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
    questions.map(row => {

      let result = "empty";

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

      const compact =
        compactOptions([
          row.option_a_snapshot,
          row.option_b_snapshot,
          row.option_c_snapshot,
          row.option_d_snapshot,
        ]);

      return {

        number:
          Number(row.question_order) + 1,

        question:
          row.question_text_snapshot,

        options:
          compact.options,

        selectedIndex:
          row.selected_index,

        correctIndex:
          Number(
            row.correct_index_snapshot
          ),

        result,

        elapsedSeconds:
          row.elapsed_seconds,

        durationSeconds:
          Number(
            row.duration_seconds_snapshot || 30
          ),
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

      const normalized =
        normalizeQuestionForSnapshot(q);

      let result = "empty";

      if (
        selectedIndex === null ||
        selectedIndex === undefined
      ) {

        empty++;

      } else if (
        Number(selectedIndex) ===
        Number(normalized.correct_index)
      ) {

        correct++;
        result = "correct";

      } else {

        wrong++;
        result = "wrong";
      }

      return {

        number:
          index + 1,

        question:
          normalized.question_text,

        options: [
          normalized.option_a,
          normalized.option_b,
          normalized.option_c,
          normalized.option_d,
        ].filter(Boolean),

        selectedIndex,

        correctIndex:
          normalized.correct_index,

        result,

        durationSeconds:
          normalized.duration_seconds,
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
// Redirect بعد از پرداخت
// =============================================================
function paymentRedirect(
  env,
  success,
  orderId,
  message
) {

  const studentUrl =
    String(
      env.STUDENT_URL ||
      ""
    ).trim();

  if (!studentUrl) {

    return new Response(
      `
<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>نتیجه پرداخت</title>
</head>
<body style="font-family:tahoma;text-align:center;padding:50px">
<h2>${escapeHtml(message || "")}</h2>
<p>
${success
  ? "پرداخت با موفقیت تأیید شد."
  : "پرداخت تأیید نشد."}
</p>
${
  orderId
    ? `<p>شناسه سفارش: ${escapeHtml(orderId)}</p>`
    : ""
}
</body>
</html>
      `,
      {
        status: 200,
        headers: {
          "Content-Type":
            "text/html; charset=UTF-8",
        },
      }
    );
  }

  const target =
    new URL(
      studentUrl
    );

  target.searchParams.set(
    "payment",
    success
      ? "success"
      : "failed"
  );

  if (orderId) {
    target.searchParams.set(
      "orderId",
      orderId
    );
  }

  if (message) {
    target.searchParams.set(
      "message",
      message
    );
  }

  return Response.redirect(
    target.toString(),
    302
  );
}


// =============================================================
// جلوگیری از HTML Injection در صفحه callback
// =============================================================
function escapeHtml(value) {

  return String(
    value ?? ""
  )
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
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
