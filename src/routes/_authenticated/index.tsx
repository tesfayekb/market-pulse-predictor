import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, StatCard } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FEEDS, DRIFT_EVENTS } from "@/lib/mock";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({
    meta: [{ title: "Feed Health · MPS Admin" }, { name: "description", content: "Live status of ingest feeds and drift events." }],
  }),
  component: FeedHealthPage,
});

const statusMeta = {
  green: { tone: "success", Icon: CheckCircle2, label: "OK" },
  yellow: { tone: "warning", Icon: AlertTriangle, label: "DEGRADED" },
  red: { tone: "destructive", Icon: XCircle, label: "DOWN" },
} as const;

function FeedHealthPage() {
  const counts = FEEDS.reduce(
    (acc, f) => ({ ...acc, [f.status]: (acc[f.status] ?? 0) + 1 }),
    {} as Record<string, number>,
  );
  const overall = (((counts.green ?? 0) / FEEDS.length) * 100).toFixed(0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="dashboard / feed_health"
        title="Feed health & drift"
        description="Real-time status of ingestion sources, latency, and drift events. This is the operational pane — answers 'is the system actually working right now?'"
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="overall_health" value={`${overall}%`} hint={`${counts.green ?? 0}/${FEEDS.length} feeds green`} tone={Number(overall) > 90 ? "success" : "warning"} />
        <StatCard label="degraded" value={counts.yellow ?? 0} tone={(counts.yellow ?? 0) > 0 ? "warning" : "default"} />
        <StatCard label="down" value={counts.red ?? 0} tone={(counts.red ?? 0) > 0 ? "destructive" : "default"} />
        <StatCard label="open_drift_events" value={DRIFT_EVENTS.length} hint="last 24h" />
      </div>

      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight">Ingest sources</h2>
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            polled 1s ago
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
            {FEEDS.map((f) => {
              const meta = statusMeta[f.status as keyof typeof statusMeta];
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
                  <TableCell className="text-right font-mono tabular-nums">{f.staleness}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{f.latency}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{("error" in f ? f.error : "—") as string}</TableCell>
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
            {DRIFT_EVENTS.map((d) => (
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
