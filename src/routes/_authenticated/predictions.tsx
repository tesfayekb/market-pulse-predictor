import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid } from "recharts";
import { PageHeader, StatCard } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SYMBOLS, HORIZONS, type Horizon, predictionSeries, recentPredictions } from "@/lib/mock";

export const Route = createFileRoute("/predictions")({
  head: () => ({ meta: [{ title: "Predictions · MPS Admin" }] }),
  component: PredictionsPage,
});

function PredictionsPage() {
  const [symbol, setSymbol] = useState("SPY");
  const [horizon, setHorizon] = useState<Horizon>("15m");
  const series = useMemo(() => predictionSeries(symbol, horizon), [symbol, horizon]);
  const latest = useMemo(() => recentPredictions().slice(0, 24), []);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="dashboard / predictions"
        title="Predictions explorer"
        description="Multi-target × multi-horizon forecasts. Spot stuck-at-0.5 or stuck-at-0.99 failures fast."
        actions={
          <div className="flex gap-2">
            <Select value={symbol} onValueChange={setSymbol}>
              <SelectTrigger className="w-[110px] font-mono"><SelectValue /></SelectTrigger>
              <SelectContent>{SYMBOLS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={horizon} onValueChange={(v) => setHorizon(v as Horizon)}>
              <SelectTrigger className="w-[90px] font-mono"><SelectValue /></SelectTrigger>
              <SelectContent>{HORIZONS.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="last_emitted" value={`${Math.floor((Date.now() - series[series.length - 1].ts) / 1000)}s`} hint="ago" />
        <StatCard label="direction_prob" value={series[series.length - 1].direction_prob.toFixed(3)} tone={series[series.length - 1].direction_prob > 0.5 ? "success" : "destructive"} />
        <StatCard label="rolling_mean" value={(series.reduce((a, b) => a + b.direction_prob, 0) / series.length).toFixed(3)} hint="last 96 emits" />
        <StatCard label="emit_cadence" value="60s" hint="per spec" />
      </div>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight">{symbol} · {horizon} · direction probability</h2>
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">P(close ↑)</span>
        </div>
        <div className="h-72 w-full">
          <ResponsiveContainer>
            <LineChart data={series}>
              <CartesianGrid strokeDasharray="2 4" stroke="oklch(0.3 0.02 250)" />
              <XAxis dataKey="ts" tickFormatter={(t) => new Date(t).toLocaleTimeString().slice(0, 5)} stroke="oklch(0.68 0.02 245)" fontSize={11} />
              <YAxis domain={[0, 1]} stroke="oklch(0.68 0.02 245)" fontSize={11} />
              <Tooltip
                contentStyle={{ background: "oklch(0.22 0.02 250)", border: "1px solid oklch(0.3 0.02 250)", fontFamily: "monospace", fontSize: 12 }}
                labelFormatter={(t) => new Date(t as number).toISOString().slice(11, 19)}
              />
              <ReferenceLine y={0.5} stroke="oklch(0.68 0.02 245)" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="direction_prob" stroke="oklch(0.78 0.15 200)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight">Latest emissions (all symbols × horizons)</h2>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Emitted</TableHead>
              <TableHead>Symbol</TableHead>
              <TableHead>Horizon</TableHead>
              <TableHead className="text-right">P(↑)</TableHead>
              <TableHead className="text-right">E[r]</TableHead>
              <TableHead className="text-right">σ</TableHead>
              <TableHead>Regime</TableHead>
              <TableHead className="text-right">Health</TableHead>
              <TableHead>Mode</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {latest.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-mono text-xs text-muted-foreground">{p.emitted_at.slice(11, 19)}</TableCell>
                <TableCell className="font-mono">{p.symbol}</TableCell>
                <TableCell className="font-mono text-xs">{p.horizon}</TableCell>
                <TableCell className={`text-right font-mono tabular-nums ${p.direction_prob > 0.55 ? "text-success" : p.direction_prob < 0.45 ? "text-destructive" : ""}`}>{p.direction_prob.toFixed(3)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{(p.expected_return * 10000).toFixed(1)}bp</TableCell>
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{(p.return_std * 100).toFixed(2)}%</TableCell>
                <TableCell className="font-mono text-xs">{p.regime}</TableCell>
                <TableCell className={`text-right font-mono tabular-nums ${p.feed_health < 0.8 ? "text-warning" : ""}`}>{p.feed_health.toFixed(2)}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={p.shadow_mode ? "border-warning/40 text-warning" : "border-success/40 text-success"}>
                    {p.shadow_mode ? "shadow" : "live"}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
