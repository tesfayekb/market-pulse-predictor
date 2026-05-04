# AGENTS.md

**You are an AI agent (Cursor, Codex, Claude Code, Lovable, Copilot, or other) reading this file before doing any work in this repository.**

This file is the canonical rules-of-engagement for AI agents working on the Market Pulse Predictor project. It binds you. Every other AI rules file in this project (CLAUDE.md, .lovable/instructions.md, .github/copilot-instructions.md if present) is a thin pointer to this file. There is one source of truth and it is this document.

If you are reading this in any repository other than `market-pulse-predictor` or `market-pulse-engine`, you are in the wrong context. Stop and ask the human.

---

## 1. Read-first protocol

**Item 0 is this file (AGENTS.md).** Re-read it at the start of every session. The session-boot ritual in §11 confirms you have done so.

Before producing any code, schema, prompt response, or design output, you MUST read the following files in this order:

1. **`PLAN.md`** — read in full. Always. Every session.
2. **`docs/TIME_CONVENTIONS.md`** — read in full. Always. Time bugs are the most expensive bugs in this system.
3. **`docs/SCHEMA_CONTRACT.md`** — read if your work touches the database, RLS, migrations, or any schema-defined invariant.
4. **`docs/LEARNING_LOOPS_SPEC.md`** — read if your work touches models, the blender, drift detection, retraining, regime classification, or feature engineering.
5. **`docs/ACCURACY_PLAYBOOK.md`** — read if you are responding to a metric miss, debugging accuracy, or asked "why is the model performing poorly."
6. **`docs/ROLLBACK_RUNBOOK.md`** — read if your work touches migrations, the kill switches in `system_config`, or any production-recovery scenario.

If a referenced file does not exist yet, STOP. Surface to the human that the document is missing. Do not invent its contents from context.

**Glossary:** if a term is unfamiliar — `specialist`, `regime`, `horizon`, `shadow`, `blender`, `data grade`, `IC`, `Brier`, `PIT`, `feed_health`, etc. — consult PLAN.md §13 (glossary) before guessing.

---

## 2. Mandatory pre-flight output format

**Every response that produces or modifies code, schema, or configuration MUST begin with the following structured block before any other content:**

```
## Pre-flight
- Environment: repo=<market-pulse-predictor|market-pulse-engine>, branch=<X>, Supabase project ref=<Y or N/A>
- Files touched: [path:LOC_added/LOC_removed for each, or "none"]
- Contracts referenced: [for each section, quote the one MUST that constrains this work, in §X.Y: "<quoted MUST>" format, or "no MUSTs apply"]
- Contracts at risk: [list of contracts your proposed change strains, or "none"]
- PIT compliance: confirmed | N/A | violated (explain) [required for any code joining event tables to feature tables]
- Partition compatibility: confirmed | N/A [required for any DDL or INSERT against a partitioned table]
- Idempotency: confirmed | N/A [required for any migration]
- RLS impact: none | added | modified | weakened-forbidden [required for any change to public-schema tables]
- system_config keys read or written: [list, or "none"]
- Out-of-scope items declined: [list of things you noticed but did not implement, or "none"]
- Mocks/stubs introduced: [list each with one-line justification, or "none"]
- New dependencies: [list with version pinned, or "none"]
- Migrations needed: [list of schema changes required, or "none"]
- Tests added or updated: [list, or "none — explain why"]
```

This block is non-optional. It is also non-decorative. The human reviewing your output will read this block first and reject the response if any line is implausible (for example: "Contracts referenced: no MUSTs apply" on a database change, or "Mocks/stubs introduced: none" when you obviously added a mock, or "PIT compliance: confirmed" without naming the join).

The "Contracts referenced" line specifically: do not list section numbers alone. Quote the one MUST per section that binds the proposed work. Example: `§4.4: "predictions partitions by generated_at (NOT ts). This is locked."` Quoting forces pattern-match between contract and code; section-number-only is checkbox theater.

If you cannot produce this block honestly, STOP. The fact that you cannot produce it is itself the signal that you are about to drift. Surface the conflict to the human (see §12 disagreement protocol).

---

## 3. Mandatory prompt frontmatter format

**Every prompt file (Prompt 1, Prompt 2, etc.) and every code-generation request from a human MUST begin with the following frontmatter:**

