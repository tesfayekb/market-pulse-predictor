# Market Pulse Predictor — v1 Planning Document

**Status:** Design-locked. Implementation has not started.
**Last updated:** 2026-05-03
**Owner:** TBD (must be filled before Phase 0 begins)
**Repos covered:** `market-pulse-predictor` (admin dashboard, this repo) and the future Python ingestion/inference repo (separate, not yet created).

This document is the single source of truth for the v1 design. It supersedes any earlier architecture sketches. Code prompts (Cursor, etc.) must be measured against this document, not against earlier drafts.

---

## Table of contents

1. Mission and non-goals
2. Success criteria
3. The contracts — invariants every part of the system must honor
4. System architecture
5. Database design
6. Learning and autocorrection
7. Operational design
8. Failure modes
9. Cost model
10. Phased rollout
11. Risk register
12. Open questions
13. Glossary

---

## 1. Mission and non-goals

### Mission

Produce calibrated, multi-horizon, multi-target probabilistic forecasts for the S&P 500 complex (SPY, SPX, ES, sector SPDRs, NDX/QQQ/NQ, VIX) at minute-level cadence. Predictions are consumed by downstream trading websites under a best-effort SLA — predictions may be up to 5 minutes stale. The system improves over time via a closed feedback loop on its own predictions and autocorrects when its inputs drift, regimes change, or its own performance degrades.

### Non-goals for v1

- Low-latency execution (sub-second prediction-to-decision)
- Order routing or position management — this system predicts, it does not trade
- Single-name coverage beyond the seed list of indices and sector SPDRs
- Sub-minute prediction horizons
- Per-customer prediction streams (one global prediction stream, consumers downstream)
- Multi-region deployment
- Real-time training (training runs scheduled, not streaming)

### Why these non-goals matter

Every non-goal in the list above costs an order of magnitude more than its absence. Trying to deliver any of them in v1 fails the project. The design below is consciously sized for "calibrated probabilistic forecasts at 5-minute SLA on public data feeds" — that is achievable; HFT-adjacent capabilities are not, with this stack and budget.

---

## 2. Success criteria

A v1 release is successful when, after 30 days of shadow mode, the following are simultaneously true on out-of-sample predictions:

| Metric | Target | Threshold for "ready to leave shadow" |
|---|---|---|
| Rolling 30-day rank-IC, blender, per horizon | ≥ 0.05 | 5m: 0.03, 15m: 0.05, 60m: 0.05, EOD: 0.04, next: 0.02 |
| Rolling 30-day Brier score, directional probability | < 0.22 | < 0.245 (partial-success bar) |
| Calibration gap (max deviation from diagonal across deciles) | ≤ ±5% | ≤ ±8% |
| Open critical drift events | 0 | 0 |
| Distinct days of shadow predictions captured | ≥ 5 | ≥ 5 |
| Prediction emission uptime SLI during regular session | ≥ 99% | ≥ 95% |

### Defining "uptime SLI"

```
emission_uptime = (cycles where predictions.generated_at - expected_emission <= 90s)
                  / (expected cycles in regular trading session)
```

Computed in a daily rollup, exposed on the gate-check dashboard.

### What "accurate" means

Accurate means *calibrated and useful*, not *always right*. A system that says "60% probability up" and is right 60% of the time is more valuable than one that says "up" and is right 65% of the time, because downstream consumers can size positions to conviction. The success metrics above optimize for calibrated conviction, not for hit rate alone.

---

## 3. The contracts — invariants every part of the system must honor

These are non-negotiable. Both this repo and the Python ingestion repo must enforce them. The invariants are duplicated in `docs/SCHEMA_CONTRACT.md` (a one-page summary) for cross-repo reference.

### 3.1 Time conventions

- **All timestamps in the database are `timestamptz`, stored as UTC.**
- The dashboard renders in user-local time. Conversion happens at the rendering boundary, never in queries.
- The Python ingestion side converts to UTC at the source boundary. No intermediate code path operates in any other timezone.
- Migration sessions begin with `SET TIME ZONE 'UTC'`. Partition boundary literals (`'2026-05-01'`) interpret in session timezone — running in any other timezone shifts boundaries by hours and must be prevented.
- Half-day market closes (day before Thanksgiving, Christmas Eve, Black Friday) and full-session holidays are managed via `pandas_market_calendars` in the Python repo. The dashboard does not encode the calendar — it reads `target_at` from the predictions table, which the Python writer has already aligned to the correct session close.
- Daylight-saving transitions: timestamptz handles this correctly at the storage layer. Application code must not encode DST offsets manually.

### 3.2 Point-in-time discipline

This is the foundation of training data quality. A violation of point-in-time discipline produces look-ahead bias, which produces an in-sample model that fails out-of-sample. Strict enforcement, no exceptions.

- **Every event row carries two timestamps:** `event_at` (when the event happened in the world) and `available_at` (when our system knew about it). They are usually different — sometimes by milliseconds (live tick), sometimes by years (historical backfill of a 2021 news article).
- **Features always join on `available_at <= as_of`, never `event_at`.** A feature snapshot computed for 14:30 UTC may only see rows that were observable at 14:30 UTC, not rows that happened before 14:30 but were not yet known.
- **Feature snapshots carry `max_upstream_available_at`** — the maximum `available_at` across all source rows that fed the snapshot. The invariant `max_upstream_available_at <= as_of` must hold. Violations are caught by the `pit_violations` view.
- **Predictions reference `feature_snapshot_id`.** A prediction generated at T must reference a feature snapshot with `as_of <= T`. Violations are caught by the same view.

### 3.3 Data grade

Every persistence row that downstream models will train on carries a categorical provenance tag:

```
data_grade ∈ { 'production', 'shadow', 'backfill', 'synthetic' }
```

- **`production`**: live data, system was running, `available_at` reflects actual wall-clock observation
- **`shadow`**: live data captured during shadow mode (predictions emitted but not consumed externally)
- **`backfill`**: historical data loaded after the fact; `available_at` is the load time, which is later than the natural availability would have been
- **`synthetic`**: generated for testing or augmentation; not for training production models

Models trained on `backfill` are not the same as models trained on `production`. Mixing them silently is a leakage attractor. The schema requires `data_grade` on `predictions` and `feature_snapshots`. Training jobs filter on it.

### 3.4 Identity and partition keys

- Every table whose growth is unbounded over time is partitioned by range on a wall-clock column.
- Predictions partition by `generated_at` (emission time), not `ts` (target time). This decision is justified in §5.2.
- Feature snapshots partition by `as_of`.
- Bars partition by `ts`.
- **Primary keys on partitioned tables include the partition key.** This is a hard PostgreSQL requirement; FK constraints to a partitioned parent must reference the full PK column set.

### 3.5 RLS and access

- Every table in the `public` schema has Row Level Security enabled, even when the policy is permissive.
- Roles are: `admin` (full write), `operator` (read all internal data, limited write), `viewer` (read public-facing predictions only, Phase 2).
- Shadow predictions and all derived rollup tables are gated to `operator` or `admin`. The `viewer` role consumes a narrow view exposing only `(symbol, horizon, generated_at, target_at, direction_prob, expected_return, regime_label, feed_health)` from non-shadow predictions.
- Feature engineering IP (jsonb columns: `features`, `weights`, `hyperparams`, `feature_set`) is `operator`/`admin` only. Never readable by `viewer`.
- The `has_role()` SECURITY DEFINER function uses `SET search_path = ''` and has `EXECUTE` revoked from `public` and granted explicitly to `authenticated`.

