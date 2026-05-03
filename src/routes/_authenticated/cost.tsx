import { createFileRoute } from "@tanstack/react-router";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import { PageHeader, StatCard } from "@/components/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { COSTS, costSeries } from "@/lib/mock";

export const Route = createFileRoute("/_authenticated/cost")({
  head: () => ({ meta: [{ title: "Cost · MPS Admin" }] }),
  component: CostPage,
});

const CEILING = 500;

function CostPage() {
  const totalSpent = COSTS.reduce((a, b) => a + b.spent, 0);
  const totalBudget = COSTS.reduce((a, b) => a + b.budget, 0);
  const series = costSeries(30);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="dashboard / cost"
        title="Cost & API usage"
        description="Tracks Polygon, Anthropic, Modal, Supabase, R2 spend against the $500/mo ceiling. Cheap to build, expensive to skip."
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="spent_mtd" value={`$${totalSpent.toFixed(0)}`} tone={totalSpent < CEILING * 0.9 ? "success" : "warning"} hint={`ceiling $${CEILING}`} />
        <StatCard label="budget_mtd" value={`$${totalBudget.toFixed(0)}`} hint="planned" />
        <StatCard label="run_rate" value={`$${(totalSpent * 1.05).toFixed(0)}`} hint="projected eom" tone={totalSpent * 1.05 < CEILING ? "success" : "destructive"} />
        <StatCard label="utilization" value={`${((totalSpent / CEILING) * 100).toFixed(0)}%`} tone={totalSpent / CEILING < 0.9 ? "success" : "warning"} />
      </div>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold tracking-tight">Daily cost breakdown (last 30 days)</h2>
        <div className="h-72">
          <ResponsiveContainer>
            <BarChart data={series}>
              <CartesianGrid strokeDasharray="2 4" stroke="oklch(0.3 0.02 250)" />
              <XAxis dataKey="day" stroke="oklch(0.68 0.02 245)" fontSize={11} />
              <YAxis stroke="oklch(0.68 0.02 245)" fontSize={11} />
              <Tooltip contentStyle={{ background: "oklch(0.22 0.02 250)", border: "1px solid oklch(0.3 0.02 250)", fontFamily: "monospace", fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: "monospace" }} />
              <Bar dataKey="polygon" stackId="a" fill="oklch(0.78 0.15 200)" />
              <Bar dataKey="benzinga" stackId="a" fill="oklch(0.78 0.16 75)" />
              <Bar dataKey="anthropic" stackId="a" fill="oklch(0.68 0.2 320)" />
              <Bar dataKey="modal" stackId="a" fill="oklch(0.72 0.17 155)" />
              <Bar dataKey="railway" stackId="a" fill="oklch(0.7 0.14 30)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight">Line items</h2>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="text-right">Spent</TableHead>
              <TableHead className="text-right">Budget</TableHead>
              <TableHead>Utilization</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {COSTS.map((c) => {
              const pct = (c.spent / c.budget) * 100;
              return (
                <TableRow key={c.item}>
                  <TableCell>{c.item}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{c.kind}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">${c.spent.toFixed(2)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums text-muted-foreground">${c.budget.toFixed(2)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
                        <div className={`h-full ${pct >= 100 ? "bg-warning" : "bg-primary"}`} style={{ width: `${Math.min(100, pct)}%` }} />
                      </div>
                      <span className="w-12 font-mono text-xs tabular-nums">{pct.toFixed(0)}%</span>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