```
READ FIRST:
- AGENTS.md (always)
- PLAN.md §X.Y, §X.Z (specific sections)
- docs/SCHEMA_CONTRACT.md (if touching DB)
- docs/LEARNING_LOOPS_SPEC.md (if touching models/blender/learning)
- docs/TIME_CONVENTIONS.md (always)

SCOPE OF THIS PROMPT:
- <what is in scope, exactly>

OUT OF SCOPE (do not implement, do not "helpfully" add):
- <enumerated list of things you might be tempted to add>

STOP CONDITIONS:
- If you find yourself reasoning around any contract → STOP, surface the conflict
- If you find yourself implementing anything not in scope → STOP, ask
- If you find yourself adding mocks, stubs, or TODOs → STOP, surface what data or decision is missing
- If you cannot produce the pre-flight block honestly → STOP
```

**Frontmatter responsibility:** the human writing the prompt is responsible for the frontmatter. The human places it at the top of the prompt file or the chat message, before any natural-language description of the task. The AI's job is to **refuse** a prompt without frontmatter — surface the missing frontmatter via the §12 disagreement protocol and do not proceed. The AI MUST NOT silently draft convenient frontmatter and proceed; that defeats the gate.

If a human gives you a prompt without frontmatter, your response is a §12 `## Conflict` block requesting the human supply the frontmatter. You do not infer or substitute.

---

## 4. Section 3 invariants (load-bearing, non-negotiable)

These are extracted from PLAN.md §3. They are MUSTs. Violating any of them is a drift event.

### 4.1 Time
- All timestamps in the database are `timestamptz`, stored as UTC.
- Migration sessions begin with `SET TIME ZONE 'UTC'`.
- The dashboard renders in user-local; conversion happens at the rendering boundary, never in queries.
- The Python ingestion side converts to UTC at the source boundary. No intermediate code path operates in any other timezone.

### 4.2 Point-in-time discipline
- Every event row carries `event_at` AND `available_at`. They are NOT the same column.
- Features always join on `available_at <= as_of`, never `event_at`.
- Feature snapshots carry `max_upstream_available_at`; the row CHECK invariant `max_upstream_available_at <= as_of` is enforced.
- Predictions reference `feature_snapshot_id`; a prediction generated at T must reference a snapshot with `as_of <= T`.

### 4.3 Data grade
- Every prediction and every feature_snapshot has `data_grade ∈ {production, shadow, backfill, synthetic}`.
- Models trained on `backfill` are not the same as models trained on `production`. Mixing them silently is a leakage bug.
- Training jobs filter on `data_grade`. Default to `production` only.

### 4.4 Identity and partition keys
- Every unbounded-growth table is partitioned by range on a wall-clock column.
- `predictions` partitions by `generated_at` (NOT `ts`). This is locked.
- `feature_snapshots` partitions by `as_of`.
- `bars` partitions by `ts`.
- Primary keys on partitioned tables INCLUDE the partition key. FKs to a partitioned parent reference the full PK column set.

### 4.5 RLS and access
- Every public-schema table has Row Level Security ENABLED, even when the policy is permissive.
- Roles: `admin`, `operator`, `viewer`.
- Shadow predictions and all derived rollup tables are gated to `operator` or `admin`.
- Feature engineering IP (jsonb columns: `features`, `weights`, `hyperparams`, `feature_set`) is `operator`/`admin` only.
- The `has_role()` SECURITY DEFINER function uses `SET search_path = ''`, has `EXECUTE` revoked from `public`, granted explicitly to `authenticated`.

### 4.6 Migration policy
- Forward-only. No down() migrations.
- Idempotent: every DDL uses `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`. Policies use `DROP POLICY IF EXISTS` then `CREATE POLICY`.
- Migrations run on a direct connection (port 5432), not the pooler.

### 4.7 Hot retention (Supabase 8 GB ceiling)
- Predictions, prediction_outcomes, prediction_scoring_log, feature_snapshots, model_decisions: 30 days hot.
- Bars 1m: 90 days hot.
- 5-year historical backfill NEVER enters Supabase. It goes directly to Cloudflare R2 as monthly Parquet files.
- Code review MUST reject any PR that writes data older than 90 days into `public.bars` or any other Supabase table.

### 4.8 Partition pre-allocation
- Pre-cut three months ahead at any time. No more, no less.
- Every partitioned table has a `DEFAULT` partition.
- Non-empty default is a critical alarm.

### 4.9 LLM influence bounds
- The Claude reasoner's adjustments are bounded: at most ±0.05 absolute change to `direction_prob`, at most ±0.5σ to `expected_return`.
- The LLM never operates on the critical path; it adjusts the blended prediction post-hoc within these bounds.
- The bounds are enforced in code at the point of LLM output ingestion, NOT advised in the prompt.
- Bound values themselves live in `system_config` (`llm_max_prob_delta`, `llm_max_return_sigma_delta`) and may be tightened by the operator but not loosened beyond ±0.05 / ±0.5σ without a phase-exit review.

