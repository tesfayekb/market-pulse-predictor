import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader, StatCard } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, CheckCircle2, XCircle, Database } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({ meta: [{ title: "Feed Health · MPS Admin" }] }),
  component: FeedHealthPage,
});

const statusMeta = {
  green: { tone: "success", Icon: CheckCircle2, label: "OK" },
  yellow: { tone: "warning", Icon: AlertTriangle, label: "DEGRADED" },
  red: { tone: "destructive", Icon: XCircle, label: "DOWN" },
} as const;

type FeedRow = {
  source: string;
  kind: string;
  status: "green" | "yellow" | "red";
  staleness_seconds: number | null;
  latency_ms: number | null;
  error: string | null;
};

type DriftRow = {
  id: string;
  detected_at: string;
  kind: string;
  severity: "info" | "warn" | "critical";
  details: string | null;
  action: string | null;
};

function FeedHealthPage() {
  const { isAdmin } = useAuth();
  const [feeds, setFeeds] = useState<FeedRow[]>([]);
  const [drift, setDrift] = useState<DriftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);

  async function load() {
    setLoading(true);
    const [feedsRes, healthRes, driftRes] = await Promise.all([
      supabase.from("feeds").select("source, kind"),
      supabase
        .from("feed_health")
        .select("source, status, staleness_seconds, latency_ms, error, observed_at")
        .order("observed_at", { ascending: false }),
      supabase
        .from("drift_events")
        .select("id, detected_at, kind, severity, details, action")
        .is("resolved_at", null)
        .order("detected_at", { ascending: false })
        .limit(20),
    ]);

    if (feedsRes.error) toast.error(feedsRes.error.message);
    if (healthRes.error) toast.error(healthRes.error.message);
    if (driftRes.error) toast.error(driftRes.error.message);

    // latest health row per source
    const latest = new Map<string, FeedRow>();
    for (const h of healthRes.data ?? []) {
      if (latest.has(h.source)) continue;
      const f = (feedsRes.data ?? []).find((x) => x.source === h.source);
      latest.set(h.source, {
        source: h.source,
        kind: f?.kind ?? "—",
        status: h.status as FeedRow["status"],
        staleness_seconds: h.staleness_seconds,
        latency_ms: h.latency_ms,
        error: h.error,
      });
    }
    // include feeds with no health rows yet
    for (const f of feedsRes.data ?? []) {
      if (!latest.has(f.source)) {
        latest.set(f.source, { source: f.source, kind: f.kind, status: "yellow", staleness_seconds: null, latency_ms: null, error: "no observations" });
      }
    }

    setFeeds(Array.from(latest.values()));
    setDrift((driftRes.data ?? []) as DriftRow[]);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function seed() {
    setSeeding(true);
    const sources = [
      { source: "polygon_ws", kind: "market", expected_interval_seconds: 1 },
      { source: "polygon_rest", kind: "market", expected_interval_seconds: 60 },
      { source: "fred", kind: "macro", expected_interval_seconds: 86400 },
      { source: "sec_edgar", kind: "fundamentals", expected_interval_seconds: 3600 },
      { source: "news_rss", kind: "news", expected_interval_seconds: 300 },
    ];
    const { error: fErr } = await supabase.from("feeds").upsert(sources, { onConflict: "source" });
    if (fErr) {
      toast.error(fErr.message);
      setSeeding(false);
      return;
    }
    const now = Date.now();
    const health = sources.map((s, i) => ({
      source: s.source,
      status: i === 2 ? "yellow" : i === 4 ? "red" : "green",
      staleness_seconds: i === 2 ? 1800 : i === 4 ? 7200 : Math.floor(Math.random() * 5),
      latency_ms: 20 + Math.floor(Math.random() * 80),
      error: i === 4 ? "connection refused" : null,
      observed_at: new Date(now - i * 1000).toISOString(),
    }));
    const { error: hErr } = await supabase.from("feed_health").insert(health);
    if (hErr) toast.error(hErr.message);

    const { error: dErr } = await supabase.from("drift_events").insert([
      { kind: "psi_feature", severity: "warn", details: "feature=vix_term_structure psi=0.27 (>0.2)", action: "monitor" },
      { kind: "ic_decay", severity: "critical", details: "model=baseline_logreg_v1 IC dropped 0.04→0.01 over 7d", action: "retrain queued" },
    ]);
    if (dErr) toast.error(dErr.message);

    toast.success("Seeded test data");
    await load();
    setSeeding(false);
  }

  const counts = feeds.reduce(
    (acc, f) => ({ ...acc, [f.status]: (acc[f.status] ?? 0) + 1 }),
    {} as Record<string, number>,
  );
  const overall = feeds.length ? (((counts.green ?? 0) / feeds.length) * 100).toFixed(0) : "0";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="dashboard / feed_health"
        title="Feed health & drift"
        description="Real-time status of ingestion sources, latency, and drift events. Answers 'is the system actually working right now?'"
        actions={
          isAdmin ? (
            <Button size="sm" variant="outline" onClick={seed} disabled={seeding} className="gap-2">
              <Database className="h-3 w-3" />
              {seeding ? "seeding..." : "seed test data"}
            </Button>
          ) : null
        }
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="overall_health" value={`${overall}%`} hint={`${counts.green ?? 0}/${feeds.length} feeds green`} tone={Number(overall) > 90 ? "success" : "warning"} />
        <StatCard label="degraded" value={counts.yellow ?? 0} tone={(counts.yellow ?? 0) > 0 ? "warning" : "default"} />
        <StatCard label="down" value={counts.red ?? 0} tone={(counts.red ?? 0) > 0 ? "destructive" : "default"} />
        <StatCard label="open_drift_events" value={drift.length} hint="unresolved" />
      </div>

      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight">Ingest sources</h2>
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {loading ? "loading..." : `${feeds.length} sources`}
          </span>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Staleness (s)</TableHead>
              <TableHead className="text-right">Latency (ms)</TableHead>
              <TableHead>Note</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {feeds.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                  No feeds configured yet. {isAdmin && "Click 'seed test data' to populate."}
                </TableCell>
              </TableRow>
            )}
            {feeds.map((f) => {
              const meta = statusMeta[f.status];
              return (
                <TableRow key={f.source}>
                  <TableCell className="font-mono text-sm">{f.source}</TableCell>
                  <TableCell className="text-muted-foreground">{f.kind}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`gap-1 border-${meta.tone}/40 text-${meta.tone}`}>
                      <meta.Icon className="h-3 w-3" />
                      {meta.label}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{f.staleness_seconds ?? "—"}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{f.latency_ms ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{f.error ?? "—"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>

      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight">Drift events</h2>
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">PSI · KS · IC degradation</span>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Detected at</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Details</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {drift.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                  No open drift events.
                </TableCell>
              </TableRow>
            )}
            {drift.map((d) => (
              <TableRow key={d.id}>
                <TableCell className="font-mono text-xs">{new Date(d.detected_at).toISOString().slice(0, 19).replace("T", " ")}</TableCell>
                <TableCell className="font-mono text-xs">{d.kind}</TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={
                      d.severity === "critical"
                        ? "border-destructive/40 text-destructive"
                        : d.severity === "warn"
                          ? "border-warning/40 text-warning"
                          : "border-info/40 text-info"
                    }
                  >
                    {d.severity}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm">{d.details}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{d.action}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
