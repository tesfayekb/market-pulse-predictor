import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, ScatterChart, Scatter } from "recharts";
import { PageHeader, StatCard } from "@/components/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { rollingMetric, calibrationCurve, MODELS } from "@/lib/mock";

export const Route = createFileRoute("/performance")({
  head: () => ({ meta: [{ title: "Performance · MPS Admin" }] }),
  component: PerformancePage,
});

function PerformancePage() {
  const [family, setFamily] = useState("blender");
  const data = rollingMetric(family, 30);
  const calib = calibrationCurve();
  const ic30 = data[data.length - 1].rank_ic;
  const brier30 = data[data.length - 1].brier;

  const families = Array.from(new Set(MODELS.map((m) => m.family)));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="dashboard / performance"
        title="Model performance & calibration"
        description="Rolling rank-IC, Brier score, and calibration. The gate-check pane: ship live only when IC > 0.05 and calibration within ±5%."
        actions={
          <Select value={family} onValueChange={setFamily}>
            <SelectTrigger className="w-[140px] font-mono"><SelectValue /></SelectTrigger>
            <SelectContent>{families.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}</SelectContent>
          </Select>
        }
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="rank_ic_30d" value={ic30.toFixed(4)} tone={ic30 > 0.05 ? "success" : ic30 > 0 ? "warning" : "destructive"} hint="target > 0.05" />
        <StatCard label="brier_30d" value={brier30.toFixed(4)} tone={brier30 < 0.22 ? "success" : "warning"} hint="target < 0.22" />
        <StatCard label="hit_rate_30d" value={`${((MODELS.find((m) => m.family === family)?.hit_rate ?? 0.5) * 100).toFixed(1)}%`} hint="directional" />
        <StatCard label="calibration_gap" value="±3.8%" hint="max deviation from diagonal" tone="success" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold tracking-tight">Rolling rank-IC ({family})</h2>
          <div className="h-64">
            <ResponsiveContainer>
              <LineChart data={data}>
                <CartesianGrid strokeDasharray="2 4" stroke="oklch(0.3 0.02 250)" />
                <XAxis dataKey="day" stroke="oklch(0.68 0.02 245)" fontSize={11} />
                <YAxis stroke="oklch(0.68 0.02 245)" fontSize={11} />
                <Tooltip contentStyle={{ background: "oklch(0.22 0.02 250)", border: "1px solid oklch(0.3 0.02 250)", fontFamily: "monospace", fontSize: 12 }} />
                <ReferenceLine y={0.05} stroke="oklch(0.72 0.17 155)" strokeDasharray="4 4" label={{ value: "target", fill: "oklch(0.72 0.17 155)", fontSize: 10 }} />
                <ReferenceLine y={0} stroke="oklch(0.68 0.02 245)" />
                <Line type="monotone" dataKey="rank_ic" stroke="oklch(0.78 0.15 200)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold tracking-tight">Rolling Brier score</h2>
          <div className="h-64">
            <ResponsiveContainer>
              <LineChart data={data}>
                <CartesianGrid strokeDasharray="2 4" stroke="oklch(0.3 0.02 250)" />
                <XAxis dataKey="day" stroke="oklch(0.68 0.02 245)" fontSize={11} />
                <YAxis stroke="oklch(0.68 0.02 245)" fontSize={11} domain={[0.18, 0.26]} />
                <Tooltip contentStyle={{ background: "oklch(0.22 0.02 250)", border: "1px solid oklch(0.3 0.02 250)", fontFamily: "monospace", fontSize: 12 }} />
                <ReferenceLine y={0.22} stroke="oklch(0.78 0.16 75)" strokeDasharray="4 4" label={{ value: "target", fill: "oklch(0.78 0.16 75)", fontSize: 10 }} />
                <Line type="monotone" dataKey="brier" stroke="oklch(0.78 0.16 75)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold tracking-tight">Calibration curve — predicted vs observed</h2>
        <div className="h-72">
          <ResponsiveContainer>
            <ScatterChart>
              <CartesianGrid strokeDasharray="2 4" stroke="oklch(0.3 0.02 250)" />
              <XAxis type="number" dataKey="bin" domain={[0, 1]} stroke="oklch(0.68 0.02 245)" fontSize={11} name="predicted" />
              <YAxis type="number" dataKey="observed" domain={[0, 1]} stroke="oklch(0.68 0.02 245)" fontSize={11} name="observed" />
              <Tooltip contentStyle={{ background: "oklch(0.22 0.02 250)", border: "1px solid oklch(0.3 0.02 250)", fontFamily: "monospace", fontSize: 12 }} cursor={{ strokeDasharray: "3 3" }} />
              <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="oklch(0.68 0.02 245)" strokeDasharray="4 4" />
              <Scatter data={calib} fill="oklch(0.78 0.15 200)" />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 font-mono text-[11px] text-muted-foreground">
          Diagonal = perfect calibration. Points above diagonal = under-confident; below = over-confident.
        </p>
      </section>
    </div>
  );
}