### 3.6 Migration policy

- Forward-only. No `down()` migrations.
- Idempotent. Every DDL statement uses `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`. Policies are wrapped in `DROP POLICY IF EXISTS` then `CREATE POLICY`.
- Rollback is via deprecation runbook (`docs/ROLLBACK_RUNBOOK.md`), not via reverse migration. To remove a column: stop writers from writing to it, wait one deprecation window (typically 30 days), then drop.
- Migrations run on a direct connection (port 5432), not the pooler.

### 3.7 Hot retention

Supabase Pro tier per-project disk ceiling is 8 GB with Spend Cap on. The system fits this ceiling only by enforcing retention.

- Predictions, prediction_outcomes, prediction_scoring_log, feature_snapshots, model_decisions: **30 days hot in Supabase**
- Bars 1m: **90 days hot in Supabase** (small enough to keep longer for rolling-window dashboards)
- Bars 5m / 15m / 60m / 1d (when materialized later): same as 1m or longer (small)
- Reference data (symbols, index_membership, model_registry, system_config): unbounded, no retention
- Older data lives in Cloudflare R2 as monthly Parquet files, queryable via DuckDB for research

**Rule of last resort: 5-year historical backfill never enters Supabase.** The 5-year backfill of bars, news, filings, and any other deep history is written **directly to Cloudflare R2 as monthly Parquet files**, and is **never INSERTed into `public.bars` or any other Supabase table**. Training jobs read deep history from R2 via DuckDB, and write only their derived feature snapshots and predictions back to Supabase. This is non-negotiable: a one-time 5-year backfill of 18 symbols of 1m bars would consume ~1.7 GB on its own and break the retention ceiling on contact. The Python ingestion repo MUST honor this. Code review MUST reject any PR that writes historical data older than 90 days into `public.bars` or any other Supabase table.

### 3.8 Partition pre-allocation

- Pre-cut three months ahead at any time, no more, no less.
- Pre-cutting more than 3 months bakes long retention into the table layout and risks accidental disk consumption.
- Partition rotation is automated via pg_partman + pg_cron.
- Every partitioned table has a `DEFAULT` partition as a catch-all. Non-empty default is a critical alarm — partition rotation has fallen behind.

---

## 4. System architecture

### 4.1 Repo topology

Two repos, one shared schema contract:

- **`market-pulse-predictor`** (this repo): admin dashboard, schema migrations, observability config. TypeScript / TanStack Start / Cloudflare Workers. Read-mostly access to Supabase.
- **`market-pulse-engine`** (future, not yet created): Python ingestion + feature engineering + model training + inference + scoring. Write-heavy access to Supabase + R2. Runs on Railway with Modal for GPU training.

`docs/SCHEMA_CONTRACT.md` is duplicated in both repos. Drift between them is caught by a shared CI test that loads both copies and diffs them.

### 4.2 Data flow

```
EXTERNAL FEEDS                    INGESTION                 STORAGE
├─ Polygon (market data)          ┌──────────────┐         ┌──────────────────────┐
├─ Alpaca (fallback market)       │   Python     │         │   Supabase Pro       │
├─ NewsAPI (news)                 │   workers    │  ────▶  │   (hot, 30-90 days)  │
├─ EDGAR (filings)                │   on         │         │                      │
├─ FRED (macro)                   │   Railway    │         │   bars · predictions │
├─ Reddit (PRAW)                  └──────┬───────┘         │   feature_snapshots  │
└─ StockTwits                            │                 │   outcomes · regimes │
                                         │                 └──────────┬───────────┘
                                         │                            │
FEATURE ENGINEERING                      │                            │
┌──────────────────────┐                 │                            │
│ feature workers      │ ◀───────────────┘                            │
│ point-in-time joins  │                                              │
│ time decay           │                                              │
│ regime tagging       │                                              │
└──────┬───────────────┘                                              │
       │                                                              │
       ▼                                                              │
INFERENCE                                                             │
┌─────────────────────────────────────────────┐                       │
│ Specialist models (Layer 1)                 │                       │
│   XGBoost · LSTM · Linear                   │                       │
│ Meta-learner (Layer 2)                      │                       │
│   Regime-aware blender                      │                       │
│ LLM reasoner (Layer 3)                      │                       │
│   Claude API for narrative + sanity check   │                       │
└────────┬────────────────────────────────────┘                       │
         │                                                            │
         ▼                                                            │
PREDICTIONS ─────────────────────────────────────────────────────────▶│
                                                                      │
SCORING + LEARNING                                                    │
┌──────────────────────────┐                                          │
│ Hourly scoring job       │ ◀────────────────────────────────────────┤
│ Daily rollup job         │                                          │
│ Weekly retrain job       │                                          │
│ Drift detection          │                                          │
│ Auto-rebalance ensemble  │ ─────────────────────────────────────────┘
└──────────────────────────┘

ARCHIVAL
┌──────────────────────────┐                ┌──────────────────────────┐
│ Monthly DETACH partition │ ──────────────▶│ Cloudflare R2 (Parquet)  │
└──────────────────────────┘                │ (cold, unbounded)        │
                                            └──────────────────────────┘

DASHBOARD                                   MONITORING (external)
┌──────────────────────────┐                ┌──────────────────────────┐
│ market-pulse-predictor   │                │ Grafana Cloud Free       │
│ TanStack Start           │ ◀──────────────│   (Supabase Metrics API) │
│ Cloudflare Workers       │                │ Healthchecks.io          │
└──────────────────────────┘                │   (writer dead-man)      │
                                            │ Database Webhooks        │
                                            │   (critical drift)       │
                                            └──────────────────────────┘
```

### 4.3 Three-layer model architecture

**Layer 1 — Specialist models (multi-task heads):** XGBoost on tabular features, lightweight LSTM on microstructure sequences, elastic-net linear baseline. Each model predicts all targets (direction probability, expected return, return std, expected volatility, expected volume, regime-conditional adjustments) per horizon.

**Layer 2 — Meta-learner / regime-aware blender:** A separate, simple model that learns which Layer 1 model to weight more heavily given the current regime. Inputs: regime label + confidence, recent rolling-IC of each specialist, feed_health. Output: weights vector summing to 1 across specialists. Logged to `model_decisions` for retrospective analysis.

**Layer 3 — Claude reasoner:** Processes the day's narrative (news, filings, Fed-speak, scheduled events) into a structured "context vector" and a plain-English commentary. May adjust the blended prediction by a small bounded amount in known cases (e.g., 30 minutes before FOMC). Is *never* on the critical path — if Claude's output is malformed or the API fails, the blended prediction passes through untouched.

**Why this architecture:** stacking ensembles consistently outperform single models on financial prediction in published research and in practice. The regime-aware blender is what makes the system *adaptive* — when the market regime shifts, the blender's weights shift, and it does so without re-training the underlying specialists. The LLM layer adds context-aware nuance that pure ML models miss without giving up the deterministic core.

