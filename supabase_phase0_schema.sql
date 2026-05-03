-- ============================================================
-- MPS Phase 0 schema — run once in Supabase SQL Editor
-- Plain Postgres (no TimescaleDB) + native partitioning + pg_cron
-- ============================================================

-- Extensions
create extension if not exists pgcrypto;
create extension if not exists vector;
create extension if not exists pg_cron;

-- ============================================================
-- 1. ROLES (admin gating) — separate table, never on profiles
-- ============================================================
create type public.app_role as enum ('admin', 'operator', 'viewer');

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role app_role not null,
  granted_at timestamptz not null default now(),
  unique (user_id, role)
);

alter table public.user_roles enable row level security;

-- SECURITY DEFINER function — prevents recursive RLS
create or replace function public.has_role(_user_id uuid, _role app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and role = _role
  )
$$;

create policy "users read own roles"
on public.user_roles for select
to authenticated
using (auth.uid() = user_id);

create policy "admins manage all roles"
on public.user_roles for all
to authenticated
using (public.has_role(auth.uid(), 'admin'))
with check (public.has_role(auth.uid(), 'admin'));

-- ============================================================
-- 2. SYMBOLS (universe — includes delisted, prevents survivorship bias)
-- ============================================================
create table public.symbols (
  symbol text primary key,
  name text,
  exchange text,
  asset_class text not null default 'equity',
  active boolean not null default true,
  listed_at date,
  delisted_at date,
  created_at timestamptz not null default now()
);

alter table public.symbols enable row level security;
create policy "auth read symbols" on public.symbols for select to authenticated using (true);
create policy "admins write symbols" on public.symbols for all to authenticated
  using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));

-- ============================================================
-- 3. BARS (partitioned hypertable substitute)
-- ============================================================
create table public.bars (
  symbol text not null references public.symbols(symbol),
  ts timestamptz not null,
  interval text not null,                -- '1m','5m','1h','1d'
  open numeric(18,6) not null,
  high numeric(18,6) not null,
  low  numeric(18,6) not null,
  close numeric(18,6) not null,
  volume bigint not null default 0,
  vwap numeric(18,6),
  available_at timestamptz not null default now(), -- point-in-time integrity
  primary key (symbol, interval, ts)
) partition by range (ts);

-- monthly partitions for v1 (extend with pg_cron later)
create table public.bars_2026_05 partition of public.bars
  for values from ('2026-05-01') to ('2026-06-01');
create table public.bars_2026_06 partition of public.bars
  for values from ('2026-06-01') to ('2026-07-01');
create table public.bars_2026_07 partition of public.bars
  for values from ('2026-07-01') to ('2026-08-01');

create index on public.bars (symbol, ts desc);
create index on public.bars (available_at);

alter table public.bars enable row level security;
create policy "auth read bars" on public.bars for select to authenticated using (true);

-- ============================================================
-- 4. FEEDS + FEED HEALTH (operational pane)
-- ============================================================
create table public.feeds (
  source text primary key,            -- 'polygon_ws','fred','sec_edgar'...
  kind text not null,                 -- 'market','macro','fundamentals','news'
  enabled boolean not null default true,
  expected_interval_seconds int,
  notes text
);

create table public.feed_health (
  id uuid primary key default gen_random_uuid(),
  source text not null references public.feeds(source) on delete cascade,
  observed_at timestamptz not null default now(),
  status text not null check (status in ('green','yellow','red')),
  staleness_seconds int,
  latency_ms int,
  error text
);
create index on public.feed_health (source, observed_at desc);

alter table public.feeds enable row level security;
alter table public.feed_health enable row level security;
create policy "auth read feeds" on public.feeds for select to authenticated using (true);
create policy "auth read feed_health" on public.feed_health for select to authenticated using (true);
create policy "admin write feeds" on public.feeds for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));