### 4.10 Cost ceiling and Spend Cap
- The Supabase Spend Cap MUST be ON for the production project. A code or config change that disables it is a release blocker.
- The recurring-cost soft ceiling for v1 is $500/month at the planned scope (see PLAN.md §9).
- Adding a feed, raising LLM inference frequency, raising bar resolution above 1m, or expanding symbol/horizon coverage requires a budget revision in PLAN.md §9 and explicit owner sign-off before merging.

### 4.11 Architectural lock for v1
- v1 model architecture is **exactly three layers**: specialists → blender → LLM reasoner.
- v1 data feeds are **exactly eight**: Polygon, Alpaca (fallback), NewsAPI, EDGAR, FRED, Reddit, StockTwits, SqueezeMetrics (free tier, supplementary).
- Adding a layer, swapping a layer's algorithm, or adding a feed requires a phase-exit review and an explicit PLAN.md §4 revision.
- AI agents MUST NOT introduce a new layer or feed inside a phase, even when the prompt's narrow scope appears to invite it ("a transformer ensemble would help here", "Twitter sentiment would be a small addition").

---

## 5. Forbidden patterns

These are bug-attractors. You MUST NOT do any of them. If a human asks you to do one of these, surface the conflict before complying.

1. **Mocking what should be live.** Do not introduce mock data, fake API responses, or hardcoded sample values when the real data source exists or is accessible. If the real source is not available, surface that fact and stop; do not silently substitute.

2. **TODO-ing critical paths.** Do not write `# TODO: implement later`, `// FIXME`, or any equivalent in: scoring jobs, drift detection, RLS policies, point-in-time joins, partition rotation, feed health checks, the `pit_invariant` constraint enforcement, the kill switches, or anywhere a human's safety net depends on the code. TODOs are acceptable only in non-critical research scaffolding, and even then must be explicitly justified in the pre-flight `Mocks/stubs introduced` line.

3. **Expanding scope mid-phase.** If the active phase is Phase 0 (1 symbol, 1 horizon, 1 model), do not add a second symbol, second horizon, or second model "since I'm here." Phase boundaries exist precisely to prevent the local-decision-by-local-decision drift the project owner has explicitly warned against. Surface scope expansion requests; do not action them.

4. **Introducing dependencies without listing them.** Every new pip package, npm package, or third-party API call MUST appear in the pre-flight `New dependencies` line with a pinned version. No drive-by `pip install` mid-implementation.

5. **Generating SQL that bypasses partitioning.** Do not write `INSERT INTO predictions ...` without confirming the `generated_at` value falls in an existing partition or the default. Do not write `CREATE TABLE` for any time-series-growing table without partition declaration. Do not write FKs to partitioned parents without composite key matching.

6. **Weakening RLS.** Do not disable RLS on any public-schema table. Do not write `USING (true)` policies on tables holding shadow predictions, feature engineering IP, or scoring outcomes. Do not introduce SECURITY DEFINER functions without `SET search_path = ''` and explicit EXECUTE grants.

7. **Bypassing the kill switches.** Do not write code paths that read predictions or emit predictions while ignoring `system_config.emission_enabled` or `system_config.shadow_mode_global`. Do not add "for testing" overrides that aren't behind a feature flag.

8. **Bypassing the LLM influence bounds.** The Claude reasoner can adjust `direction_prob` by at most ±0.05 and `expected_return` by at most ±0.5σ. Do not raise these bounds, do not let the LLM rewrite the blended prediction wholesale, do not put the LLM on the critical path.

9. **Breaking forward-only migration policy.** Do not write `DROP COLUMN` on a column actively being written to. Do not write `down()` migrations. Recovery is via `docs/ROLLBACK_RUNBOOK.md`, not via reverse migration.

10. **Producing a pre-flight block that is implausible or false.** If your code obviously introduces a mock and your pre-flight says "Mocks/stubs introduced: none," you have lied to the human. Don't.

11. **Renaming contract-defined columns, tables, types, functions, or enums.** An AI sees `event_at` and `available_at`, decides the names are confusing, "improves" them to `recorded_at` and `published_at`. The contract is broken silently. Renaming any name defined in `SCHEMA_CONTRACT.md`, `PLAN.md` §5, or `LEARNING_LOOPS_SPEC.md` is forbidden. Renames require an explicit cross-repo coordination request and a multi-step deprecation per `ROLLBACK_RUNBOOK.md`.