**What we deliberately do NOT include in v1:** TFT, N-BEATS, Transformer architectures. These earn their slot in Phase 2 only if XGBoost + LSTM + linear cannot reach the success criteria. CPU inference at minute cadence on Railway cannot afford TFT/N-BEATS for 18 symbols × 5 horizons.

### 4.4 LLM safety guardrails

Claude is in the production loop, with strict guardrails:

- Output schema-validated JSON only. Free-form text is rejected.
- Bounded influence: the reasoner can adjust direction_prob by at most ±0.05, expected_return by at most ±0.5σ. Beyond that, the reasoner output is logged but ignored.
- Fallback path: if the API fails, returns malformed JSON, exceeds latency budget, or returns out-of-bounds adjustments, the unadjusted blended prediction passes through.
- All Claude calls and adjustments are logged to `model_decisions.llm_commentary` and `model_decisions.llm_adjustment_payload`.
- Every Claude response is cached for the same `(input_hash, horizon)` for 60 seconds to control cost.

---

## 5. Database design

This section is the operative reference for Prompt 1 and beyond. Every table, every column, every constraint, every policy.

**Operational requirement for the migration file itself:** the Prompt 1 SQL migration MUST begin with `SET TIME ZONE 'UTC';` as the first executable statement, before any DDL. Partition boundary literals (`'2026-05-01'`, etc.) interpret in session timezone — running the migration in any other zone shifts boundaries by hours. This is the operational expression of the §3.1 contract; the prompt writer must not omit it.

### 5.1 Existing tables (already in `supabase_phase0_schema.sql`)

These tables are kept as-is, with only additive changes specified in §5.2:

- `user_roles` (admin gating)
- `symbols` (universe, survivorship-aware via `listed_at` / `delisted_at`)
- `bars` (OHLCV, partitioned by `ts`)
- `feeds`, `feed_health`
- `drift_events`
- `model_registry`
- `predictions` — see §5.2 for restructure (drop-recreate)
- `cost_ledger`
- `model_performance_daily`

### 5.2 Restructure: `predictions` table

**Reason for drop-recreate:** the partition key changes from `ts` to `generated_at`. This is irreversible without downtime. Doing it now while the table is empty is free; doing it later costs a maintenance window.

**Final schema:**

```sql
DROP TABLE IF EXISTS public.predictions CASCADE;

CREATE TABLE public.predictions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  generated_at timestamptz NOT NULL DEFAULT now(),

  -- targeting
  ts timestamptz NOT NULL,
  symbol text NOT NULL REFERENCES public.symbols(symbol),
  horizon text NOT NULL CHECK (horizon IN ('5m','15m','60m','eod','next')),
  model_id uuid NOT NULL REFERENCES public.model_registry(id),

  -- multi-task targets
  direction_prob numeric(6,5)
    CHECK (direction_prob >= 0 AND direction_prob <= 1),
  expected_return numeric(10,6),
  return_std numeric(10,6) CHECK (return_std IS NULL OR return_std >= 0),
  expected_volatility numeric(10,6)
    CHECK (expected_volatility IS NULL OR expected_volatility >= 0),
  expected_volume_pct numeric(8,4),
  regime_label text,
  regime_confidence numeric(5,4)
    CHECK (regime_confidence IS NULL OR
           (regime_confidence >= 0 AND regime_confidence <= 1)),
  event_prob_large_move numeric(5,4)
    CHECK (event_prob_large_move IS NULL OR
           (event_prob_large_move >= 0 AND event_prob_large_move <= 1)),

  -- legacy columns kept for backward compat during dashboard cutover, deprecated
  prob_up numeric(6,5)
    CHECK (prob_up IS NULL OR (prob_up >= 0 AND prob_up <= 1)),
  confidence numeric(6,5)
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),

  -- provenance
  feature_snapshot_id uuid,
  ensemble_weights_id uuid REFERENCES public.ensemble_weights(id),
  feed_health numeric(4,3) NOT NULL DEFAULT 1.0
    CHECK (feed_health >= 0 AND feed_health <= 1),
  ingest_lag_seconds integer,
  llm_commentary text,
  shadow boolean NOT NULL DEFAULT true,
  scored boolean NOT NULL DEFAULT false,
  data_grade text NOT NULL DEFAULT 'production'
    CHECK (data_grade IN ('production','shadow','backfill','synthetic')),
  features_hash text,

  PRIMARY KEY (id, generated_at)
) PARTITION BY RANGE (generated_at);

-- Pre-cut 3 months ahead
CREATE TABLE public.predictions_2026_05 PARTITION OF public.predictions
  FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');
CREATE TABLE public.predictions_2026_06 PARTITION OF public.predictions
  FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
CREATE TABLE public.predictions_2026_07 PARTITION OF public.predictions
  FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');
CREATE TABLE public.predictions_default PARTITION OF public.predictions DEFAULT;

-- Indexes
CREATE INDEX ON public.predictions (symbol, generated_at DESC);
CREATE INDEX ON public.predictions (symbol, horizon, generated_at DESC);
CREATE INDEX ON public.predictions (model_id, generated_at DESC);
CREATE INDEX ON public.predictions (ts);  -- for "predicted-for time" lookups
CREATE INDEX ON public.predictions (ts) WHERE scored = false;  -- scoring sweep

ALTER TABLE public.predictions ENABLE ROW LEVEL SECURITY;
```

**Why partition by `generated_at`:** monotonic write locality (90 rows per emission cycle land in one partition), clean retention queries, alignment with PITR / backup boundaries. `ts` as a partition key scattered writes across 2-3 partitions per cycle and made retention queries non-pruning.

**Migration ordering:** because `predictions.ensemble_weights_id` references `ensemble_weights(id)` and `predictions.feature_snapshot_id` is a soft reference to `feature_snapshots(id)`, the migration must create `ensemble_weights` (§5.7) and `feature_snapshots` (§5.5) **before** dropping and recreating `predictions`. The `feature_snapshot_id` column intentionally has no FK because `feature_snapshots` is partitioned and the FK would require a composite key — see §5.2.1 below.

**§5.2.1 Soft references explained.** `predictions.feature_snapshot_id` is a UUID column with no FK constraint. This is deliberate: `feature_snapshots` PK is the composite `(symbol, as_of, id)` (because PK on a partitioned table must include the partition key). Adding a composite FK on `predictions` would require carrying `(symbol, as_of)` redundantly. Instead, the soft reference is enforced in three ways: (1) the Python writer always populates a valid ID, (2) the `pit_violations` view (§5.11) joins on the soft reference and surfaces orphans, (3) the archival cron preserves snapshot rows for the lifetime of any prediction that references them. Document this explicitly in `docs/SCHEMA_CONTRACT.md`.

### 5.3 New table: `prediction_outcomes`

