# Learning Loops Specification

**Status:** v3, pending placement. Incorporates Round 6 review (28 items) and Round 7 review (4 blocking items + 12 nice-to-haves with refinements).
**Authority:** Implements PLAN.md §6 (Learning and autocorrection) at algorithm-level. Where this spec conflicts with PLAN.md, PLAN.md wins and this spec is wrong — surface to the human.
**Read-first dependencies:** `AGENTS.md`, `docs/PLAN.md` (especially §3, §4.3, §5.1, §5.6, §5.12, §6, §9).

---

## 0. Purpose and scope

This document specifies, at algorithm level, every adaptive parameter and every learning loop in Market Pulse Predictor v1. It exists because PLAN.md §6 is conceptual prose; without algorithmic detail, AI agents implementing the system will pick reasonable-looking defaults that may not be what a careful designer would pick.

Every loop in this document has six required fields: trigger, algorithm, parameters, smoothing rule, bounds, logging contract. Every parameter has a corresponding row in **Appendix B** (the enumerated learnables table) so it can be audited end-to-end.

**Phase footprint assumption.** Numerical justifications in this spec assume the **Phase 1 footprint** (18 symbols × 5 horizons × 3 model families × ~32 features). **Phase 0** (1 symbol × 1 horizon × 1 model × ~24 Phase-0-available features) sees roughly 1/15th of the data and HPO surface; parameter values still apply, but several bounds (training row count, HPO trial count, EWMA stability) are conservative-by-default for Phase 0.

**Out of scope for this document:**
- Specialist model architectures (XGBoost / LSTM / linear hyperparameters) — that is per-model documentation, not learning-loop documentation
- Feature engineering implementation details — Appendix C lists the catalog; engineering details belong with the Python repo
- Backtest harness — separate document
- Database schema — covered in PLAN.md §5

---

## 1. Loop 1 — Inference-time blender adjustment (seconds)

Implements PLAN.md §6.1.

### 1.1 Trigger

Fires per scoring event: when a `prediction_outcomes` row is written for a prediction `p`, the EWMA-IC for the (specialist, regime, horizon) cell that produced `p` updates. Multiple specialists contributed to `p`'s blended output; each specialist's per-cell EWMA receives an update derived from its individual prediction.

### 1.2 Algorithm

**Exponentially Weighted Moving Average (EWMA) of per-prediction IC contribution per specialist per regime per horizon, combined into mixing weights via softmax with temperature, then clipped to floor/cap and renormalized.**

**Step 1 — Per-prediction IC contribution.** When prediction `p` is scored, for each specialist `m` whose individual prediction `θ_{m,p}` contributed to the blend:

```
ic_t(m, regime, horizon) = sign(θ_{m,p} − 0.5) × sign(realized_return_p)
```

This is a binary {-1, +1} signal: +1 when specialist `m` got the direction right on `p`, −1 when wrong. **Zero-contribution events** (where `θ_{m,p} = 0.5` exactly OR `realized_return_p = 0` exactly) are **non-informative; the EWMA update is skipped entirely** (`ewma_ic = ewma_ic_{t-1}`, no decay applied). This avoids treating a non-informative event as evidence of zero IC, which would incorrectly drive the running estimate toward zero on quiet markets.

The binary signed-correctness form is chosen over a continuous Spearman-style rank-IC because rank-IC requires a batch and is statistically noisy at small batch sizes; the binary form is unbiased per-update and has smaller variance.

**Step 2 — EWMA update.**
```
ewma_ic[m, regime, horizon]_t = α × ic_t + (1 − α) × ewma_ic[m, regime, horizon]_{t−1}
```

The `ewma_ic` table has one cell per (specialist × regime × horizon) — for v1 with 3 specialists × 4 regimes × 5 horizons that's 60 cells. Each cell updates only on scoring events for predictions emitted in that (regime, horizon) by that specialist.

**Step 3 — Softmax mixing weights.** For each (regime, horizon), compute raw weights from EWMA values across the 3 specialists:
```
w_raw[m, regime, horizon] = exp(ewma_ic[m, regime, horizon] / τ) / Σ_{m'} exp(ewma_ic[m', regime, horizon] / τ)
```

**Step 4 — Floor/cap and renormalize.** Clip each weight to `[floor, cap]`, then renormalize so the per-(regime, horizon) weight vector sums to 1.0:
```
w[m, regime, horizon] = clip(w_raw[m, regime, horizon], floor, cap)
w[m, regime, horizon] ← w[m, regime, horizon] / Σ_{m'} w[m', regime, horizon]
```

**Step 5 — Publish on Δ.** Compare new weight vector against the most recent `ensemble_weights` row for the same (regime, horizon). If any weight changed by more than 0.5% absolute, insert a new `ensemble_weights` row and update the active pointer for that (regime, horizon).

**Step 6 — Next-cycle inference.** The newly published weights apply to predictions emitted *after* the publish event, never retroactively to in-flight predictions.

**Why softmax over Hedge/EXP3:** Hedge and EXP3 are no-regret algorithms designed for adversarial settings. Markets are not strictly adversarial against the blender (the market does not know our weights). Softmax over EWMA-IC is simpler, more interpretable, and produces weights that move smoothly. Citation: Cesa-Bianchi & Lugosi (2006) and standard mixture-of-experts literature.

### 1.3 Parameters

| Parameter | Starting value | ROI/risk tradeoff |
|---|---|---|
| EWMA decay α | 0.05 (half-life ≈ 13.5 prediction steps; effective sample size N = 1/α = 20) | Lower α = slower adaptation, less responsive to regime shift; higher α = faster adaptation, more whipsaw. 0.05 is a defensible middle. Per-horizon cadence note below. |
| Softmax temperature τ | 0.05 | Higher τ = weights closer to uniform, less concentration; lower τ = winner-take-most, higher conviction. At realistic IC values [0.02, 0.10] and τ=0.05, the cap=0.50 binds occasionally rather than every cycle. v2 may revisit empirically. |
| Floor weight per specialist | 0.05 | Prevents any specialist from being entirely zeroed out, preserving diversification. |
| Cap weight per specialist | 0.50 | Prevents concentration risk. |
| Max weight Δ per cycle | 2 percentage points absolute | Belt-and-suspenders. With α=0.05 and τ=0.05, single-cycle natural Δ is typically <0.5pp; the cap rarely binds but bounds tail behavior. |

**Per-horizon EWMA cadence note.** α = 0.05 is constant across all (specialist, regime, horizon) cells. Because per-cell update cadence varies with horizon (5m horizon ~12 updates/hour, EOD horizon ~1 update/day), the *real-world* adaptation half-life varies: ≈13.5 minutes for 5m, ≈13.5 trading days for EOD. The slow-horizon adaptation lag is acceptable for v1; per-horizon α is deferred to v2 (Appendix B note).

### 1.4 Smoothing rule

Weights apply to the *next* prediction cycle (no within-cycle update). The weight vector is published to `ensemble_weights` only when at least one weight has changed by more than 0.5% absolute since the last published row, to avoid table growth on noise.