-- ============================================================
-- 5. DRIFT EVENTS (PSI/KS/IC degradation)
-- ============================================================
create table public.drift_events (
  id uuid primary key default gen_random_uuid(),
  detected_at timestamptz not null default now(),
  kind text not null,                       -- 'psi_feature','ks_target','ic_decay'
  severity text not null check (severity in ('info','warn','critical')),
  feature text,
  model_id uuid,
  details text,
  action text,
  resolved_at timestamptz
);
create index on public.drift_events (detected_at desc);

alter table public.drift_events enable row level security;
create policy "auth read drift" on public.drift_events for select to authenticated using (true);

-- ============================================================
-- 6. MODEL REGISTRY
-- ============================================================
create table public.model_registry (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  version text not null,
  family text not null,                     -- 'logreg','xgb','lstm','ensemble'
  status text not null default 'shadow' check (status in ('shadow','candidate','production','retired')),
  trained_at timestamptz not null default now(),
  promoted_at timestamptz,
  weight numeric(6,4) default 0,            -- ensemble weight
  hyperparams jsonb,
  feature_set jsonb,
  metrics jsonb,                            -- ic, brier, calibration, sharpe...
  artifact_uri text,
  unique (name, version)
);
create index on public.model_registry (status);

alter table public.model_registry enable row level security;
create policy "auth read models" on public.model_registry for select to authenticated using (true);
create policy "admin write models" on public.model_registry for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));

-- ============================================================
-- 7. PREDICTIONS (partitioned)
-- ============================================================
create table public.predictions (
  id uuid not null default gen_random_uuid(),
  model_id uuid not null references public.model_registry(id),
  symbol text not null references public.symbols(symbol),
  ts timestamptz not null,                  -- prediction-for time
  generated_at timestamptz not null default now(),
  horizon text not null,                    -- '5m','1h','1d'
  prob_up numeric(6,5),                     -- calibrated probability
  expected_return numeric(10,6),
  confidence numeric(6,5),
  features_hash text,
  shadow boolean not null default true,
  realized_return numeric(10,6),            -- backfilled
  realized_at timestamptz,
  primary key (id, ts)
) partition by range (ts);

create table public.predictions_2026_05 partition of public.predictions
  for values from ('2026-05-01') to ('2026-06-01');
create table public.predictions_2026_06 partition of public.predictions
  for values from ('2026-06-01') to ('2026-07-01');
create table public.predictions_2026_07 partition of public.predictions
  for values from ('2026-07-01') to ('2026-08-01');

create index on public.predictions (model_id, ts desc);
create index on public.predictions (symbol, ts desc);
create index on public.predictions (generated_at);

alter table public.predictions enable row level security;
create policy "auth read predictions" on public.predictions for select to authenticated using (true);

-- ============================================================
-- 8. COST LEDGER (API + compute spend)
-- ============================================================
create table public.cost_ledger (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  category text not null,                   -- 'polygon','fred','llm','compute','storage'
  units numeric(14,4) not null,             -- requests, tokens, cpu-hours
  unit_label text not null,
  unit_cost_usd numeric(12,6) not null,
  total_usd numeric(12,4) generated always as (units * unit_cost_usd) stored,
  meta jsonb
);
create index on public.cost_ledger (ts desc);
create index on public.cost_ledger (category, ts desc);

alter table public.cost_ledger enable row level security;
create policy "auth read costs" on public.cost_ledger for select to authenticated using (true);

-- ============================================================
-- 9. PERFORMANCE / CALIBRATION daily rollup
-- ============================================================
create table public.model_performance_daily (
  model_id uuid not null references public.model_registry(id),
  day date not null,
  horizon text not null,
  n int not null,
  ic numeric(8,5),
  brier numeric(8,5),
  log_loss numeric(8,5),
  hit_rate numeric(6,4),
  calibration_mae numeric(6,4),
  sharpe numeric(8,4),
  primary key (model_id, day, horizon)
);

alter table public.model_performance_daily enable row level security;
create policy "auth read perf" on public.model_performance_daily for select to authenticated using (true);
