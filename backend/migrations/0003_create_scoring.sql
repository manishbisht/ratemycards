-- Migration number: 0003 	 2026-08-29T00:00:00.000Z
-- The scoring module: the rubric cards are rated against.
--
-- scoring_criteria are the dimensions ("Lounge access", "Annual fee value").
-- card_scores is one card's score against one criterion, on a fixed 0-10 scale.
-- A card's rating is derived on read as the weight-weighted average of its
-- scores, so re-weighting a criterion re-rates every card with no backfill.

CREATE TABLE scoring_criteria (
  id         TEXT    PRIMARY KEY,            -- 'crit_1f0c...' , server-generated
  name        TEXT   NOT NULL,              -- 'Rewards / Returns'
  description TEXT,                          -- what the criterion measures
  weight     INTEGER NOT NULL DEFAULT 1,     -- relative importance in the rating
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (id GLOB 'crit_[0-9a-f]*' AND length(id) = 37),
  CHECK (length(trim(name)) BETWEEN 1 AND 80),
  CHECK (description IS NULL OR length(description) <= 300),
  CHECK (weight BETWEEN 0 AND 100),
  CHECK (is_active IN (0, 1))
);

-- Ids are random and carry no meaning, so the name identifies a criterion.
CREATE UNIQUE INDEX idx_scoring_criteria_name ON scoring_criteria(name);

CREATE INDEX idx_scoring_criteria_active ON scoring_criteria(is_active, name);

CREATE TABLE card_scores (
  card_id      TEXT    NOT NULL REFERENCES cards(id),
  criterion_id TEXT    NOT NULL REFERENCES scoring_criteria(id),
  score        INTEGER NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- One score per card per criterion, and the card_id-leading index the
  -- rating aggregate needs, in a single object.
  PRIMARY KEY (card_id, criterion_id),
  CHECK (score BETWEEN 0 AND 10)
);

CREATE INDEX idx_card_scores_criterion ON card_scores(criterion_id);
