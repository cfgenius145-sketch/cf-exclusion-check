-- Free-trial counter: 3 unauthenticated /v1/check calls per (hashed IP, UTC
-- day). See src/trial.ts. No raw IPs here, same as the requests log.
CREATE TABLE IF NOT EXISTS trial_calls (
  ip_hash TEXT NOT NULL,
  day     TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);