```sql
CREATE TABLE public.prediction_outcomes (
  prediction_id uuid NOT NULL,
  generated_at timestamptz NOT NULL,
  scored_at timestamptz NOT NULL DEFAULT now(),
  realized_return numeric(12,7),
  realized_volatility numeric(12,7) CHECK (realized_volatility IS NULL OR realized_volatility >= 0),
  realized_volume_pct numeric(8,4),
  realized_direction smallint CHECK (realized_direction IN (-1,0,1)),
  brier_score numeric(8,6) CHECK (brier_score IS NULL OR (brier_score >= 0 AND brier_score <= 1)),
  squared_error_return numeric(14,8) CHECK (squared_error_return IS NULL OR squared_error_return >= 0),
  squared_error_vol numeric(14,8) CHECK (squared_error_vol IS NULL OR squared_error_vol >= 0),
  paper_pnl numeric(14,4),
  paper_size numeric(12,4) CHECK (paper_size IS NULL OR paper_size >= 0),

  PRIMARY KEY (prediction_id, generated_at),
  FOREIGN KEY (prediction_id, generated_at)
    REFERENCES public.predictions(id, generated_at) ON DELETE CASCADE
);

CREATE INDEX ON public.prediction_outcomes (scored_at DESC);
ALTER TABLE public.prediction_outcomes ENABLE ROW LEVEL SECURITY;
```

UPSERT pattern: scoring job inserts on first scoring, updates on rescoring. Hot path is a PK lookup. Audit lives in the separate log table.

### 5.4 New table: `prediction_scoring_log`

Append-only audit trail of every scoring event, including rescorings.

```sql
CREATE TABLE public.prediction_scoring_log (
  log_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id uuid NOT NULL,
  generated_at timestamptz NOT NULL,
  scored_at timestamptz NOT NULL DEFAULT now(),
  prior_outcome jsonb,
  new_outcome jsonb NOT NULL,
  correction_reason text,
  scored_by text NOT NULL DEFAULT 'scoring_job'
    CHECK (scored_by IN ('scoring_job','manual','replay')),
  FOREIGN KEY (prediction_id, generated_at)
    REFERENCES public.predictions(id, generated_at) ON DELETE CASCADE
);

CREATE INDEX ON public.prediction_scoring_log (prediction_id, generated_at);
CREATE INDEX ON public.prediction_scoring_log (scored_at DESC);
ALTER TABLE public.prediction_scoring_log ENABLE ROW LEVEL SECURITY;
```

The scoring job is one transaction: log the prior state (or NULL for first scoring), then UPSERT the outcome.

### 5.5 New table: `feature_snapshots`

Point-in-time feature audit trail. Every prediction references one of these.

```sql
CREATE TABLE public.feature_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  as_of timestamptz NOT NULL,
  symbol text NOT NULL REFERENCES public.symbols(symbol),
  horizon text NOT NULL CHECK (horizon IN ('5m','15m','60m','eod','next')),
  features jsonb NOT NULL,
  feed_health numeric(4,3) NOT NULL CHECK (feed_health >= 0 AND feed_health <= 1),
  max_upstream_available_at timestamptz NOT NULL,
  data_grade text NOT NULL DEFAULT 'production'
    CHECK (data_grade IN ('production','shadow','backfill','synthetic')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pit_invariant CHECK (max_upstream_available_at <= as_of),
  PRIMARY KEY (symbol, as_of, id)
) PARTITION BY RANGE (as_of);

CREATE TABLE public.feature_snapshots_2026_05 PARTITION OF public.feature_snapshots
  FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');
CREATE TABLE public.feature_snapshots_2026_06 PARTITION OF public.feature_snapshots
  FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
CREATE TABLE public.feature_snapshots_2026_07 PARTITION OF public.feature_snapshots
  FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');
CREATE TABLE public.feature_snapshots_default PARTITION OF public.feature_snapshots DEFAULT;

CREATE INDEX ON public.feature_snapshots (symbol, horizon, as_of DESC);
CREATE INDEX ON public.feature_snapshots (created_at DESC);

ALTER TABLE public.feature_snapshots ENABLE ROW LEVEL SECURITY;
```

The `pit_invariant` CHECK at the row level is the first line of defense against PIT violations. The cross-table `pit_violations` view (§5.11) is the second.

### 5.6 New table: `features_latest`

Hot row per `(symbol, horizon)` for low-latency inference reads.

```sql
CREATE TABLE public.features_latest (
  symbol text NOT NULL REFERENCES public.symbols(symbol),
  horizon text NOT NULL CHECK (horizon IN ('5m','15m','60m','eod','next')),
  as_of timestamptz NOT NULL,
  features jsonb NOT NULL,
  feed_health numeric(4,3) NOT NULL CHECK (feed_health >= 0 AND feed_health <= 1),
  max_upstream_available_at timestamptz NOT NULL,
  data_grade text NOT NULL DEFAULT 'production'
    CHECK (data_grade IN ('production','shadow','backfill','synthetic')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pit_invariant CHECK (max_upstream_available_at <= as_of),
  PRIMARY KEY (symbol, horizon)
);

ALTER TABLE public.features_latest ENABLE ROW LEVEL SECURITY;
```

Writers UPSERT on `(symbol, horizon)`. Inference jobs read by the same key. The `features` jsonb is the canonical hot input — it must be small enough to read cheaply from the dashboard for "what features fed this prediction" panels.

### 5.7 New table: `ensemble_weights`

```sql
CREATE TABLE public.ensemble_weights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  computed_at timestamptz NOT NULL DEFAULT now(),
  regime text NOT NULL,
  horizon text NOT NULL CHECK (horizon IN ('5m','15m','60m','eod','next')),
  weights jsonb NOT NULL CHECK (jsonb_typeof(weights) = 'object'),
  reason text
);

CREATE INDEX ON public.ensemble_weights (regime, horizon, computed_at DESC);
CREATE INDEX ON public.ensemble_weights (computed_at DESC);

ALTER TABLE public.ensemble_weights ENABLE ROW LEVEL SECURITY;
```

The table is not partitioned, so a singleton `id` PK is sufficient. This makes `predictions.ensemble_weights_id` a clean foreign-key target (see §5.2 FK).

### 5.8 New table: `regimes`

Global regime classification.

```sql
CREATE TABLE public.regimes (
  ts timestamptz PRIMARY KEY,
  label text NOT NULL,
  confidence numeric(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  features jsonb,
  smoothed_label text,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON public.regimes (computed_at DESC);

ALTER TABLE public.regimes ENABLE ROW LEVEL SECURITY;
```

`smoothed_label` carries the post-smoothing regime tag — raw regime classification flips too often for blender weight stability. The regime classifier is documented separately as a sub-spec in Phase 1.

### 5.9 New table: `model_performance_per_symbol_horizon`

```sql
CREATE TABLE public.model_performance_per_symbol_horizon (
  model_id uuid NOT NULL REFERENCES public.model_registry(id),
  day date NOT NULL,
  symbol text NOT NULL REFERENCES public.symbols(symbol),
  horizon text NOT NULL CHECK (horizon IN ('5m','15m','60m','eod','next')),
  n int NOT NULL CHECK (n >= 0),
  ic numeric(8,5),
  brier numeric(8,5) CHECK (brier IS NULL OR (brier >= 0 AND brier <= 1)),
  log_loss numeric(8,5) CHECK (log_loss IS NULL OR log_loss >= 0),
  hit_rate numeric(6,4) CHECK (hit_rate IS NULL OR (hit_rate >= 0 AND hit_rate <= 1)),
  calibration_mae numeric(6,4) CHECK (calibration_mae IS NULL OR calibration_mae >= 0),
  sharpe numeric(8,4),
  PRIMARY KEY (model_id, day, symbol, horizon)
);

CREATE INDEX ON public.model_performance_per_symbol_horizon (day DESC);
CREATE INDEX ON public.model_performance_per_symbol_horizon (symbol, day DESC);

ALTER TABLE public.model_performance_per_symbol_horizon ENABLE ROW LEVEL SECURITY;
```