12. **Inferring contracts from existing code instead of from the spec docs.** An AI reads the existing schema or codebase, infers a column type, constraint, or behavior from what's there, and builds against it. But the code may be wrong, mid-migration, or outdated. The contract is what `SCHEMA_CONTRACT.md` and `PLAN.md` say, NOT what `supabase_phase0_schema.sql` happens to contain at the moment. If the spec doc is silent on a question, surface the gap; do not infer from code.

13. **Computing targets, labels, or supervisory signals with leakage from the prediction horizon.** The label for a prediction generated at T with horizon H must use only data with `available_at > T + H` (the future). Revision-prone feeds (fundamentals, earnings restatements, late-arriving macro) may not contribute to labels without a documented as-of policy. Target construction must respect the same point-in-time discipline as feature construction. Violating this is silent; you will not see the bug until the model fails out-of-sample weeks later.

14. **Hardcoding tunable values that belong in `system_config`.** Horizon lists, symbol lists, prediction caps, thresholds, retention windows, time-decay parameters, and LLM influence bounds all live in `system_config` and are read at runtime. Hardcoding any of these in code denies the operator the ability to tune without a deploy. If a value is genuinely fixed by contract (e.g., the partition pre-allocation count is 3 because §4.8 says so), surface it for review and the human decides whether it goes in code or config.

---

## 6. Process gates

These are gates that block forward progress. Some are technical, some are process. All bind.

### 6.1 Owner gate (active until filled)
**No Prompt-N implementation work may begin until `PLAN.md` has the `Owner: TBD` field replaced with a named human accountable for Phase 0 outcomes.**

The doc-writing phase (this AGENTS.md, the spec docs, the playbooks) may proceed with Owner unfilled. Implementation phase may not. If you are asked to start Prompt 1 SQL or any code work and the Owner field still reads `TBD`, STOP and surface to the human.

### 6.2 Supabase environment gate
**Prompt 1 SQL must run against the dedicated MPS Supabase project in its own org.** This project must:

- Live in a separate Supabase organization from the user's other 4 projects (blast-radius isolation).
- Have Spend Cap configured ON.
- Have secrets rotated and present in `wrangler.jsonc` and `.env`.
- Have the dashboard's `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` repointed at the new project.

Until those four conditions are confirmed by the human, Prompt 1 does not run.

### 6.3 Migration testing gate
Migrations affecting `public.predictions`, `public.feature_snapshots`, `public.bars`, `public.model_registry`, or any RLS policy may NOT run against the production Supabase project without first running successfully against either:
- A Supabase Branch (preview database), or
- A local Postgres docker container with the same Postgres major version

The post-migration `\d+` output of the affected tables MUST be diffed and reviewed by the human. The branch test is logged in the migration's commit message. PLAN.md §3.6's "forward-only, idempotent" implies this; this gate enforces it.

### 6.4 Phase exit gates
Each phase has explicit exit criteria in PLAN.md §10. You MUST NOT advance the phase counter or implement Phase N+1 work until Phase N exit criteria are met and explicitly checked off by the human.

### 6.5 Model promotion gate
No model `model_registry.status` may transition `shadow → candidate → production` without all five items from PLAN.md §2.5:
1. Walk-forward backtest results (anchored AND rolling)
2. Calibration plot across deciles
3. Per-symbol × per-horizon IC/Brier breakdown
4. Feature importance dump
5. Drift-event log clean for the training window

Missing any of these blocks the transition. The transition itself is admin-approved via the dashboard. AI agents do not perform promotions autonomously.

### 6.6 Drift acknowledgement gate
Every new row in `public.drift_events` MUST be acknowledged by the named owner within 24 hours via the dashboard's drift-event view. AI agents may NOT write code that auto-resolves drift events. Acknowledgement is a human action with a free-text note. Unacknowledged events older than 24h trigger a Healthchecks.io ping and an entry in `public.system_alerts`.

### 6.7 Cross-repo schema gate
The Schema Contract (`docs/SCHEMA_CONTRACT.md`) lives in two repos: this dashboard repo and the future Python engine repo. CI must diff the two copies on every PR. If they drift, the PR is rejected. Do not modify SCHEMA_CONTRACT.md in only one repo.

---

## 7. AI review checklist

This is what the human reviewing your output checks. You can pre-empt rejection by self-checking against it.

