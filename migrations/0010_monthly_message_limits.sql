CREATE TABLE monthly_message_usage (
  "userId" text NOT NULL REFERENCES users(id),
  period text NOT NULL,
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY ("userId", period)
);