### 1.5 Bounds

- Maximum change per cycle in any single specialist's weight: 2 percentage points absolute
- If raw computed change exceeds 2 pp, clip to 2 pp and log to `drift_events` with severity `info`, kind `weight_clipped`, subject `'<specialist>:<regime>:<horizon>'`

### 1.6 Logging contract

- New row in `ensemble_weights` on weight change > 0.5% (per smoothing rule above)
- `predictions.ensemble_weights_id` references the row used at emission time
- `model_decisions` (when that table exists per PLAN.md Prompt 4 / Phase 1) logs the routing choice including pre-blend specialist outputs and blended output

### 1.7 Failure mode

If the EWMA-IC of any specialist returns NaN (e.g., scoring job is broken), that specialist's weight reverts to 1/N (equal weight) until the next successful EWMA update. Inserts an `info` drift event with kind `ewma_nan`, subject `'<specialist>:<regime>:<horizon>'`.

### 1.8 Reset condition

Drift event with severity `critical` and kind `regime_change` triggers a hard reset: all specialist weights for the new regime initialize from the regime's last-known-good weights (pulled from `ensemble_weights` history) or to 1/N if no history exists for that regime.

**Linkage to Loop 4.** Per §4.2, regime drift events with smoothed regime confidence > 0.7 are emitted at `critical` severity (lower-confidence regime transitions emit at `info`). This makes §1.8's reset path live, not dead, when high-confidence regime changes occur. **Low-confidence regime transitions** (≤ 0.7): the blender continues using the previous regime's weights until a confident transition occurs; no reset, no weight pollution from low-confidence noise.

### 1.9 Cold-start emission policy

On bootstrap with zero scoring history, all (specialist, regime, horizon) EWMA-IC cells initialize to 0. Resulting softmax with τ = 0.05 over zeros produces equal 1/N weights for all specialists in every regime/horizon.

For the **first 13 scoring events per cell** (one EWMA half-life), predictions emitted from that cell are forced to `predictions.shadow = true` regardless of `system_config.shadow_mode_global`. This prevents production-tagged predictions from being emitted with arbitrary cold-start weights. After 13 scored predictions per cell, the cell's EWMA has stabilized and the global shadow flag governs.

**Phase 0 implication.** Phase 0 starts with one cell (1 specialist × 1 regime × 1 horizon, since cold-start regime = `'cold_start'` sentinel per Appendix A.8). At 5m horizon, 13 scored predictions takes roughly 13 × 5 minutes = 65 minutes of market activity. Phase 0 first hour of operation is automatically shadow.

**No drift events during cold-start.** The cold-start period emits no `info`/`warn`/`critical` drift events for cell stabilization itself. This means PLAN.md §2.5 promotion gate item 5 ("drift-event log clean for the training window," disambiguated in §3.4 below) is unaffected by cold-start.

---

## 2. Loop 2 — Daily fast retrain (24 hours)

Implements PLAN.md §6.2.

### 2.1 Trigger

Cron schedule: `0 3 * * 1-5` (**03:00 UTC, Monday-Friday**). Per PLAN.md §6.2.

EOD scoring completes by ~22:00 UTC the prior day. Loop 2 at 03:00 UTC has ~5 hours after EOD scoring completes to finish refits before the next session opens (14:30 UTC for US equities).

### 2.2 Algorithm

**Walk-forward incremental refit** of the *fast* specialists only:

- **XGBoost:** incremental boosting on yesterday's data using `xgb_model=` continuation; no hyperparameter search; learning rate halved relative to original training. Tree count grows from base + 0 → base + 250 over a week of daily increments before next weekly retrain pruning.
- **Linear elastic-net:** re-fit coefficients on rolling 60-day window with fixed λ (no λ search). λ value is held fixed from the most recent weekly retrain (Loop 3).
- **LSTM:** NOT updated daily — too expensive; weekly retrain handles it.

**Why walk-forward incremental:** preserves prior learned structure (faster than scratch retrain), respects PIT discipline (training data is yesterday and earlier, validation is held out, no peeking), and keeps the fast loop fast (~10 minutes total compute on Modal CPU).

### 2.3 Parameters

| Parameter | Starting value | ROI/risk tradeoff |
|---|---|---|
| Training window | rolling 60 days | Shorter = more responsive but smaller sample; longer = more stable but slower to adapt. 60d is roughly two regimes' worth of data. |
| Validation window | rolling 5 days, immediately preceding the prediction-time cutoff | Training is `[t − 65d, t − 5d]`, validation is `[t − 5d, t]`. Walk-forward respects PIT discipline; no leakage. |
| XGBoost incremental learning rate | 0.05 (vs 0.1 in initial training) | Halved to limit per-day drift; the daily refit shouldn't undo last week's structure. |
| XGBoost incremental rounds | 50 (vs 500 in initial training) | Caps daily change. Combined with halved LR, max contribution of one day of new data is ~5x smaller than initial training. |
| Linear λ (elastic-net regularization) | held fixed from weekly retrain | Daily search overfits to recent days. λ search happens weekly. |

### 2.4 Smoothing rule

Refit happens, results are scored on the held-out validation window, and the new model version writes to `model_registry` with `status = 'shadow'`. **The new daily-retrain version does NOT automatically replace the production version.** Promotion happens only on the weekly retrain (Loop 3) per PLAN.md §2.5 promotion gate.

### 2.5 Bounds

- Maximum number of training rows: 60 days × 18 symbols × 390 minutes ≈ 421k rows (Phase 1 footprint). Phase 0: ~23k rows. Both fit comfortably in Modal CPU memory.
- Maximum runtime per refit: 15 minutes. If exceeded, abort, log `critical` drift event with kind `refit_timeout`, subject `'loop2:<family>'`, leave previous day's model in place.
- Data filter: only `data_grade IN ('production', 'shadow')` rows. `backfill` and `synthetic` excluded from daily training.

### 2.6 Logging contract

- New `model_registry` row with `status = 'shadow'`, `version = <date-versioned>`, `family = 'xgb_daily' | 'linear_daily'`
- `model_performance_per_symbol_horizon` rows for the validation-window backtest of the new daily model
- `model_performance_daily` row for the family-level rollup
- Drift event `info` with kind `ic_negative_validation`, subject `'loop2:<family>'` if rank-IC on validation < 0
- Drift event `warn` with kind `ic_drop_30pct`, subject `'loop2:<family>'` if validation rank-IC has dropped > 30% relative to the prior daily refit

### 2.7 Failure mode

Refit error (Modal job fails, OOM, data corruption): previous day's model remains active. Drift event `critical` with kind `refit_failure`, subject `'loop2:<family>'`. Healthchecks.io detects via missing daily-refit ping. No automatic remediation; human investigates.

### 2.8 Reset condition

None. Loop 2 always runs; failures are caught by Loops 3 (weekly) and 4 (drift).

---

## 3. Loop 3 — Weekly full retrain (7 days)

Implements PLAN.md §6.3.

### 3.1 Trigger

