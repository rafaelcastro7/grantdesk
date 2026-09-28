import type { Axis } from "@/lib/axis-breakdown";

type Props = {
  relevance: number | null;
  verdict: "eligible" | "needs_input" | "ineligible";
  axes: Axis[];
};

export function ExplainableFitScorecard({ relevance, verdict, axes }: Props) {
  const verdictBadges = {
    eligible: {
      label: "Can Apply",
      color:
        "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800",
    },
    needs_input: {
      label: "Needs Input",
      color:
        "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800",
    },
    ineligible: {
      label: "Ruled Out",
      color:
        "bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950 dark:text-rose-200 dark:border-rose-800",
    },
  };

  const statusIcons = {
    pass: "✓ Pass",
    partial: "⚠ Partial",
    fail: "✕ Fail",
    unknown: "? Unknown",
  };

  const statusStyles = {
    pass: "text-emerald-700 bg-emerald-50 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800",
    partial:
      "text-amber-700 bg-amber-50 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800",
    fail: "text-rose-700 bg-rose-50 border-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-800",
    unknown:
      "text-slate-600 bg-slate-50 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
  };

  return (
    <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs space-y-4">
      <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Explainable Fit Scorecard
          </h4>
          <p className="text-xs text-slate-500">Multidimensional eligibility & health breakdown</p>
        </div>
        <div className="flex items-center gap-3">
          {relevance !== null && (
            <div className="text-right">
              <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider block">
                Relevance
              </span>
              <span className="text-lg font-extrabold text-indigo-600 dark:text-indigo-400">
                {Math.round(relevance * 100)}%
              </span>
            </div>
          )}
          <span
            className={`px-2.5 py-1 text-xs font-bold border rounded-full ${verdictBadges[verdict].color}`}
          >
            {verdictBadges[verdict].label}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {axes.map((axis) => (
          <div
            key={axis.key}
            className={`p-3 rounded-lg border text-xs space-y-2 ${statusStyles[axis.status]}`}
          >
            <div className="flex items-center justify-between font-semibold">
              <span>{axis.label}</span>
              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border bg-white/50 dark:bg-slate-900/50">
                {statusIcons[axis.status]}
              </span>
            </div>

            {axis.decisive && (
              <div className="text-[10px] font-bold text-rose-600 dark:text-rose-400 uppercase tracking-wider">
                ▲ Decisive Gate
              </div>
            )}

            <ul className="space-y-1 text-[11px] list-disc list-inside opacity-90">
              {axis.reasons.map((reason, idx) => (
                <li key={idx} className="line-clamp-2">
                  {reason}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
