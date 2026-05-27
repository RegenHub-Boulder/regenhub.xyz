import { Card, CardContent } from "@/components/ui/card";
import { TrendingDown } from "lucide-react";

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  hint?: string;
}

interface Props {
  stages: FunnelStage[];
}

/**
 * Visual funnel — interests → free days → applications → members.
 * Width of each bar proportional to the first stage; conversion %
 * shown between stages so it's obvious where the funnel leaks.
 */
export function FunnelCard({ stages }: Props) {
  const top = stages[0]?.count ?? 0;

  return (
    <Card className="glass-panel">
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <TrendingDown className="w-4 h-4 text-sage" />
          <h3 className="text-sm font-semibold">Funnel</h3>
          <span className="text-xs text-muted">all-time</span>
        </div>

        <div className="space-y-2">
          {stages.map((s, i) => {
            const widthPct = top > 0 ? Math.max(6, Math.round((s.count / top) * 100)) : 0;
            const prev = i > 0 ? stages[i - 1].count : null;
            const conversionPct =
              prev != null && prev > 0 ? Math.round((s.count / prev) * 100) : null;

            return (
              <div key={s.key}>
                {/* Conversion arrow above (skip on first stage) */}
                {conversionPct != null && (
                  <div className="flex items-center justify-end gap-1 pr-3 -mb-0.5">
                    <span className={`text-xs ${conversionPct < 30 ? "text-amber-400" : "text-muted"}`}>
                      ↓ {conversionPct}%
                    </span>
                  </div>
                )}

                <div className="flex items-center gap-3">
                  <div className="flex-1 relative h-9">
                    <div
                      className="h-full rounded bg-sage/20 border border-sage/30 transition-all"
                      style={{ width: `${widthPct}%` }}
                    />
                    <div className="absolute inset-0 flex items-center px-3">
                      <span className="text-sm font-medium">{s.label}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0 w-20">
                    <p className="text-lg font-bold tabular-nums">{s.count.toLocaleString()}</p>
                    {s.hint && <p className="text-xs text-muted">{s.hint}</p>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