Cron schedule: `0 4 * * 0` (Sunday 04:00 UTC, well before Monday open at 14:30 UTC).

### 3.2 Algorithm

**Anchored AND rolling walk-forward** with **family-level Bayesian hyperparameter search (pooled across horizons)**.

For each specialist family:

1. **Anchored walk-forward:** train on `[t_0, t_1]`, validate on `[t_1, t_1 + W]`, advance `t_1` by W, repeat until reaching present.
2. **Rolling walk-forward:** same as anchored but training window slides (drops oldest data each step).
3. **Compare:** if anchored OOS-IC and rolling OOS-IC diverge by > 30%, flag as regime instability and prefer rolling (see §3.2.1 reset rule).
4. **Family-level Bayesian HPO:** Optuna with `direction='maximize'`, 50 trials per specialist family (NOT per family-horizon — HPO is pooled across horizons; per-horizon adjustment happens at the calibration correction layer in Appendix B parameter #15, not at specialist hyperparameters). Optimize:
```
   objective = rank_IC − 0.3 × max(0, calibration_MAE − 0.02) − 0.2 × max(0, brier − 0.18)
```
   The `max(0, ...)` form means the calibration and Brier penalties only apply when those metrics exceed the "good" threshold. A model with `calibration_MAE = 0.01` receives no calibration penalty. A model with `calibration_MAE = 0.10` receives a `0.024` penalty. The 0.02 calibration_MAE floor is below PLAN.md §2's ±5% max-deviation success bar (which corresponds to MAE ≈ 0.02-0.03); the 0.18 Brier floor is below PLAN.md §2's < 0.22 success target. **The 0.3 and 0.2 multipliers are fixed constants, not learnables;** see Appendix B note.
5. **Per-family GPU-min budget breakdown** (replaces a flat "50 trials" target — LSTM dominates compute):
   - Linear elastic-net: ≤ 30 GPU-min total (typically ~5 sec/trial; 50 trials in <5 min)
   - XGBoost: ≤ 90 GPU-min total (typically 20-60 sec/trial; 50 trials in 25-50 min)
   - LSTM: ≤ 120 GPU-min total (typically 3-10 min/trial; budget allows 12-40 trials)
   - Total: ≤ 240 GPU-min = 4 GPU-hours (matches PLAN.md §9 budget)
   - 25-trial-per-family floor still applies (see §3.5); if LSTM hits the time cap before 25 trials complete, fall back to previous week's production LSTM model.
6. **Promote candidate:** the best hyperparameter configuration that *also* satisfies all five PLAN.md §2.5 promotion gate items becomes a `candidate` in `model_registry`. Final `candidate → production` requires admin approval per PLAN.md §6.4.

**Why this combination:** anchored walk-forward checks whether more data helps; rolling checks recency. Their divergence is itself a regime-shift signal. Bayesian HPO finds non-obvious threshold compounds without the runtime cost of grid search. The compound objective penalizes calibration and Brier excursions over their good-thresholds while rewarding raw IC. Citations: López de Prado (2018) on walk-forward CV; Bergstra et al. (2012); Akiba et al. (2019) on Optuna; Guidolin & Timmermann (2007) on multi-state regime-switching.

### 3.2.1 Anchored↔rolling preference reset rule

Once "prefer rolling" fires (per §3.2 step 3), it remains in effect until **4 consecutive Loop 3 cycles where rolling and anchored OOS-IC agree within 10% relative AND both have positive OOS-IC AND no critical drift events fired in the cycle window**. When all three conditions hold for 4 cycles, preference resets to using both equally (mean OOS-IC).

The 10% relative agreement threshold is stricter than the 30% relative divergence threshold that fires the rule. This asymmetry prevents oscillating preference under noisy IC measurements.

### 3.3 Parameters

| Parameter | Starting value | ROI/risk tradeoff |
|---|---|---|
| Anchored window start | start of available training data (rolling 5y from R2 Parquet) | Five years includes one regime cycle. **Sourced from R2 Parquet via DuckDB per PLAN.md §3.7; never written to Supabase.** |
| Rolling window length | 18 months | Long enough to capture multiple regimes, short enough to track drift. |
| Walk-forward step W | 4 weeks | Shorter step = more validation samples but more compute; 4w balances. |
| HPO trials per family (pooled across horizons) | 50 target, subject to per-family GPU-min budget | Standard convergence range for tabular ML (Akiba et al. 2019). LSTM may complete fewer trials within budget. |
| HPO objective | `rank_IC − 0.3 · max(0, calibration_MAE − 0.02) − 0.2 · max(0, brier − 0.18)` | Compound objective with floored penalties. PLAN.md §2 success criteria are Brier < 0.22, calibration max-deviation ≤ ±5%; the 0.18 and 0.02 thresholds are "good enough" floors below which the model is not penalized. The 0.3 and 0.2 multipliers are fixed (not learnable); changing them requires a spec revision. |
| HPO compute budget | 240 GPU-min (4 GPU-hours) per Sunday, allocated per-family per §3.2 step 5 | Within PLAN.md §9 budget. |
| Minimum HPO trials before "best-so-far" fallback | 25 per family | If compute budget is exhausted before 25 trials per family complete, revert to previous week's production model rather than promoting from a tiny trial set. |

### 3.4 Smoothing rule

A new weekly model with `status = 'candidate'` does not auto-promote. PLAN.md §2.5 promotion gate (5 items) must pass; admin must approve via dashboard. The previous production model continues serving.

**§2.5 item 5 disambiguation.** PLAN.md §2.5 item 5 ("drift-event log clean for the training window") is interpreted as:

- Zero unresolved `critical` events AND zero unresolved `warn` events for any drift_event matching one of:
  - `subject = '<feature_name>'` for any feature in the candidate's `feature_set` JSONB
  - `subject` referencing the candidate's own `model_id`
  - `kind = 'regime_change'` whose `ts` falls within the training window
- `info` events permitted (otherwise no model would ever pass; regime transitions emit info events routinely)

The dedup key per §4.4 is `(kind, severity, subject)`. The `subject` text column on `drift_events` (per PLAN.md §5.1 schema-additive change) supports this disambiguation directly via indexed lookup.

### 3.5 Bounds

- Hyperparameter ranges per specialist are bounded (see per-family docs). Examples: XGBoost depth ∈ [3, 8], learning rate ∈ [0.01, 0.2], L2 ∈ [0.1, 10].
- HPO timeout: per-family GPU-min budget per §3.2 step 5. If a family's allocation is exhausted before 25 trials complete, that family falls back to the previous week's production model (no candidate emerges from the family this week).
- Total Sunday compute budget: 6 hours wall clock, 4 GPU-hours billable.

### 3.6 Logging contract

- New `model_registry` row per family-horizon serving binding (HPO is family-level but per-horizon production rows still exist with the same hyperparameters), `status = 'candidate'`, full hyperparameters, feature_set, artifact_uri, training_window_start, training_window_end
- `model_performance_per_symbol_horizon` rows for the candidate's full backtest
- `model_performance_daily` family-level rollup row
- `drift_events` info-level entry with kind `weekly_hpo_summary`, subject `'loop3:<family>'` summarizing the week's HPO results

### 3.7 Failure mode

Sunday refit fails: previous production model stays active. Critical drift event with kind `refit_failure`, subject `'loop3:<family>'`. Healthchecks.io fires. Admin investigates.

If Sunday refit completes but no candidate passes the promotion gate (any of the 5 items missing or below threshold), the candidate is logged but `status = 'candidate'` does not transition. A `warn` drift event with kind `promotion_gate_blocked`, subject `'<candidate_model_id>'` records which gate item failed (in `details`).

### 3.8 Reset condition

None. The weekly retrain is the canonical model-update mechanism.

---

## 4. Loop 4 — Drift-triggered emergency response (sub-day)

Implements PLAN.md §6.4.

### 4.1 Trigger

Three independent triggers, any one fires:

1. **Input drift:** PSI > 0.2 on any production feature, computed hourly via cron
2. **Performance drift:** Either of these conditions, evaluated on the production blender's predictions:
   - **Rolling 7-day pooled IC z-score < −1**, OR
   - **Rolling 7-day pooled IC < 0 for ≥ 14 consecutive trading days**
3. **Regime drift:** Smoothed regime label transition with confidence > 0.7 (emits `critical`); transitions with confidence ≤ 0.7 emit `info` (no Loop 4 trigger)

**Z-score reference distribution.** The "rolling 7d IC z-score" is computed against an empirical reference distribution. The reference distribution is the **past 90 days of validation IC** from Loop 2 daily-refit runs, **pooled across horizons** (weighted by per-horizon prediction count to match the live trigger's pooling). The reference refreshes weekly at Loop 3 retrain (the new production model's training-window IC distribution becomes the reference for the next week's z-score calculations). The 90-day reference window with ~5 horizons gives ~450 reference observations, sufficient for stable mean/stdev estimation.

This makes the trigger statistically grounded (z < −1 is significant against the model's own historical IC distribution, not against a hand-picked threshold).

### 4.2 Algorithm

**On input drift (PSI > 0.2):**

PSI is computed against **10 equal-frequency bins**, with the following pseudocode-grade specification to remove implementer ambiguity:

```
bin_edges = 9 quantile cuts at [10%, 20%, ..., 90%] of training data
            for the affected feature, computed at training time, frozen
            for the model's lifetime
bin_convention: (lower, upper] for bins 1-9; bin 10 is (lower, +inf]
                bin 1 lower edge is -inf
live_value_clamp: live values clamped to [bin_1_lower, bin_10_upper]
                  before binning (no out-of-range bin)
tie_handling: live values exactly equal to a bin edge go into the
              higher bin (consistent with (lower, upper] convention)
ε_floor: live_pct values below 0.0001 clipped to 0.0001 to avoid log(0);
         train_pct is NOT floored (equal-frequency training cuts
         guarantee non-zero training mass per bin by construction,
         except when ties at quantile cuts produce zero-frequency
         bins — see tie_resolution below)
tie_resolution: if equal-frequency cuts produce a zero-frequency bin
                in training (caused by ties at quantile boundaries),
                that bin is collapsed: edges adjusted so all training
                bins have ≥ 1% mass; the affected feature is logged
                with kind='psi_bin_collapse', subject='<feature>',
                severity=info at training time
PSI = Σ_bins ((live_pct - train_pct) × ln(live_pct / train_pct))
```

Severity ladder:
- PSI 0.2-0.3: insert `warn` drift event with kind `psi_warn`, subject `'<feature_name>'`. Continue serving. Flag affected feature in dashboard.
- PSI > 0.3: insert `critical` drift event with kind `psi_critical`, subject `'<feature_name>'` (subject to severity-aware dedup per §4.4). Mark feature as `degraded` in `features_latest.feed_health` (deduct 0.1 from feed_health). Continue serving.
- PSI > 0.5: insert `critical` drift event with kind `feature_masked`, subject `'<feature_name>'`. Set `features_latest.masked_at` JSONB key for the affected feature to `now()` per PLAN.md §5.6. Apply per-family mask semantics (§4.2.1). Continue serving without it.

**On performance drift (rolling 7d IC degradation):**

Rolling 7d IC is computed **pooled across horizons**, weighted by per-horizon prediction count. The pooling is necessary because per-horizon IC is too noisy at 7-day windows.

- Insert `critical` drift event with kind `performance_drift`, subject `'blender_global'`.
- Last-known-good (LKG) ensemble weights restored: pull the most recent `ensemble_weights` row where `computed_at` is at least 7 days ago AND that row's **post-restoration** outcomes (computed only over predictions emitted *after* restoration would have applied) showed positive rolling IC.
- Queue an emergency Loop 3 refit (mechanics: §4.2.2 below).
- After LKG restore, performance evaluation uses **post-restore data only**. The 7d IC < 0 window resets at LKG restore time. Re-trigger requires new post-restore evidence.
- If post-restore performance also fails (z-score < −1 over post-restore 7-day window AND post-restore window has ≥ 1000 predictions for statistical validity), escalate: set `system_config.emission_enabled = false` (kill switch). Admin must intervene per ROLLBACK_RUNBOOK kill-switch protocol.

**On regime drift (regime label change with conf > 0.7):**

- Specialist weights for the new regime initialize from `ensemble_weights` rows tagged with that regime label (most recent successful row). If no history for that regime, initialize 1/N.
- Insert `critical` drift event with kind `regime_change`, subject `'<from_regime>_to_<to_regime>'`, details `{from: <old>, to: <new>, confidence: <conf>}`.
- 15-minute transition lockout: no further regime weight changes until 15 minutes elapse (prevents whipsaw).

### 4.2.1 Per-family feature mask semantics

When PSI > 0.5 triggers a feature mask, the mask is applied per model family:

- **Linear / elastic-net:** set the feature's coefficient to 0 in the inference path. (The training-time coefficient remains; runtime override.)
- **XGBoost:** replace the feature's value at inference time with the **training-set mean** for that feature. Setting to zero is incorrect because XGBoost trees still split on the feature; mean-imputation places the input near the training distribution. Log the imputation event to `drift_events` with kind `feature_imputed_for_mask`, subject `'<feature_name>:xgb'`.
- **LSTM:** forward-fill the feature value from the last valid (non-masked) observation. If no valid prior observation exists in the LSTM's recurrent window (i.e., the feature has been masked for the entire window), substitute the training-set mean for every input timestep. **When this all-mean fallback is active for ≥ 60 consecutive cycles**, log a separate drift event with kind `lstm_mask_window_saturated`, subject `'<feature_name>:lstm'`, severity `warn` — admins can detect when the LSTM is effectively running at reduced rank and may want to intervene.

The masked feature's status reverts to active only at the next Loop 3 weekly retrain that successfully re-includes the feature (i.e., its retrained PSI is < 0.3 on the new training data). Until then, `features_latest.masked_at[feature_name]` remains non-NULL.

### 4.2.2 Emergency Loop 3 refit mechanics

When Loop 4 queues an emergency refit:

- Write a row to `system_config` with `key = 'emergency_retrain_requested'`, `value = {requested_at, reason, requested_by}` (jsonb). Per PLAN.md §5.12 CHECK, this key is admitted; per the same section, system_config writes are operator/admin-gated.
- Modal worker (driven by hourly cron) polls this row; if `value.completed_at` is NULL, invokes Loop 3 with the same algorithm but tighter compute budget (2 GPU-hours, 25 trials per family minimum). Sets `value.completed_at = now()` on success (UPDATE, not INSERT — the system_config_audit trigger logs the change to `system_config_history`).
- If the emergency refit's candidate fails the promotion gate, the previous production model remains active. The `system_alerts` table (Phase 1 / Prompt 4) receives a row prompting admin intervention.

### 4.3 Parameters

| Parameter | Starting value | ROI/risk tradeoff |
|---|---|---|
| PSI warn threshold | 0.2 | Standard threshold from credit-risk literature. (Note: 0.1/0.25 is the alternative literature standard; 0.2/0.3/0.5 is the MPS ladder, custom-tuned for trading-system sensitivity.) |
| PSI critical threshold | 0.3 | Significant population-level distribution change; affects model trust. |
| PSI mask threshold | 0.5 | Severe shift; feature's training distribution no longer matches live. |
| PSI bin construction | 10 equal-frequency bins, frozen at training time, with pseudocode in §4.2 | Standard credit-risk practice; deterministic across implementers. |
| Performance critical threshold (z-score) | rolling 7d pooled IC z-score < −1 against 90-day pooled validation reference | Statistical significance, not absolute. Reduces false positives from sampling noise. |
| Performance critical threshold (persistence) | pooled IC < 0 for ≥ 14 consecutive trading days | Absolute alternative; catches slow grind-down where z-score isn't extreme but trend is bad. |
| Performance escalation threshold | post-restore 7d IC z-score < −1 with ≥ 1000 predictions | Two consecutive failures with statistical validity = systemic issue. |
| Regime confidence threshold for `critical` severity | 0.7 | Below 0.7, regime transitions emit `info` only (no Loop 4 trigger). |
| Transition lockout | 15 minutes | Prevents oscillating regime labels from causing weight thrashing. |
| Drift check cadence | hourly (input drift), 60s (perf drift, regime drift) | Input distributions change slowly; performance and regime change faster. |
| LSTM mask window saturation threshold | 60 consecutive cycles | At 60-second cadence, 60 cycles = 1 hour of all-mean LSTM input before warn-level drift event fires. |

### 4.4 Smoothing rule (severity-aware dedup)

Drift events are de-duplicated on the **(kind, severity, subject)** tuple, where `subject` is a queryable, indexed text column on `drift_events` per PLAN.md §5.1 schema-additive change. The dedup query is:

```sql
SELECT id FROM drift_events
WHERE kind = $1 AND severity = $2 AND subject = $3
  AND resolved_at IS NULL
LIMIT 1;
```

backed by the partial index `drift_events_kind_severity_subject_idx ON (kind, severity, subject) WHERE resolved_at IS NULL`.

If the query returns a row, the new event is suppressed (the existing unresolved event already covers this subject at this severity). **Severity escalations always insert a new event** referencing the prior unresolved one in `details.escalates_from = <prior_event_id>`. This means a `warn` event at PSI=0.21 (subject `'realized_vol_5m'`, severity `warn`) does NOT silence a later `critical` event at PSI=0.55 (subject `'realized_vol_5m'`, severity `critical`); the critical event fires because the dedup tuple `(kind=psi_critical, severity=critical, subject='realized_vol_5m')` is distinct from the warn event's tuple.

### 4.5 Bounds

- Maximum number of mass weight resets per 24h: 1. After one critical-perf-drift event triggers a reset, further perf-drift events within 24h escalate (not reset again). Prevents reset-and-fail loops.
- Maximum number of feature masks active concurrently: 5 of N (N = total feature count). If 5 features are masked, a `system_alerts` row inserts critical event "feature mask saturation" for human review.
- Maximum emergency Loop 3 invocations per 24h: 1. Subsequent triggers within 24h are deferred to the next scheduled Sunday Loop 3.

### 4.6 Logging contract

- `drift_events` row with appropriate severity, kind, and subject, dedup per §4.4
- `ensemble_weights` row when LKG is restored, with `reason = 'lkg_restore_post_perf_drift'`
- `system_alerts` (PLAN.md Prompt 4) row when escalation thresholds hit
- `system_config_history` row when kill switch flips (auto-logged via PLAN.md §5.12 audit trigger)

### 4.7 Failure mode

Drift detector itself crashes: hourly cron fails, Healthchecks.io ping for that cron stops, alert fires. The system continues serving with stale drift state until detector recovers — accepted risk because the alternative (halt on detector failure) creates more outages than it prevents.

### 4.8 Reset condition

Admin manually resolves drift events via the dashboard. Resolved events do not re-fire from the same root cause within 24h (the dedup rule).

---

## 5. Inter-loop interaction

The four loops compose as follows:

- Loop 1 (seconds) updates blender weights continuously
- Loop 4 (sub-day) can override Loop 1 with LKG restore
- Loop 2 (daily) provides new model artifacts that don't auto-promote
- Loop 3 (weekly) is the only loop that promotes models to production

**Race condition handling:**

- If Loop 4 fires during Loop 1 weight update, Loop 4 wins (LKG restore takes priority over EWMA increment).
- If Loop 2 daily refit completes during Loop 4 emergency response, the daily refit completes but the resulting `shadow` model is not consumed; emergency response uses the existing production model with LKG weights.
- If Loop 3 weekly retrain conflicts with Loop 4 emergency, the scheduled Sunday Loop 3 completes; the Loop 4-queued emergency Loop 3 (per §4.2.2) is deferred to the next available cron slot.

---

## 6. Drift event vocabulary

This is the **constrained vocabulary** of `drift_events.kind` values used throughout this spec. Adding a new kind requires updating this table in a future revision. Implementers MUST use these exact strings (no synonyms, no abbreviations) so dedup logic in §4.4 works correctly.

| Kind | Loop | Severity range | Subject convention |
|---|---|---|---|
| `weight_clipped` | Loop 1 | info | `'<specialist>:<regime>:<horizon>'` |
| `ewma_nan` | Loop 1 | info | `'<specialist>:<regime>:<horizon>'` |
| `regime_change` | Loop 1 / Appendix A | info \| critical | `'<from_regime>_to_<to_regime>'` |
| `ic_negative_validation` | Loop 2 | info | `'loop2:<family>'` |
| `ic_drop_30pct` | Loop 2 | warn | `'loop2:<family>'` |
| `refit_timeout` | Loop 2 | critical | `'loop2:<family>'` |
| `refit_failure` | Loop 2 \| Loop 3 | critical | `'loop2:<family>'` \| `'loop3:<family>'` |
| `weekly_hpo_summary` | Loop 3 | info | `'loop3:<family>'` |
| `promotion_gate_blocked` | Loop 3 | warn | `'<candidate_model_id>'` |
| `psi_warn` | Loop 4 | warn | `'<feature_name>'` |
| `psi_critical` | Loop 4 | critical | `'<feature_name>'` |
| `psi_bin_collapse` | training-time (PSI setup) | info | `'<feature_name>'` |
| `feature_masked` | Loop 4 | critical | `'<feature_name>'` |
| `feature_imputed_for_mask` | Loop 4 (XGBoost path) | info | `'<feature_name>:xgb'` |
| `lstm_mask_window_saturated` | Loop 4 (LSTM path) | warn | `'<feature_name>:lstm'` |
| `performance_drift` | Loop 4 | critical | `'blender_global'` |
| `regime_classifier_frozen` | Appendix A.11 | warn | `'hmm'` |
| `partition_default_nonempty` | PLAN.md §5.15 | critical | `'<table_name>'` |

The existing `drift_events.kind` column is `text NOT NULL` with no CHECK constraint (per `supabase_phase0_schema.sql`); the vocabulary is enforced by this spec, not the schema. A future hardening step may add a CHECK constraint to the schema once the vocabulary is fully stable across Phase 1 implementation.

---

# Appendix A — Regime Classifier Specification

Implements PLAN.md §4.3 regime classifier sub-spec pointer.

## A.1 Algorithm

**Hidden Markov Model (HMM) with Gaussian emissions, fit via Baum-Welch (EM).** Inference at runtime via Viterbi for max-likelihood path; smoothed labels via forward-backward.

**Why HMM over simpler alternatives:** rule-based regime definitions are brittle to threshold drift. Clustering on instantaneous features ignores temporal persistence. HMM models temporal persistence explicitly via transition probabilities. Citations: Hamilton (1989) on regime-switching; Guidolin & Timmermann (2007) on multi-state extensions for finance.

## A.2 State count: 4

- `trending_low_vol` — directional drift, low realized volatility
- `trending_high_vol` — directional drift, high realized volatility
- `mean_revert` — chop, no directional persistence
- `crisis` — high vol-of-vol, breadth collapse, cross-asset correlation spike

**Why 4 states:** 3 (bull/bear/chop) doesn't separate vol regimes within trends. 7+ risks per-state sample-size starvation. 4 is the empirical balance for index-level data.

## A.3 Feature inputs to the HMM

Five features, all PIT-correct:

1. **Realized volatility:** standard deviation of 5-min log returns over rolling 60-min window, annualized. Computed continuously at 1-minute cadence from SPY ticks.
2. **Vol-of-vol:** standard deviation of the realized vol time series itself over rolling 24-hour window. Computed at 1-minute cadence.
3. **Sector breadth:** count of 11 sector SPDRs (XLK, XLF, XLE, XLV, XLI, XLP, XLY, XLU, XLRE, XLB, XLC) above their respective 50-day moving averages, divided by 11. Computed at 1-minute cadence (intraday breadth using current sector ETF prices vs the static-at-day-start 50-day MA).
4. **Term-structure slope:** `(VIX9D − VIX) / VIX`. **Source: Polygon Indices Starter SKU (`I:VIX9D`, `I:VIX`)** per PLAN.md §9. Negative = backwardation = stress signal. Note: Indices Starter delivers 15-min delayed quotes; the term-structure feature is staler than the other 4 HMM inputs but still PIT-correct (its `available_at` is correctly stamped at ingest time + 15 min).
5. **Cross-asset correlation regime:** 30-day rolling Pearson correlation between SPY and TLT (treasury proxy). Risk-on regime ≈ negative correlation; risk-off / crisis ≈ positive correlation. Computed at 1-minute cadence.

All five features have entries in Appendix C.

**Note on sector breadth being intraday-discrete.** Feature #3 takes only 12 distinct values (0/11, 1/11, ..., 11/11), making it less continuous than the other 4 features. This is acceptable for the HMM Gaussian emission because (a) the feature changes throughout the trading day as sector SPDR prices move relative to their fixed 50-day MAs, (b) the HMM Gaussian likelihood treats each feature dimension independently, so the discreteness of one dimension does not corrupt the others.

## A.4 Training and refit cadence

- **Initial fit:** 5-year history of the five features, fit via Baum-Welch during model warm-up. **Sourced from R2 Parquet via DuckDB per PLAN.md §3.7; no historical features written to Supabase.** Initial fit cost: ~492k 1-min observations × 5 features at 4 states with ~50 EM iterations, ~400M total operations; budgeted ~30 minutes on Modal CPU during initial warm-up.
- **Production refit cadence:** Loop 3 (weekly), as part of full retrain. Weekly refit reuses prior weights as initialization; convergence is fast (~5 minutes added to the §3.5 6-hour wall-clock budget).
- **Initial state probabilities:** uniform 1/4
- **Transition matrix prior:** diagonal-heavy (0.7 self-transition, 0.1 to each other state) to encode regime stickiness

## A.5 Smoothing rule

Raw HMM Viterbi label changes too frequently for blender stability. The published `regimes.smoothed_label` follows this rule:

- New raw label proposed by HMM
- Confirmed only if same raw label appears in 3 of the most recent 5 1-minute classifications
- Otherwise prior smoothed_label persists

This adds ~3-minute lag but eliminates whipsaw.

## A.6 Sample-size guarantees per state

Each state must have ≥ 500 1-minute observations in the training window to bind blender weights for that state. If the count falls below 500, the regime is flagged `under-sampled` and the blender falls back to all-regimes-pooled weights for that state.

500 observations corresponds to ~1.5 trading days. Most states have far more across the 5-year history (2018 vol spike, 2020 COVID, 2022 inflation cycle, 2023 banking, 2025 macro events all contributed crisis-state minutes). The starvation case is theoretical for v1; the guard exists in case Phase 2 expands to cross-sectional or single-name markets where regime samples can be sparser.

## A.7 Transition lockout

After any smoothed label transition, no further transitions are accepted for 15 minutes. Hard-coded; not user-tunable in v1.

## A.8 Cold start

For the first 60 minutes after system start (or after a regime classifier crash + restart), `regimes.smoothed_label = 'cold_start'` (sentinel value, NOT 'trending_low_vol') with `confidence = 0.5`. Blender uses pooled-all-regimes weights when smoothed_label = 'cold_start'. After 60 minutes of accumulated 1-min observations, normal HMM operation resumes and smoothed_label takes one of the four real regime labels.

Using a sentinel value (`cold_start`) instead of a real regime label makes the cold-start state explicit in `regimes` history and prevents the `ensemble_weights` for `trending_low_vol` from being polluted with cold-start data.

## A.9 Logging contract

- `regimes` row written every minute with `ts`, `label` (raw Viterbi), `smoothed_label`, `confidence`, `features` (the 5 inputs)
- Smoothed label transitions also generate a `regime_change` drift event:
  - Severity `critical` when confidence > 0.7 (triggers Loop 4 §4.2)
  - Severity `info` when confidence ≤ 0.7

## A.10 Failure mode

HMM fitting fails (singular matrix, non-convergence): use last-known-good HMM parameters from previous successful weekly fit. Insert critical drift event with kind `refit_failure`, subject `'hmm'`. Continue inference.

## A.11 HMM under masked feature

If any of the 5 HMM input features is masked by Loop 4 (PSI > 0.5):

- Freeze the regime classifier on the last successful smoothed_label until the masked feature un-masks at the next Loop 3 retrain
- Insert `warn`-severity drift event with kind `regime_classifier_frozen`, subject `'hmm'` (severity is `warn`, not `critical`, because this is a controlled fallback that continues serving with pooled-all-regimes weights — not an emergency requiring 24h admin-ack)
- Blender uses pooled-all-regimes weights during freeze (same path as cold-start and under-sampled regime fallback)

If the last successful smoothed_label was `'cold_start'` (sentinel), the freeze stays on `'cold_start'`. Blender behavior during freeze-on-cold-start is identical to normal cold-start (pooled weights), so no special handling required.

This is a conservative response. Running the HMM on 4-of-5 features with the missing dimension imputed would distort the Gaussian likelihood and produce unstable regime labels; freezing on a known-valid label is safer.

---

# Appendix B — Enumerated Learnables Table

Every parameter the system updates automatically, in one place. If a parameter isn't here, it isn't auto-updated and changes require human intervention via PR.

| # | Parameter | Cadence | Computed by | Consumed by | Smoothing | Bounds | Override path |
|---|---|---|---|---|---|---|---|
| 1 | EWMA-IC per (specialist, regime, horizon) | Per scoring event (skip on zero-contribution) | Loop 1 §1.2 | Loop 1 (softmax input) | EWMA α=0.05 | none | manual `ensemble_weights` insert |
| 2 | Blender weight per (specialist, regime, horizon) | Per scoring event (publish on Δ>0.5%) | Loop 1 | Inference | Softmax τ=0.05, then floor/cap clip | floor 0.05, cap 0.50, max Δ 2pp/cycle | admin override via dashboard, logged |
| 3 | XGBoost daily incremental boost | Daily 03:00 UTC | Loop 2 | Inference (next-day) | none (replaces shadow) | LR 0.05, 50 rounds | skip via `emission_enabled=false` |
| 4 | Linear elastic-net daily refit coefficients | Daily 03:00 UTC | Loop 2 | Inference (next-day) | none | λ fixed from weekly | same |
| 5 | Specialist hyperparameters (family-level) | Weekly Sunday 04:00 UTC | Loop 3 (Bayesian HPO) | Loop 3 next refit | none | family-specific bounds, per-family GPU-min budget | manual HPO cancel |
| 6 | Specialist model weights (full retrain) | Weekly | Loop 3 | Inference (after promotion) | promotion gate (5 items, §3.4 disambiguation) | model_registry status enum | admin reject promotion |
| 7 | HMM transition matrix | Weekly | Appendix A.4 refit (in Loop 3) | Regime classifier | EM convergence | diagonal-heavy prior | manual reset |
| 8 | HMM emission means/covariances | Weekly | same | Regime classifier | same | same | same |
| 9 | Regime smoothed_label | Per minute | Appendix A.5 | Loop 1 (which regime's weights) | 3-of-5 majority | 15-min lockout, cold_start sentinel | manual override via dashboard |
| 10 | Per-feature continuous degradation (`features_latest.feed_health`) | Per drift check (hourly) | Loop 4 §4.2 | Inference (informational, not gating) | none | numeric(4,3) ∈ [0,1] | admin restore via dashboard |
| 11 | Per-feature binary mask (`features_latest.masked_at` JSONB key) | Per drift check (hourly) | Loop 4 §4.2.1 | Inference (per-family mask semantics) | none | jsonb key present = masked, absent = active | admin un-mask via dashboard, OR Loop 3 retrain re-includes |
| 12 | Active production model_id | Per admin promotion | Human admin via dashboard | Inference | manual gate | n/a | n/a |
| 13 | Active ensemble_weights row pointer | Per Loop 1 publish | Loop 1 §1.2 step 5 | Inference | n/a | n/a | n/a |
| 14 | Time-decay half-life per feature | Weekly | Loop 3 (re-fit alongside features) | Feature engineering | none | per-feature bounds (Appendix C) | manual override via system_config |
| 15 | Calibration correction (isotonic regression) per (specialist, horizon) | Weekly | Loop 3 | Post-blend prediction adjustment | identity if calibration MAE < 0.02 OR fit sample N < 1000 | output ∈ [0, 1], monotone non-decreasing | skip via system_config flag |

**15 auto-updated parameters total.**

**Fixed constants (NOT learnable):** The HPO objective coefficients 0.3 (calibration_MAE penalty multiplier) and 0.2 (Brier penalty multiplier) are hardcoded in §3.2 step 4 and not in this table. Changing these multipliers requires a spec revision per AGENTS.md §10. v2 may move them to system_config if Phase 1 data shows the calibration weight needs tuning; that move would require an additional system_config CHECK expansion per PLAN.md §5.12.

**v2 deferred:** α-per-horizon (currently fixed at 0.05; Loop 3 could fit per-horizon α if Phase 1 data shows the slow-horizon adaptation lag is materially hurting EOD/next prediction quality).

---

# Appendix C — Feature Catalog v1

32 features across 4 categories. Categorization makes ablation studies tractable and "we need 5 more features" reviews scoped to one category.

**Definition of "half-life seed."** The half-life column specifies the **EWMA smoothing decay applied to the feature's time series at storage time** (NOT the lookback window for the underlying signal computation). Concretely: a feature like `momentum_5d` is computed from a 5-day rolling return at the time of writing; the half-life seed governs how aggressively that computed value is smoothed across consecutive 1-minute storage updates. The half-life seed should generally be longer than the underlying signal's natural cadence (otherwise we double-smooth) but shorter than a horizon at which the signal's information content has decayed.

**Phase availability column:** `P0` = available in Phase 0 (24 features); `P1` = added in Phase 1 (depends on event tables in Python repo); `P2` = deferred to Phase 2. Feature catalog count by phase: P0 = 24 features, P1 adds 8 features (sentiment/event category) for total of 32.

For every feature: name, definition, source table, time-decay half-life seed, phase availability. Time-decay parameters are auto-updated by Loop 3 (parameter #14 in Appendix B); starting values are seeds.

## C.1 Microstructure (8 features)

Hot, fast-decay features computed from tick-level data. Half-lives in minutes.

| Name | Definition | Source | Half-life seed | Phase |
|---|---|---|---|---|
| `bid_ask_spread_bps` | (best_ask − best_bid) / midpoint × 10000, 1-min mean | `quotes` | 5 min | P0 |
| `quote_imbalance` | (bid_size − ask_size) / (bid_size + ask_size) at top of book | `quotes` | 5 min | P0 |
| `trade_flow_imbalance` | (buy_volume − sell_volume) / total_volume per minute | `trades` | 5 min | P0 |
| `vwap_deviation_bps` | (last_price − rolling_5m_vwap) / vwap × 10000 | `bars_1m` | 10 min | P0 |
| `realized_vol_5m` | annualized stdev of 1-min returns over rolling 5 min | `bars_1m` | 15 min | P0 |
| `tick_count` | number of trades per minute | `trades` | 30 min | P0 |
| `large_trade_count` | count of trades with size > 99th-percentile of past 1h | `trades` | 25 min | P0 |
| `futures_basis` | ES − (SPY × ES_multiplier), in points; **requires Polygon Futures SKU per PLAN.md §9** | `bars_1m` (ES, SPY) | 15 min | P0 |

## C.2 Technicals (8 features)

Bar-level technical indicators. Half-lives in hours to days.

| Name | Definition | Source | Half-life seed | Phase |
|---|---|---|---|---|
| `rsi_14` | 14-period RSI on 5-min bars | `bars_5m` | 4 hours | P0 |
| `macd_signal` | MACD signal line on 15-min bars | `bars_15m` | 8 hours | P0 |
| `atr_14_pct` | 14-period ATR / midprice on 1-hour bars | `bars_60m` | 1 day | P0 |
| `momentum_60m` | 60-minute return | `bars_1m` | 2 hours | P0 |
| `momentum_1d` | 1-day return | `bars_1d` | 3 days | P0 |
| `momentum_5d` | 5-day return | `bars_1d` | 3 days | P0 |
| `vol_of_vol_24h` | stdev of realized_vol_5m over rolling 24h | derived | 1 day | P0 |
| `day_of_week` | integer 0=Monday..4=Friday; calendar context for known regime patterns. Single integer feature (not one-hot); specialists handle encoding internally. | calendar | step function (no decay) | P0 |

## C.3 Cross-asset (8 features)

Macro and cross-market signals. Half-lives in hours to days.

| Name | Definition | Source | Half-life seed | Phase |
|---|---|---|---|---|
| `dxy_beta_60m` | 60-min rolling beta of SPY vs DXY | derived | 4 hours | P0 |
| `treasury_curve_slope` | (10Y yield − 2Y yield), latest available | `bars_1m` (TLT, SHY proxies) | 1 day | P0 |
| `vix_level` | VIX index latest. **Source: Polygon Indices Starter (`I:VIX`)** per PLAN.md §9 | `bars_1m` | 2 hours | P0 |
| `vix_term_structure` | (VIX9D − VIX) / VIX. **Source: Polygon Indices Starter (`I:VIX9D`, `I:VIX`)**, 15-min delayed | `bars_1m` | 4 hours | P0 |
| `sector_breadth` | count of 11 sector SPDRs above 50-day MA / 11 | derived (sector SPDRs) | 1 day | P0 |
| `sector_dispersion` | stdev of 1-day returns across 11 sector SPDRs | derived | 1 day | P0 |
| `oil_equity_correlation_24h` | 24-hour rolling Pearson correlation SPY vs CL=F | derived | 2 days | P0 |
| `dollar_strength_momentum` | DXY 5-day return | derived | 3 days | P0 |

## C.4 Sentiment / event (8 features)

News, social, calendar, options, dealer-positioning. Half-lives variable; sentiment decays fast, scheduled events have known clocks.

| Name | Definition | Source | Half-life seed | Phase |
|---|---|---|---|---|
| `news_flow_score_adaptive` | volume-weighted FinBERT sentiment of news with smooth-blended adaptive window: `score = w · score_60m + (1-w) · score_4h`, where `w = sigmoid(article_count_60m − 5)`. Article counts above 5 in the 60-min window weight toward the short-window score; below 5, the 4-hour window dominates. Smooth transition avoids the discontinuity of a hard threshold. | `news` | 30 min | P1 |
| `social_sentiment_5m` | VADER-scored Reddit/StockTwits posts in past 5 min | `social_posts` | 5 min | P1 |
| `earnings_proximity_hours` | hours until next scheduled earnings release in universe | `earnings` (event-conditioned) | step function | P1 |
| `fomc_proximity_hours` | hours until next scheduled FOMC event | `economic_releases` | step function | P1 |
| `economic_release_proximity_hours` | hours until next high-impact economic release | `economic_releases` | step function | P1 |
| `options_putcall_ratio` | put volume / call volume past 1 hour | `options_flow` | 1 hour | P1 |
| `unusual_options_score` | count of unusual options trades past 30 min | `options_flow` | 30 min | P1 |
| `dealer_gamma_estimate` | dealer-net gamma exposure proxy. **Source: SqueezeMetrics free tier per AGENTS.md §4.11 (eighth supplementary feed)** | derived (third-party data) | 4 hours | P1 |

## C.5 Feature governance

- All features in this catalog are PIT-correct: each row in `feature_snapshots` has `max_upstream_available_at <= as_of`. The `vix_level` and `vix_term_structure` features have a known 15-min staleness from Polygon Indices Starter; this is correctly reflected in their `available_at` stamping at ingest time + 15 min.
- **Cross-asset features ingest the following non-prediction symbols:** DXY, TLT, SHY, CL=F, plus `I:VIX` and `I:VIX9D` (Polygon Indices Starter), plus ES (Polygon Futures, for `futures_basis`). Sector SPDRs (XLK, XLF, etc.) are in the prediction universe AND used as inputs. These ingestion-only symbols are feature inputs; the system does not emit predictions for them.
- Adding a new feature requires:
  1. Entry in this Appendix
  2. PR to feature engineering code with PIT-compliant computation
  3. Loop 3 weekly refit must complete one cycle including the new feature before it is added to inference
  4. Post-add monitoring: 30-day drift event log clean for that feature before it counts toward promotion-gate metrics
- Removing a feature requires deprecation per ROLLBACK_RUNBOOK pattern: stop writing the feature, mark `deprecated` in the catalog, wait one Loop 3 cycle, drop from training data
- Feature catalog count is intentionally bounded: 32 features is enough for a v1 ensemble, few enough to avoid overfitting on 5y of data. Adding a 33rd feature requires an ablation study showing it improves OOS rank-IC by **≥ 0.01 absolute AND statistical significance at p < 0.05** in walk-forward backtest, holding all else constant.

---

# Glossary

- **PSI** — Population Stability Index. `Σ ((live_pct − train_pct) × ln(live_pct / train_pct))` per bin.
- **EWMA** — Exponentially Weighted Moving Average. Half-life relates to decay factor by `half_life = ln(0.5) / ln(1 − α)`.
- **HMM** — Hidden Markov Model. Fit via Baum-Welch (EM); inference via Viterbi.
- **LKG** — Last-Known-Good (ensemble weights).
- **HPO** — Hyperparameter Optimization. Performed via Optuna with `direction='maximize'`.
- **OOS** — Out-Of-Sample.
- **PIT** — Point-In-Time. See PLAN.md §3.2.
- **IC** — Information Coefficient (signed correlation between prediction and realized return).
- **Brier** — Brier score. Mean squared error between predicted probability and binary outcome. Lower is better.
- **calibration MAE** — Mean Absolute Error of the calibration curve across deciles. Lower is better.

---
