import { useState } from "react";
import { calculateGrantRoi, type PrioritizationInput, type PrioritizationQuadrant } from "@/lib/prioritization";

type Props = {
  grants: PrioritizationInput[];
  onSelectGrant?: (id: string) => void;
};

export function GrantPrioritizationMatrix({ grants, onSelectGrant }: Props) {
  const [filter, setFilter] = useState<"all" | PrioritizationQuadrant>("all");
  const [search, setSearch] = useState("");

  const evaluated = grants.map(calculateGrantRoi);
  const sorted = [...evaluated].sort((a, b) => b.roiScore - a.roiScore);

  const filtered = sorted.filter((g) => {
    const matchesFilter = filter === "all" || g.quadrant === filter;
    const matchesSearch =
      !search.trim() ||
      g.title.toLowerCase().includes(search.toLowerCase()) ||
      g.funderName.toLowerCase().includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const handleExportCsv = () => {
    const headers = ["ID", "Title", "Funder", "Max Amount", "Expected Value", "Est Hours", "ROI Score ($/hr)", "Quadrant"];
    const rows = filtered.map((g) => [
      g.id,
      `"${g.title.replace(/"/g, '""')}"`,
      `"${g.funderName.replace(/"/g, '""')}"`,
      g.amountMax || 0,
      Math.round(g.expectedValue),
      g.estimatedHours,
      g.roiScore,
      g.quadrant,
    ]);
    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "grantdesk_prioritization_matrix.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

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
          <input
            type="text"
            placeholder="Search grants..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="p-1.5 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
          />
          <button
            type="button"
            onClick={handleExportCsv}
            className="px-2.5 py-1 text-xs font-semibold rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 cursor-pointer"
          >
            📥 CSV
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
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