The existing `model_performance_daily` is kept (different access pattern: family-level rollup for the Performance dashboard's main chart). Both tables aggregate over `WHERE shadow = false` by default; shadow rollups go to parallel `*_shadow` tables (added in Prompt 4 alongside the rollup writer).

### 5.10 New table: `index_membership`

Survivorship-bias guard.

```sql
CREATE TABLE public.index_membership (
  index_symbol text NOT NULL,
  member_symbol text NOT NULL,
  added_at date NOT NULL,
  removed_at date,
  CONSTRAINT membership_dates_valid
    CHECK (removed_at IS NULL OR removed_at > added_at),
  PRIMARY KEY (index_symbol, member_symbol, added_at)
);

CREATE INDEX ON public.index_membership (index_symbol, member_symbol)
  WHERE removed_at IS NULL;

ALTER TABLE public.index_membership ENABLE ROW LEVEL SECURITY;
```

Phase 0 backfill loads 5y of S&P 500 / Nasdaq-100 historical membership from a documented source (CRSP via WRDS, or the index publisher's archive).

### 5.11 New view: `pit_violations`

Cross-table point-in-time invariant violations. The first line is the trivial intra-row check; the rest are the actual bug-catchers.

```sql
CREATE OR REPLACE VIEW public.pit_violations AS
-- 1. Bars where available_at < ts (impossible to know an event before it happens)
SELECT
  'bars'::text AS table_name,
  symbol::text AS subject_id,
  ts AS event_time,
  available_at,
  'available_before_event'::text AS kind
FROM public.bars
WHERE available_at < ts

UNION ALL

-- 2. Predictions that referenced a feature snapshot whose as_of is in the future
--    relative to the prediction's generated_at
SELECT
  'predictions'::text,
  p.symbol,
  p.generated_at,
  fs.as_of,
  'snapshot_after_generation'::text
FROM public.predictions p
JOIN public.feature_snapshots fs ON fs.id = p.feature_snapshot_id
WHERE fs.as_of > p.generated_at

UNION ALL

-- 3. Feature snapshots where any source row's available_at > snapshot's as_of
--    (caught by the row-level pit_invariant CHECK at insert, but kept here
--    for cross-validation against future schema changes)
SELECT
  'feature_snapshots'::text,
  symbol,
  as_of,
  max_upstream_available_at,
  'upstream_after_snapshot'::text
FROM public.feature_snapshots
WHERE max_upstream_available_at > as_of;
```

Authenticated read. Operator-only in v1 (the violations themselves are sensitive — they reveal the system's data plumbing).

### 5.12 New table: `system_config`

Single source of truth for runtime flags.

```sql
CREATE TABLE public.system_config (
  key text PRIMARY KEY
    CHECK (key IN (
      'system_trusted',
      'emission_enabled',
      'read_only_reason',
      'shadow_mode_global'
    )),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);

ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;

-- Audit history for system_config UPDATE
CREATE TABLE public.system_config_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  prior_value jsonb,
  new_value jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid REFERENCES auth.users(id)
);

CREATE OR REPLACE FUNCTION public.system_config_audit() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.system_config_history (key, prior_value, new_value, changed_by)
  VALUES (NEW.key, OLD.value, NEW.value, NEW.updated_by);
  RETURN NEW;
END;
$$;

CREATE TRIGGER system_config_audit_trigger
  AFTER UPDATE ON public.system_config
  FOR EACH ROW EXECUTE FUNCTION public.system_config_audit();
```

Initial seed:
```sql
INSERT INTO public.system_config (key, value) VALUES
  ('system_trusted', 'false'::jsonb),
  ('emission_enabled', 'true'::jsonb),
  ('shadow_mode_global', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;
```

### 5.13 RLS policies — consolidated

Pattern for every derived or sensitive table (predictions, prediction_outcomes, prediction_scoring_log, feature_snapshots, features_latest, ensemble_weights, regimes, model_performance_*, system_config, system_config_history):

```sql
DROP POLICY IF EXISTS "operators read X" ON public.X;
CREATE POLICY "operators read X" ON public.X
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'operator')
         OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "admins write X" ON public.X;
CREATE POLICY "admins write X" ON public.X
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
```

Reference tables (`symbols`, `index_membership`, `model_registry`) keep their existing `auth read true` policy. Their data is not sensitive.

`bars` and `feeds`, `feed_health`, `drift_events`, `cost_ledger` keep their existing policies — operationally useful to all authenticated, no IP exposure.

### 5.14 `has_role()` hardening

Replace the existing function with:

```sql
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  );
$$;

REVOKE EXECUTE ON FUNCTION public.has_role(uuid, app_role) FROM public;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated;
```

### 5.15 Partition rotation via pg_partman

```sql
CREATE SCHEMA IF NOT EXISTS partman;
CREATE EXTENSION IF NOT EXISTS pg_partman WITH SCHEMA partman;
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT partman.create_parent(
  p_parent_table   := 'public.bars',
  p_control        := 'ts',
  p_type           := 'range',
  p_interval       := '1 month',
  p_premake        := 3,
  p_default_table  := true
);
SELECT partman.create_parent(
  p_parent_table   := 'public.predictions',
  p_control        := 'generated_at',
  p_type           := 'range',
  p_interval       := '1 month',
  p_premake        := 3,
  p_default_table  := true
);
SELECT partman.create_parent(
  p_parent_table   := 'public.feature_snapshots',
  p_control        := 'as_of',
  p_type           := 'range',
  p_interval       := '1 month',
  p_premake        := 3,
  p_default_table  := true
);

SELECT cron.schedule(
  'partman-maintenance',
  '15 2 * * *',  -- 02:15 UTC daily, mid-Asian session
  $$ CALL partman.run_maintenance_proc(); $$
);

-- Default-non-empty canary: alerts when partition rotation has fallen behind.
-- Uses real count(*) (not pg_class.reltuples, which is stale until VACUUM/ANALYZE).
-- Guarded against duplicate alerts: only inserts if no unresolved canary event exists for that partition.
CREATE OR REPLACE FUNCTION public.canary_check_default_partitions() RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_part text;
  v_count bigint;
BEGIN
  FOR v_part IN
    SELECT unnest(ARRAY[
      'predictions_default',
      'feature_snapshots_default',
      'bars_default'
    ])
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', v_part) INTO v_count;
    IF v_count > 0 THEN
      INSERT INTO public.drift_events (kind, severity, details, action)
      SELECT
        'partition_default_nonempty',
        'critical',
        format('default partition %s has %s rows', v_part, v_count),
        'check partman maintenance, premake count'
      WHERE NOT EXISTS (
        SELECT 1 FROM public.drift_events
        WHERE kind = 'partition_default_nonempty'
          AND details LIKE '%' || v_part || '%'
          AND resolved_at IS NULL
      );
    END IF;
  END LOOP;
END;
$$;

SELECT cron.schedule(
  'default-partition-canary',
  '0 * * * *',
  $$ SELECT public.canary_check_default_partitions(); $$
);

-- pg_cron history pruning
SELECT cron.schedule(
  'cron-history-prune',
  '30 2 * * *',
  $$ DELETE FROM cron.job_run_details WHERE start_time < now() - interval '14 days'; $$
);
```

### 5.16 Postgres custom config

```sql
ALTER DATABASE postgres SET idle_in_transaction_session_timeout = '15min';
```

Or via Supabase CLI:
```bash
npx supabase --experimental --project-ref <ref> postgres-config update \
  --config idle_in_transaction_session_timeout='15min'
```

### 5.17 Tables deferred to later prompts

| Table | Prompt | Reason for deferral |
|---|---|---|
| `model_decisions` | Prompt 4 | No blender exists yet |
| `feature_importance_history` | Prompt 4 | No models exist yet; aggregate-only by design |
| `system_alerts` | Prompt 4 | Wire alongside scoring/feedback infra |
| `bars_quarantine` | Prompt 2 | Belongs with ingestion, not dashboard repo |
| Materialized views (`bars_5m`, `bars_15m`, etc.) | Later | Dashboard reads predictions, not bars rollups |
| `*_shadow` rollup tables | Prompt 4 | Wire with rollup writer |
| News, filings, earnings, options_flow, social_posts | Python repo | Belongs with ingestion |

Their schemas are sketched in this doc but not in Prompt 1 SQL.

---

## 6. Learning and autocorrection

This section addresses your explicit requirement: *"very good learning and autocorrects itself."* The system has four learning loops operating at different timescales.

### 6.1 Loop 1 — Inference-time blender adjustment (seconds)

After every prediction is scored, the blender's internal state updates the rolling-IC of each specialist. The next prediction cycle uses the new IC to weight specialists. No retraining; just rebalancing.

**Table involved:** `model_decisions` (Prompt 4) logs each routing choice.
**Trigger:** every scoring event.
**Adjustment magnitude:** small per cycle, smoothed.

### 6.2 Loop 2 — Daily fast retrain (24 hours)

The fast specialists (XGBoost, linear) refit on the last N days of data plus a held-out validation slice. Hyperparameters are not searched here — only weights update. Walk-forward discipline: train on `[T-N, T-1]`, validate on `[T-1, T]`, never peek.

**Trigger:** scheduled, 03:00 UTC.
**Output:** new model versions in `model_registry`, status='shadow' until promoted.

### 6.3 Loop 3 — Weekly full retrain (7 days)

All specialists refit with hyperparameter search. The blender re-fits its regime-aware weighting model. Anchored vs rolling walk-forward both run; their divergence is a regime-shift signal.

**Trigger:** scheduled, Sunday 04:00 UTC.
**Output:** candidate models in `model_registry`. Promotion to production requires `model_performance_per_symbol_horizon` to show non-degradation vs incumbent.

### 6.4 Loop 4 — Drift-triggered emergency response (sub-day)

Runs continuously; activates only on signal.

- **Input drift:** PSI/KS on each feature distribution vs the training reference. PSI > 0.2 → `drift_events` warn, > 0.3 → critical.
- **Performance drift:** rolling 7-day IC < 0 → critical. Rolling Brier > 0.245 → warn.
- **Regime drift:** HMM regime label changes. Smoothed (raw flips ignored). On confirmed change, blender weights snap to last-known-good weights for that regime if available.

On critical drift:
1. Last-known-good ensemble weights restored.
2. Emergency retrain queued (out-of-band from weekly).
3. `system_alerts` row inserted, webhook fires.
4. Predictions continue but `feed_health` degraded by drift severity.

**Table involved:** `drift_events` (existing), `model_decisions` (new), `ensemble_weights` (new with reason='emergency_revert').

### 6.5 Auto-correction is bounded

The system does not perform unbounded self-modification. Specifically:

- Auto-feature discovery (genetic programming, autoML) is *not* enabled. Considered for Phase 2 only after stable baseline performance.
- Hyperparameter search runs weekly only, not continuously.
- Retired model artifacts are kept in R2 — every promotion is reversible.
- A human (admin role) approves every `shadow → candidate` and `candidate → production` transition via the dashboard. No automatic promotion to production.

This is by design. Unbounded self-modification on financial data with a feedback loop is a near-guaranteed overfitting machine. The bounded version above is what real shops do.

### 6.6 What the schema enforces vs what the Python side enforces

| Concern | Schema enforces | Python enforces |
|---|---|---|
| PIT discipline | `pit_invariant` row CHECK + `pit_violations` view | Feature engineering uses `available_at <= as_of` |
| Data grade | NOT NULL CHECK | Writer sets correctly per origin |
| Walk-forward | — | Training jobs only |
| Drift detection | `drift_events` table | PSI/KS/IC computation |
| Regime smoothing | — | HMM + smoothing |
| Bounded LLM influence | — | Reasoner clamps adjustments |
| Promotion gating | model_registry.status enum | Admin-approved via dashboard |

The schema cannot enforce what the Python code does — it can only catch what the Python code stored. The schema is the safety net, not the primary enforcement layer.

---

## 7. Operational design

### 7.1 Hosting and compute

- **Supabase Pro (own org):** primary database, auth, RLS, realtime. New org for MPS, separate from the user's other 4 projects.
- **Cloudflare Workers (current):** dashboard hosting via wrangler. No change.
- **Railway:** Python ingestion + inference workers. ~$40/mo.
- **Modal:** GPU training during weekly retrain only. ~$30/mo.
- **Cloudflare R2:** cold Parquet storage. ~$5/mo.

### 7.2 Connection patterns

- Dashboard: PostgREST via Supabase client, transaction-mode pooler (port 6543). Short SELECTs, fine.
- Python ingestion writers: session-mode pooler (port 5432) or Dedicated Pooler. Heavy INSERT...ON CONFLICT with prepared statements requires session mode.
- Migrations: direct connection (port 5432), no pooler. Avoids statement-timeout issues during long DDL.

### 7.3 External monitoring

Total cost: $0/mo. Layered for redundancy.

**Layer 1 — Supabase Metrics API → Grafana Cloud Free**
- Endpoint: `https://<project-ref>.supabase.co/customer/v1/privileged/metrics`
- Auth: HTTP Basic with `service_role` username + `sb_secret_*` token
- Scrape every 60s
- Alert rules:
  - `disk_used / disk_total > 0.85` → warn
  - `disk_used / disk_total > 0.93` → critical (read-only imminent)
  - `up{job="supabase"} == 0` for 2m → critical (project unreachable)
  - WAL growth rate sustained → warn

**Layer 2 — Healthchecks.io dead-man's-switch**
- Free tier, 20 checks
- Python writer pings unique URL every emission cycle
- No ping for >5 min during market hours → email/Slack alert
- Catches the symptom (writes stopped) regardless of cause: read-only mode, network, Polygon outage, OOM

**Layer 3 — Database Webhooks for non-read-only events**
- Critical drift events (`drift_events.severity = 'critical'`) trigger `pg_net.http_post`
- Webhook → Cloudflare Worker → Resend free tier email
- Does NOT fire under read-only (no INSERT happens) — Layer 1 + 2 catch that case
- Wired in Prompt 4, not Prompt 1

**Layer 4 — Supabase built-in 7-day log retention**
- Primary forensics surface
- Sufficient for "what happened in the last week" queries
- No paid Log Drain in v1 ($60/mo, revisit at Phase 2)

### 7.4 SLI definition

```
emission_uptime_24h = (
  SELECT count(*) FILTER (WHERE generated_at - target_emission_time <= interval '90 seconds')::float
         / NULLIF(count(*), 0)
  FROM predictions
  WHERE generated_at > now() - interval '24 hours'
)
```

Where `target_emission_time` is the scheduled emission slot (every 60s during regular session). Computed daily, exposed on dashboard.

### 7.5 Backup and PITR

- Supabase Pro includes 7-day PITR.
- R2 archival captures monthly partitions before DETACH; lost data window is ≤ 31 days.
- Schema migrations are forward-only with deprecation runbook (no down() migrations). Recovery from a bad migration is via PITR + manual replay.

---

## 8. Failure modes

| Failure | Detection | First action | Fallback |
|---|---|---|---|
| Polygon WS disconnect | Heartbeat timeout > 30s | Switch to Alpaca | Mark `feed_health = 0.6` |
| Both market feeds dead | Both heartbeats stale | Skip inference cycle | Mark `feed_health = 0.0`; emit health-degraded event |
| News feed dead | Poll failures > 5 in 10 min | Continue without news features | `feed_health -= 0.2` |
| Claude API failure / malformed JSON | Exception or schema validation fail | Use blended prediction without LLM adjustment | Log to `model_decisions.llm_failed = true` |
| Claude latency > 3s | Timer | Skip LLM call this cycle | Same as above |
| Drift detected (input) | PSI > 0.2 | Insert warn drift event | Flag in dashboard |
| Drift detected (perf, 7d IC < 0) | Rolling computation | Insert critical drift event | Trigger emergency retrain; revert to last-known-good ensemble weights |
| DB connection lost | Exception | Retry with exponential backoff | Spool to in-memory queue (with TTL) for up to 5 min; alert if longer |
| DB read-only (disk cap) | External Grafana alert | Halt ingestion writes | Spool to R2 for replay; emit critical alert |
| Inference latency > 30s | Timer | Skip this cycle, alert | Investigate; if 3 consecutive, fail-open with last known prediction + `feed_health = 0.5` |
| Polygon emits zero-volume / negative-price garbage | Sanity check in ingestion | Quarantine to `bars_quarantine` (Prompt 2+) | Don't drop; surface in data-quality pane |
| Half-day market close | `pandas_market_calendars` | Score against actual close, not 16:00 | Documented per `docs/TIME_CONVENTIONS.md` |
| August 1 partition missing | DEFAULT partition catches | Insert critical drift event | partman maintenance runs daily, should auto-create |
| pg_cron job failure | `cron.job_run_details` query | Manual investigation | Set up Grafana alert on failed-job count |
| Corporate action (split / dividend) on sector SPDR | Manual flag in symbols table (Prompt 2) | Backfill `adj_close` | Add `adjustments` table |
| 5 consecutive emission cycles skipped | Counter in monitoring | Insert critical alert | Fail-open: emit last good prediction with `feed_health = 0.3` (Prompt 4) |

---

## 9. Cost model

### 9.1 Monthly recurring (USD)

| Item | Cost | Notes |
|---|---|---|
| Supabase Pro (new org, MPS only) | $25 | Plus compute add-ons ~$5-10 |
| Polygon Stocks Advanced | $199 | Real-time + L2 + history for SPX complex |
| NewsAPI | (existing) | Already in user's stack |
| Railway | $40 | Workers + scheduled jobs |
| Modal | $30 | ~10 GPU-hr/wk during weekly retrain |
| Cloudflare R2 | $5 | ~50GB Parquet archive |
| Anthropic API | $100-150 | Claude reasoner at 60s emission cadence with prompt caching. Higher than original $30-50 estimate |
| Grafana Cloud | $0 | Free tier sufficient |
| Healthchecks.io | $0 | Free tier sufficient |
| Resend / Cloudflare Worker | $0 | Free tiers |
| Domain + SSL | $2 | |
| **Total** | **$401-461** | Within $500 ceiling |

### 9.2 Cost adjustments vs earlier estimates

- **Anthropic upward revision:** original $30-50 was unrealistic at 60s cadence × 6.5h × 252 days. With prompt caching, $100-150 is realistic. Reduce cadence on the LLM reasoner (e.g., 5-min cadence) if needed for budget.
- **Benzinga removed for v1:** $177/mo saved by using existing NewsAPI. Add Benzinga in Phase 2 only if news quality becomes the gating factor.
- **OPRA options data NOT included:** Polygon Stocks Advanced does not include OPRA. Adding OPRA is a separate $199 SKU. Defer to Phase 2; v1 uses options sentiment proxies (put/call ratio from CBOE free data, dealer gamma from SqueezeMetrics free tier).
- **Separate Supabase org:** $25/mo extra vs sharing with the user's other 4 projects. Worth it for blast-radius isolation.

### 9.3 What blows the budget

In rough order of risk:

1. **Anthropic API at high cadence** — mitigation: reduce LLM cadence to 5-min, aggressive prompt caching.
2. **Modal GPU minutes** — if weekly retrain expands to all Layer 1 specialists with HPO, GPU spend jumps.
3. **Polygon overage** — if scope expands beyond SPX complex to single names, options, etc.
4. **R2 egress** — if research queries pull large historical windows frequently.

---

## 10. Phased rollout

Each phase has explicit entry and exit criteria. Don't advance until exit criteria met.

### Phase 0 — Foundation (Weeks 1-3)

**Goal:** end-to-end pipeline running on 1 symbol, 1 horizon, 1 model. Prove the architecture.

**Scope:**
- New Supabase org spun up, Prompt 1 migration applied
- Dashboard wired to live data (Prompts 2-3)
- Python ingestion repo created, Polygon WS connected
- One feature engineering pipeline (microstructure + technicals for SPY)
- One specialist model (XGBoost) for SPY 15m direction
- Inference job emitting every 60s
- Scoring job running after horizon expiry
- Gate-check dashboard pane (Prompt 4)
- External monitoring (Grafana Cloud + Healthchecks) live

**Exit criteria:**
- ≥ 5 days of live shadow predictions in DB
- API returns predictions with sub-1s latency
- Out-of-sample rank-IC > 0 on SPY 15m direction
- Gate-check pane shows all 5 conditions populated (not necessarily green)
- No P0 bugs

### Phase 1 — Multi-symbol, multi-horizon (Weeks 4-8)

**Goal:** scale from 1 symbol/horizon/model to the full v1 footprint.

**Scope:**
- All 18 symbols in seed list
- All 5 horizons
- All 3 specialist models (XGBoost, LSTM, linear)
- Regime-aware blender (Prompt 4)
- LLM reasoner with bounded influence (Prompt 4)
- `model_decisions`, `feature_importance_history`, `system_alerts` tables (Prompt 4)
- Drift detection live
- Database Webhooks for critical alerts
- Monthly archival cron to R2 (Prompt 5)

**Exit criteria:**
- Rolling 30-day rank-IC ≥ 0.05 on blender, all horizons (per success criteria)
- Brier < 0.22, calibration ±5%
- 5 days of green gate-check
- Admin promotes `system_trusted = true` via dashboard
- API exposed read-only to first downstream consumer

### Phase 2 — Hardening and expansion (Months 3-6)

**Goal:** production-grade reliability and selective scope expansion.

**Scope:**
- News table (`news`, with pgvector HNSW embeddings) in Python repo
- Filings, earnings, economic_releases tables
- Bad-bar quarantine pattern
- `viewer` role + narrow public view for Phase-2 API consumers
- Auto-feature discovery experiments (gated, opt-in)
- Top 50 single-name expansion (if blender hits target IC on indices first)
- Options flow integration (OPRA via Polygon, $199/mo SKU)

**Exit criteria:**
- 90 days uninterrupted production operation
- Multiple downstream consumers integrated
- No critical alerts for 30 consecutive days
- Cost still under $500/mo (or budget formally raised)

### What never happens automatically

- Promotion `shadow → candidate → production`: admin approves every step
- Spend Cap removal: admin only
- New tables added to public schema: through schema migration only
- LLM influence bound widening: explicit code change, not config

---

## 11. Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Hits 8 GB Supabase ceiling, project goes read-only | Medium | High | 30-day retention, archival cron live before Month 3, Grafana alerts at 85% / 93% |
| R2 | LLM reasoner adds bias instead of value | Medium | Medium | Bounded ±0.05 / ±0.5σ adjustment, fallback path always available, A/B logged in `model_decisions` |
| R3 | Look-ahead bias from PIT violation in feature engineering | Medium | Critical | Row-level CHECK + `pit_violations` view + walk-forward training discipline |
| R4 | Survivorship bias from training only on current index members | Medium | Medium | `index_membership` table backfilled with historical membership |
| R5 | Regime classifier whipsaws ensemble weights | High | Medium | Smoothed regime labels, last-known-good revert on drift |
| R6 | Polygon outage during market hours | Medium | Medium | Alpaca fallback, `feed_health` degradation, prediction continuation |
| R7 | Anthropic API cost overruns budget | Medium | Low | Reduce LLM cadence to 5-min, prompt caching, hard token budget |
| R8 | August 1 (or any month boundary) partition missing | Low | High | pg_partman daily maintenance, DEFAULT partition catch-all, hourly empty-default monitor |
| R9 | Spend Cap silently hit, dashboard looks healthy | Medium | Critical | External Grafana alerts on 93% disk, Healthchecks.io dead-man's-switch |
| R10 | Schema drift between this repo and Python repo | High | High | Shared `docs/SCHEMA_CONTRACT.md`, CI test that diffs the two copies |
| R11 | Feature engineering IP leaked via `auth read true` policies | Medium | Medium | All derived tables gated to operator/admin in Prompt 1 |
| R12 | Forward-only migration policy makes rollback painful | Low | Medium | `docs/ROLLBACK_RUNBOOK.md` with explicit deprecation windows |
| R13 | LLM hallucinated structured output passes validation | Low | Medium | Schema validation + bounded influence + cross-check against blended prediction |
| R14 | Owner: TBD field unfilled, Phase 0 stalls | High | Critical | Must be filled before Phase 0 Week 1 starts |
| R15 | gate-check passes accidentally on noisy 30 days | Medium | Medium | Threshold ladder requires all 5 conditions green for 5 *consecutive* days, not aggregate |
| R16 | UUIDv4 PK page-split storms at 100M+ rows | Low | Low | Acceptable at v1 volumes; UUIDv7 migration in Phase 2 if needed |
| R17 | Half-day market closes mis-scored | Medium | Low | `pandas_market_calendars` in Python writer, documented in `docs/TIME_CONVENTIONS.md` |
| R18 | Corporate actions on sector SPDRs corrupt rolling features | Low | Medium | `adj_close` column added in Prompt 2, `adjustments` table in Phase 2 |

---

## 12. Open questions

These need resolution but are not blocking the start of work. They get resolved during Phase 0.

1. **Symbol seed list final confirmation.** Proposed: `SPY, SPX, ES, VIX, QQQ, NDX, NQ, XLK, XLF, XLE, XLV, XLI, XLP, XLY, XLU, XLRE, XLB, XLC` (18 symbols). Add or remove?
2. **Owner: TBD.** Must be filled before Phase 0 Week 1.
3. **Reddit/StockTwits for v1 or defer?** Free PRAW works but adds maintenance. Defer to Phase 1 unless cheap?
4. **Healthchecks.io URL configuration.** Single check for the writer, or per-symbol checks? Single is simpler.
5. **Gate-check email notification.** When all 5 conditions go green, email admin? Or just dashboard? Dashboard alone is fine for v1.
6. **R2 bucket structure.** `mps-archive/predictions/2026-05.parquet` vs `mps-archive/2026-05/predictions.parquet`? Latter groups by month for cheap monthly purge.
7. **Logging library in Python repo.** `structlog` is the strong default. Confirm.
8. **Prompt caching prompt structure for Claude reasoner.** Long static system prompt (cached) + short per-call user payload (uncached). To be designed in Phase 1.

---

## 13. Glossary

- **rank-IC**: rank correlation between predicted and realized values. Workhorse metric for predictive signals.
- **Brier score**: mean squared error of probability predictions, ∈ [0, 1]. Lower is better. 0.25 = chance for binary.
- **Calibration**: whether "70% probability" events actually happen 70% of the time. Distinct from accuracy.
- **Calibration gap**: max deviation of observed frequency from predicted probability across deciles.
- **Point-in-time (PIT)**: feature at time T uses only data with `available_at <= T`.
- **Survivorship bias**: training on currently-listed symbols only, missing failed/delisted ones. Biases backtests upward.
- **Walk-forward**: train on past, test on future, advance window, repeat. Anti-leakage validation discipline.
- **Shadow mode**: predictions emitted but not consumed externally. Used for the first 30 days to gather feedback data without risk.
- **Regime**: a persistent market state (trending, mean-reverting, crisis). Classified by HMM. Conditions which model performs best.
- **Drift**: input distribution shift (PSI/KS) or output performance degradation (rolling-IC drop).
- **Data grade**: provenance tag on rows. `production | shadow | backfill | synthetic`. Different grades train different model populations.
- **PIT violation**: row in `pit_violations` view. Always a bug. Blocks promotion.
- **`available_at`**: when our system knew about an event. Used for PIT joins.
- **`event_at` / `ts`**: when the event happened in the world. Used for science, not for joining features.
- **`generated_at`**: when a prediction was emitted by the inference job. Partition key on predictions.
- **Last-known-good (LKG) ensemble**: the most recent ensemble_weights row before a drift event fired.
- **Default partition**: catch-all partition for any row whose key doesn't match an explicit partition. Non-empty default = rotation broken.
- **Spend Cap**: Supabase org-level setting. ON = project goes read-only when quota exhausted, no surprise bills. OFF = project keeps running, billed for overage.
- **Emission uptime SLI**: `(cycles emitted within 90s of expected) / (expected cycles in regular session)`. Daily computed.
- **Fail-open**: degrade gracefully (last good prediction with low feed_health). Opposite of fail-closed (refuse to emit).

---

## End of planning document

This document is the contract between human-design and AI-implementation. Cursor (or any other code-generation tool) will be given Prompt 1 next, with explicit reference back to specific sections of this document for justification of every schema choice.

**Next deliverable, after user approval of this document:** the locked, final Prompt 1 SQL migration, ready to paste into Cursor.
