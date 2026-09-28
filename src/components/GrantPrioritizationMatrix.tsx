import { useState } from "react";

export type PrioritizedGrant = {
  id: string;
  title: string;
  funderName: string;
  amountMax: number | null;
  relevance: number | null;
  requirementCount: number;
  deadline: string | null;
};

type Props = {
  grants: PrioritizedGrant[];
  onSelectGrant?: (id: string) => void;
};

export function GrantPrioritizationMatrix({ grants, onSelectGrant }: Props) {
  const [filter, setFilter] = useState<"all" | "quick_wins" | "high_value" | "low_priority">("all");

  const evaluated = grants.map((g) => {
    const amount = g.amountMax || 50000;
    const rel = g.relevance || 0.5;
    const expectedValue = amount * rel;
    const estimatedHours = Math.max(8, g.requirementCount * 6);
    const roiScore = Math.round(expectedValue / estimatedHours);

    let quadrant: "quick_wins" | "high_value" | "filler" | "low_priority" = "filler";
    if (roiScore > 2000 && estimatedHours <= 20) quadrant = "quick_wins";
    else if (roiScore > 2000 && estimatedHours > 20) quadrant = "high_value";
    else if (roiScore <= 2000 && estimatedHours > 20) quadrant = "low_priority";

    return { ...g, expectedValue, estimatedHours, roiScore, quadrant };
  });

  const sorted = [...evaluated].sort((a, b) => b.roiScore - a.roiScore);
  const filtered = filter === "all" ? sorted : sorted.filter((g) => g.quadrant === filter);

  const quickWinsCount = evaluated.filter((g) => g.quadrant === "quick_wins").length;
  const highValueCount = evaluated.filter((g) => g.quadrant === "high_value").length;

  return (
    <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-4 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Grant Prioritization Matrix (ROI & Effort)
          </h4>
          <p className="text-xs text-slate-500">
            Rank calls by Expected Return vs. Writing Effort (Hours required)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={`px-2.5 py-1 text-xs font-semibold rounded-md border cursor-pointer ${
              filter === "all"
                ? "bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900"
                : "bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700"
            }`}
          >
            All ({grants.length})
          </button>
          <button
            type="button"
            onClick={() => setFilter("quick_wins")}
            className={`px-2.5 py-1 text-xs font-semibold rounded-md border cursor-pointer ${
              filter === "quick_wins"
                ? "bg-emerald-600 text-white border-emerald-600"
                : "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800"
            }`}
          >
            ⚡ Quick Wins ({quickWinsCount})
          </button>
          <button
            type="button"
            onClick={() => setFilter("high_value")}
            className={`px-2.5 py-1 text-xs font-semibold rounded-md border cursor-pointer ${
              filter === "high_value"
                ? "bg-indigo-600 text-white border-indigo-600"
                : "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-800"
            }`}
          >
            🎯 High Value ({highValueCount})
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase text-[10px]">
              <th className="py-2">Grant Opportunity</th>
              <th className="py-2">Funder</th>
              <th className="py-2 text-right">Max Cap</th>
              <th className="py-2 text-right">Est. Effort</th>
              <th className="py-2 text-right">Expected ROI</th>
              <th className="py-2 text-center">Priority</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {filtered.map((g) => (
              <tr
                key={g.id}
                onClick={() => onSelectGrant && onSelectGrant(g.id)}
                className="hover:bg-slate-50/80 dark:hover:bg-slate-800/50 cursor-pointer transition-colors"
              >
                <td className="py-2.5 font-semibold text-slate-900 dark:text-slate-100 max-w-[240px] truncate">
                  {g.title}
                </td>
                <td className="py-2.5 text-slate-500 max-w-[150px] truncate">{g.funderName}</td>
                <td className="py-2.5 text-right font-medium text-slate-700 dark:text-slate-300">
                  {g.amountMax ? `$${g.amountMax.toLocaleString()}` : "N/A"}
                </td>
                <td className="py-2.5 text-right text-slate-500 font-mono">
                  ~{g.estimatedHours} hrs
                </td>
                <td className="py-2.5 text-right font-bold text-emerald-600 dark:text-emerald-400 font-mono">
                  ${g.roiScore.toLocaleString()}/hr
                </td>
                <td className="py-2.5 text-center">
                  <span
                    className={`px-2 py-0.5 text-[10px] font-bold rounded-full uppercase tracking-wider ${
                      g.quadrant === "quick_wins"
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                        : g.quadrant === "high_value"
                          ? "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200"
                          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                    }`}
                  >
                    {g.quadrant.replace("_", " ")}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
