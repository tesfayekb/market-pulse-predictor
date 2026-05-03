// Mock data for the admin dashboard. Replace with Supabase queries once wired.

export const SYMBOLS = ["SPY", "SPX", "ES", "VIX", "QQQ", "NDX", "NQ", "XLK", "XLF", "XLE", "XLV", "XLI", "XLP", "XLY", "XLU", "XLRE", "XLB", "XLC"];
export const HORIZONS = ["5m", "15m", "60m", "eod", "next"] as const;
export type Horizon = typeof HORIZONS[number];

export const FEEDS = [
  { source: "polygon", kind: "market", status: "green", staleness: 1, latency: 42 },
  { source: "alpaca", kind: "market (fallback)", status: "green", staleness: 2, latency: 88 },
  { source: "databento", kind: "historical", status: "green", staleness: 0, latency: 110 },
  { source: "benzinga", kind: "news", status: "yellow", staleness: 47, latency: 320 },
  { source: "newsapi", kind: "news", status: "green", staleness: 8, latency: 180 },
  { source: "gdelt", kind: "news", status: "green", staleness: 12, latency: 240 },
  { source: "edgar", kind: "filings", status: "green", staleness: 6, latency: 200 },
  { source: "reddit", kind: "social", status: "green", staleness: 14, latency: 410 },
  { source: "stocktwits", kind: "social", status: "green", staleness: 9, latency: 280 },
  { source: "opra", kind: "options", status: "green", staleness: 1, latency: 60 },
  { source: "fred", kind: "macro", status: "green", staleness: 3600, latency: 95 },
  { source: "anthropic", kind: "llm reasoner", status: "red", staleness: 312, latency: 0, error: "5xx upstream" },
] as const;

export const DRIFT_EVENTS = [
  { id: "d1", detected_at: "2026-05-03T13:42:11Z", kind: "input_drift", severity: "warn", details: "PSI=0.24 on vix_term_structure", action: "flagged" },
  { id: "d2", detected_at: "2026-05-03T11:08:00Z", kind: "regime_change", severity: "info", details: "trending_low_vol → choppy_mid_vol", action: "ensemble rebalanced" },
  { id: "d3", detected_at: "2026-05-02T20:55:30Z", kind: "perf_drift", severity: "critical", details: "rolling 7d IC = -0.012 on tft-5m", action: "emergency retrain queued" },
];

const seed = <T>(n: number, fn: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => fn(i));

export function predictionSeries(symbol: string, horizon: Horizon) {
  const N = 96;
  const now = Date.now();
  const step = 60_000 * (horizon === "5m" ? 5 : horizon === "15m" ? 15 : horizon === "60m" ? 60 : 60);
  return seed(N, (i) => {
    const t = now - (N - i) * step;
    const drift = Math.sin((i + symbol.length) / 8) * 0.12;
    const noise = (Math.random() - 0.5) * 0.08;
    const prob = Math.max(0.05, Math.min(0.95, 0.5 + drift + noise));
    const realized = i < N - 6 ? (Math.random() - 0.5) * 0.006 + drift * 0.003 : null;
    return { ts: t, direction_prob: +prob.toFixed(3), realized_return: realized };
  });
}

export function recentPredictions() {
  const now = Date.now();
  return SYMBOLS.flatMap((s) =>
    HORIZONS.map((h) => {
      const prob = +(0.5 + (Math.random() - 0.5) * 0.6).toFixed(3);
      return {
        id: `${s}-${h}-${now}`,
        emitted_at: new Date(now - Math.floor(Math.random() * 60_000)).toISOString(),
        symbol: s,
        horizon: h,
        direction_prob: prob,
        expected_return: +((prob - 0.5) * 0.004).toFixed(5),
        return_std: +(0.0015 + Math.random() * 0.002).toFixed(5),
        regime: ["trending_low_vol", "choppy_mid_vol", "crisis"][Math.floor(Math.random() * 3)],
        feed_health: +(0.7 + Math.random() * 0.3).toFixed(2),
        shadow_mode: Math.random() > 0.6,
      };
    }),
  );
}

export const MODELS = [
  { model_id: "ensemble-v1.2.3", family: "blender", horizon: "all", status: "active", trained_at: "2026-05-01", rank_ic: 0.071, brier: 0.213, hit_rate: 0.547, weight: 1.0 },
  { model_id: "xgb-5m-v1.4.0", family: "xgb", horizon: "5m", status: "active", trained_at: "2026-04-28", rank_ic: 0.062, brier: 0.219, hit_rate: 0.539, weight: 0.34 },
  { model_id: "tft-5m-v0.9.1", family: "tft", horizon: "5m", status: "shadow", trained_at: "2026-04-30", rank_ic: 0.044, brier: 0.227, hit_rate: 0.522, weight: 0.18 },
  { model_id: "nbeats-15m-v1.1", family: "nbeats", horizon: "15m", status: "active", trained_at: "2026-04-25", rank_ic: 0.058, brier: 0.221, hit_rate: 0.534, weight: 0.27 },
  { model_id: "lstm-60m-v0.7", family: "lstm", horizon: "60m", status: "active", trained_at: "2026-04-22", rank_ic: 0.051, brier: 0.224, hit_rate: 0.531, weight: 0.21 },
  { model_id: "linear-eod-v3", family: "linear", horizon: "eod", status: "active", trained_at: "2026-04-20", rank_ic: 0.039, brier: 0.232, hit_rate: 0.518, weight: 0.15 },
  { model_id: "tft-5m-v0.8.0", family: "tft", horizon: "5m", status: "retired", trained_at: "2026-03-15", rank_ic: 0.018, brier: 0.241, hit_rate: 0.508, weight: 0 },
];

export function rollingMetric(family: string, days = 30) {
  const base = { xgb: 0.062, tft: 0.044, nbeats: 0.058, lstm: 0.051, linear: 0.039, blender: 0.071 }[family] ?? 0.05;
  return seed(days, (i) => ({
    day: i,
    rank_ic: +(base + Math.sin(i / 4) * 0.015 + (Math.random() - 0.5) * 0.01).toFixed(4),
    brier: +(0.22 + Math.cos(i / 5) * 0.008 + (Math.random() - 0.5) * 0.005).toFixed(4),
  }));
}

export function calibrationCurve() {
  return seed(10, (i) => {
    const bin = (i + 0.5) / 10;
    return { bin: +bin.toFixed(2), observed: +Math.max(0, Math.min(1, bin + (Math.random() - 0.5) * 0.06)).toFixed(3) };
  });
}

export const COSTS = [
  { item: "Polygon Stocks Advanced", budget: 199, spent: 199, kind: "market data" },
  { item: "Benzinga Pro News", budget: 177, spent: 177, kind: "news" },
  { item: "Supabase Pro", budget: 25, spent: 25, kind: "infra" },
  { item: "Railway", budget: 40, spent: 31.2, kind: "infra" },
  { item: "Modal GPU", budget: 30, spent: 18.4, kind: "training" },
  { item: "Cloudflare R2", budget: 5, spent: 2.1, kind: "storage" },
  { item: "Anthropic (Claude)", budget: 50, spent: 38.7, kind: "llm" },
  { item: "Domain + SSL", budget: 2, spent: 2, kind: "infra" },
];

export function costSeries(days = 30) {
  return seed(days, (i) => ({
    day: i,
    polygon: 6.6,
    benzinga: 5.9,
    anthropic: +(1.0 + Math.random() * 0.6).toFixed(2),
    modal: +(0.4 + Math.random() * 0.8).toFixed(2),
    railway: +(1.0 + Math.random() * 0.2).toFixed(2),
  }));
}
