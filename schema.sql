CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  price INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 1800,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL,
  question_text TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  correct_index INTEGER NOT NULL,
  FOREIGN KEY (exam_id) REFERENCES exams(id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  exam_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  authority TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  FOREIGN KEY (exam_id) REFERENCES exams(id)
);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  score REAL,
  correct_count INTEGER,
  wrong_count INTEGER,
  empty_count INTEGER,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

INSERT INTO exams (
  title,
  price,
  duration_seconds,
  active
)
SELECT
  'آزمون ریاضی',
  50000,
  1800,
  1
WHERE NOT EXISTS (
  SELECT 1
  FROM exams
);

INSERT INTO questions (
  exam_id,
  question_text,
  option_a,
  option_b,
  option_c,
  option_d,
  correct_index
)
SELECT
  1,
  'حاصل 12 × 8 کدام است؟',
  '86',
  '96',
  '106',
  '108',
  1
WHERE NOT EXISTS (
  SELECT 1
  FROM questions
  WHERE exam_id = 1
);

INSERT INTO questions (
  exam_id,
  question_text,
  option_a,
  option_b,
  option_c,
  option_d,
  correct_index
)
SELECT
  1,
  'حاصل 15 + 27 کدام است؟',
  '32',
  '40',
  '42',
  '45',
  2
WHERE NOT EXISTS (
  SELECT 1
  FROM questions
  WHERE exam_id = 1
);

INSERT INTO questions (
  exam_id,
  question_text,
  option_a,
  option_b,
  option_c,
  option_d,
  correct_index
)
SELECT
  1,
  'نصف 200 چند است؟',
  '50',
  '100',
  '150',
  '200',
  1
WHERE NOT EXISTS (
  SELECT 1
  FROM questions
  WHERE exam_id = 1
);

INSERT INTO questions (
  exam_id,
  question_text,
  option_a,
  option_b,
  option_c,
  option_d,
  correct_index
)
SELECT
  1,
  'اگر x + 7 = 15 باشد، x چند است؟',
  '6',
  '7',
  '8',
  '9',
  2
WHERE NOT EXISTS (
  SELECT 1
  FROM questions
  WHERE exam_id = 1
);

INSERT INTO questions (
  exam_id,
  question_text,
  option_a,
  option_b,
  option_c,
  option_d,
  correct_index
)
SELECT
  1,
  'مساحت مربع با ضلع 5 چند است؟',
  '10',
  '15',
  '20',
  '25',
  3
WHERE NOT EXISTS (
  SELECT 1
  FROM questions
  WHERE exam_id = 1
);