- [ ] Pre-flight block present at top of response
- [ ] Pre-flight block plausibly accurate (not "none" when there's obviously something)
- [ ] Read-first list in pre-flight matches the work being done
- [ ] No new dependencies introduced without pre-flight listing
- [ ] No mocks or TODOs in critical paths
- [ ] Type signatures match the relevant Protocol in `*/base.py` (Python) or `src/lib/types.ts` (TS)
- [ ] RLS policies present on any new public-schema table
- [ ] Partition declarations present on any new time-series-growing table
- [ ] Migration is idempotent (`IF NOT EXISTS`, `DROP POLICY IF EXISTS` then create)
- [ ] Migration begins with `SET TIME ZONE 'UTC';` if it includes any partition boundary literals
- [ ] All `[0,1]` numerics have CHECK constraints
- [ ] No FK violations against composite-PK partitioned parents
- [ ] No code reads or emits predictions while bypassing `system_config` kill switches
- [ ] Tests updated or new tests added; if not, justified in pre-flight
- [ ] No scope expansion beyond the prompt's `SCOPE OF THIS PROMPT` line

If any item is unchecked, the response is rejected. Re-do, do not patch.

---

## 8. Repository identity and pointer rule

This file (`AGENTS.md`) is the canonical AI rules file. Other AI tools in this project must be configured to read it as authoritative, but each tool has its own mechanic — there is no universal "pointer file" pattern.

**AGENTS.md must live at the repo root.** Cursor, Codex, and other agents read AGENTS.md only at root, not in `docs/` or any subdirectory. Do not move it.

### 8.1 Claude Code (CLAUDE.md)
Claude Code reads `CLAUDE.md` at the repo root as its complete rules file. A one-line "See AGENTS.md" pointer does NOT work — Claude Code reads the literal contents of CLAUDE.md, not a redirect. Two acceptable mechanics:

- **Symlink** (preferred on Linux/macOS): `ln -s AGENTS.md CLAUDE.md`. Both files share content, no divergence possible. Note: symlinks have edge cases on Windows and some CI runners; verify your CI handles them.
- **Content mirror** (cross-platform safe): `CLAUDE.md` contains a one-line header followed by the full contents of AGENTS.md:
  ```
  > This file is a mirror of AGENTS.md. The canonical source lives at /AGENTS.md. If this file diverges from AGENTS.md, AGENTS.md wins. Update both together (CI enforces the diff).
  ```
  Then a CI step that fails if `sed -n '/^# AGENTS\.md$/,$p' CLAUDE.md | diff - AGENTS.md` shows divergence. (The `diff CLAUDE.md AGENTS.md | grep -v "^>"` form does NOT work because diff prefixes CLAUDE-only lines with `<`, not `>`; the heading-anchored sed extract is what the actual CI workflow at .github/workflows/agents-mirror-check.yml uses.)

A one-line pointer file is exactly what §5 (forbidden patterns) calls "mocking what should be live." Do not use it.

### 8.2 Lovable
Lovable reads `AGENTS.md` and `CLAUDE.md` natively at repo root. The activation mechanism is the **Project Knowledge** field in the Lovable web UI (10,000 character limit, scoped per project), and the **Workspace Knowledge** field (same, scoped per workspace). Set both fields to:

> Read AGENTS.md from the repo before generating any code. The rules that bind you live there. The repo-side AGENTS.md is read natively; this UI field is the gate that activates it as the binding rules file rather than one context source among many.

Do NOT create `.lovable/instructions.md` — that path is not read by Lovable. The Project Knowledge / Workspace Knowledge UI fields are the activation gate.

### 8.3 Cursor
Cursor reads AGENTS.md natively as of 2026, root-level only. Do not create `.cursorrules` unless Cursor stops supporting AGENTS.md, in which case mirror this file's contents into `.cursorrules` and add a CI diff check.

### 8.4 GitHub Copilot
If used: `.github/copilot-instructions.md` should mirror AGENTS.md following the same content-mirror pattern as CLAUDE.md (§8.1).

### 8.5 Pointer rule summary
This file (`AGENTS.md`) points only to `PLAN.md` and the documents listed in §1. Other rules files mirror this file's content (with CI diff enforcement) — they do not point. The doc graph is two-level: AGENTS.md → PLAN.md + spec docs. Anything deeper is drift.

If you need to add a new rule, do not create a new rules file. Add the rule here.

---

## 9. What this file does NOT cover

- **Code style and formatting.** Use the project's existing prettier / black / ruff / isort config. If none exists, use the framework's idiomatic defaults. Do not introduce a style preference.
- **Specific algorithms for the learning loops.** Those live in `docs/LEARNING_LOOPS_SPEC.md`. AGENTS.md only enforces that you read that file before touching learning code.
- **Specific feature definitions.** Those live in `docs/LEARNING_LOOPS_SPEC.md` Appendix C.
- **Specific failure-mode responses.** Those live in PLAN.md §8.
- **Specific rollback procedures.** Those live in `docs/ROLLBACK_RUNBOOK.md`.

AGENTS.md is the rules-of-engagement. The contracts and the algorithms live in the documents AGENTS.md tells you to read.

---

## 10. When this file should be updated

This file should be updated when:

- A new contract is added to PLAN.md §3 that requires a new MUST in §4 of this file.
- A new forbidden pattern is identified through a real drift event that occurred in implementation.
- A new process gate is needed (a new AI tool joins the project, a new phase has a new prerequisite).
- The pre-flight format needs new fields because a real bug slipped through the existing format.

This file should NOT be updated when:

- Someone wants to "soften" a forbidden pattern. The pattern is forbidden for a reason.
- An AI tool finds the rules constraining. That's the point.
- A specific implementation detail changes. Those go in the spec docs.

Updates to this file require explicit human approval and a one-line entry in the change log below.

---

## 11. Session-boot ritual

The first response in a new agent session — even when no code is being written, even for a clarifying question, even for a "yes/no" — MUST include a §2 pre-flight block. The block proves the rules were loaded.

A response without a pre-flight block is a session that did not boot, and the human will reject it.

For a session whose first request is purely conversational (e.g., "what does this contract mean?"), the pre-flight is minimal but still present:
- Files touched: none
- Contracts referenced: [the section being discussed]
- Everything else: none / N/A

The ritual is cheap. Skipping it is the visible signal that the agent did not load the rules. Do not skip.

---

## 12. Disagreement protocol

When you cannot proceed without violating a contract, a forbidden pattern, an explicit human instruction, or a process gate, output a structured `## Conflict` block before any other content:

```
## Conflict
- Source: [human instruction | contract | forbidden pattern | gate]
- Specific item: [quote the conflicting line, contract section, or instruction verbatim]
- What you were asked to do: [one sentence]
- What the conflict is: [one sentence]
- Options I see: [enumerated list of valid paths]
- Recommendation: [your best path with reasoning]
```

Then STOP. Do not implement until the human resolves the conflict in writing. Do not pick the recommendation unilaterally even if it appears obviously correct.

The `## Conflict` block also applies when:
- A prompt arrives without the §3 frontmatter (refuse, request frontmatter)
- A read-first file is missing (refuse, request the file or surface that it should not be expected)
- Two contracts contradict each other (refuse, surface for resolution)
- A human's instruction contradicts a contract (refuse, surface; the human may override a contract but must do so explicitly, not implicitly)

Like the pre-flight block, the `## Conflict` block converts ambiguity into a forensic artifact. "Surface the conflict" as prose gets compressed into a sentence that humans skim; the structured block does not.

---

## 13. Change log

| Date | Change | Reason |
|---|---|---|
| 2026-05-03 | Initial creation | Round 4 design lock |
| 2026-05-03 | Round 5 review applied: 11 changes including pointer rule fixes (CLAUDE.md mirror, Lovable UI fields, Cursor root-only), expanded pre-flight block (7 new fields), 4 new forbidden patterns, 2 new process gates, 3 new §4 invariants (LLM bounds, cost ceiling, architectural lock), session-boot ritual, disagreement protocol, glossary pointer | Round 5 reviewer corrections |
| 2026-05-04 | §4.11 expanded to 8 feeds (added SqueezeMetrics free tier as supplementary source for dealer_gamma_estimate feature in LEARNING_LOOPS_SPEC.md C.4); §8.1 example expression corrected to match working CI mechanic | Phase 1 feature catalog requirement; reviewer-flagged §8.1 bug from Round 6 verification |

---

## End of AGENTS.md

If you read this far, you are ready to do work in this repository. Start with §1 (read-first protocol), then produce a §2 pre-flight block, then proceed.

If anything in this file conflicts with anything in PLAN.md, PLAN.md wins and this file is wrong — surface it to the human.

If anything you are about to do conflicts with this file, this file wins and you should not do it.

If anything you are about to do conflicts with the human's explicit instruction, surface the conflict to the human and do not proceed unilaterally either way.
