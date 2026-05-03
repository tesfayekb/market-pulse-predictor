import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, StatCard } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MODELS } from "@/lib/mock";

export const Route = createFileRoute("/models")({
  head: () => ({ meta: [{ title: "Models · MPS Admin" }] }),
  component: ModelsPage,
});

function ModelsPage() {
  const active = MODELS.filter((m) => m.status === "active");
  const shadow = MODELS.filter((m) => m.status === "shadow");
  const retired = MODELS.filter((m) => m.status === "retired");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="dashboard / models"
        title="Model registry & ensemble weights"
        description="Specialist models, regime-aware blender weights, and lifecycle status."
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="active" value={active.length} tone="success" />
        <StatCard label="shadow" value={shadow.length} tone="warning" />
        <StatCard label="retired" value={retired.length} />
        <StatCard label="best_ic" value={Math.max(...MODELS.map((m) => m.rank_ic)).toFixed(4)} tone="success" hint="ensemble-v1.2.3" />
      </div>

      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight">All models</h2>
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">regime: trending_low_vol</span>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>model_id</TableHead>
              <TableHead>family</TableHead>
              <TableHead>horizon</TableHead>
              <TableHead>status</TableHead>
              <TableHead className="text-right">rank_ic</TableHead>
              <TableHead className="text-right">brier</TableHead>
              <TableHead className="text-right">hit_rate</TableHead>
              <TableHead className="text-right">weight</TableHead>
              <TableHead>trained_at</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {MODELS.map((m) => (
              <TableRow key={m.model_id}>
                <TableCell className="font-mono text-xs">{m.model_id}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{m.family}</TableCell>
                <TableCell className="font-mono text-xs">{m.horizon}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={
                    m.status === "active" ? "border-success/40 text-success"
                      : m.status === "shadow" ? "border-warning/40 text-warning"
                        : "border-muted-foreground/40 text-muted-foreground"
                  }>{m.status}</Badge>
                </TableCell>
                <TableCell className={`text-right font-mono tabular-nums ${m.rank_ic > 0.05 ? "text-success" : "text-warning"}`}>{m.rank_ic.toFixed(4)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{m.brier.toFixed(3)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{(m.hit_rate * 100).toFixed(1)}%</TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                      <div className="h-full bg-primary" style={{ width: `${m.weight * 100}%` }} />
                    </div>
                    <span className="w-10 font-mono text-xs tabular-nums">{m.weight.toFixed(2)}</span>
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{m.trained_at}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
