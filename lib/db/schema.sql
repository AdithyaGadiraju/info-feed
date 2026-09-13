-- info-feed schema (ADR 0001). Applied idempotently by lib/db/migrate.ts.
-- Every statement must be safe to run repeatedly: this file IS the migration.

-- Raw ingested items, one row per (source, external_id).
--   story_id semantics:
--     NULL  -> pending, waiting for enrichment
--     -1    -> excluded (engagement pre-filter rejected it, or the model dropped it as noise)
--     > 0   -> assigned to that story
-- story_id is deliberately NOT a foreign key because of the -1 sentinel (see ADR 0001 Deviations).
CREATE TABLE IF NOT EXISTS items (
  id           bigserial PRIMARY KEY,
  source       text        NOT NULL,
  external_id  text        NOT NULL,
  lane_hint    text        NOT NULL,
  url          text        NOT NULL,
  title        text        NOT NULL,
  body         text,
  author       text,
  engagement   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz NOT NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  story_id     bigint,
  CONSTRAINT items_source_external_id_key UNIQUE (source, external_id)
);

-- The pending-item queue is the hottest query in the system.
CREATE INDEX IF NOT EXISTS items_pending_idx   ON items (lane_hint, published_at DESC) WHERE story_id IS NULL;
CREATE INDEX IF NOT EXISTS items_story_id_idx  ON items (story_id);
CREATE INDEX IF NOT EXISTS items_published_idx ON items (published_at DESC);

-- Clustered, summarised, scored stories. The product surface.
CREATE TABLE IF NOT EXISTS stories (
  id             bigserial PRIMARY KEY,
  lane           text        NOT NULL,
  title          text        NOT NULL,
  summary_short  text        NOT NULL,
  summary_detail text,
  score          smallint    NOT NULL CHECK (score BETWEEN 1 AND 5),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  digested_at    timestamptz
);

-- Feed page query: lane filter + min score, cursor on (updated_at, id).
CREATE INDEX IF NOT EXISTS stories_feed_idx   ON stories (updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS stories_lane_idx   ON stories (lane, score DESC, updated_at DESC);
-- Digest selection: undigested or updated since the last digest.
CREATE INDEX IF NOT EXISTS stories_digest_idx ON stories (lane, score DESC, digested_at);

-- One row per Discord message actually delivered.
CREATE TABLE IF NOT EXISTS digests (
  id             bigserial PRIMARY KEY,
  sent_at        timestamptz NOT NULL DEFAULT now(),
  lane           text        NOT NULL,
  story_ids      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  discord_status integer     NOT NULL
);

CREATE INDEX IF NOT EXISTS digests_sent_at_idx ON digests (sent_at DESC);

-- Watchlist prices, used for 24h move detection (ADR 0002).
CREATE TABLE IF NOT EXISTS price_snapshots (
  id     bigserial PRIMARY KEY,
  symbol text        NOT NULL,
  price  double precision NOT NULL,
  ts     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS price_snapshots_symbol_ts_idx ON price_snapshots (symbol, ts DESC);

-- The only observability. Every job writes a row.
CREATE TABLE IF NOT EXISTS runs (
  id          bigserial PRIMARY KEY,
  job         text        NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          boolean,
  counts      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error       text
);

CREATE INDEX IF NOT EXISTS runs_job_started_idx ON runs (job, started_at DESC);
