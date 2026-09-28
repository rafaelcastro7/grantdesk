import { useState } from "react";

export type ProposalStage =
  "discovered" | "draft" | "in_review" | "approved" | "submitted" | "awarded" | "declined";

export type ProposalItem = {
  id: string;
  grantId: string;
  grantTitle: string;
  funderName: string;
  amountMax: number | null;
  currency: string | null;
  deadline: string | null;
  relevance: number | null;
  stage: ProposalStage;
};

const STAGES: Array<{ key: ProposalStage; label: string; color: string }> = [
  {
    key: "discovered",
    label: "Discovered",
    color: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  },
  {
    key: "draft",
    label: "Drafting",
    color: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  },
  {
    key: "in_review",
    label: "In Review",
    color: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  },
  {
    key: "approved",
    label: "Approved",
    color: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  },
  {
    key: "submitted",
    label: "Submitted",
    color: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  },
  {
    key: "awarded",
    label: "Awarded",
    color: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  },
  {
    key: "declined",
    label: "Declined",
    color: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  },
];

type Props = {
  proposals: ProposalItem[];
  onStageChange?: (proposalId: string, newStage: ProposalStage) => void;
};

export function ProposalPipelineBoard({ proposals: initialProposals, onStageChange }: Props) {
  const [items, setItems] = useState<ProposalItem[]>(initialProposals);

  const handleStageMove = (id: string, newStage: ProposalStage) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, stage: newStage } : item)));
    if (onStageChange) {
      onStageChange(id, newStage);
    }
  };

  const totalValue = items.reduce((sum, item) => sum + (item.amountMax || 0), 0);
  const weightedValue = items.reduce(
    (sum, item) => sum + (item.amountMax || 0) * (item.relevance || 0.5),
    0,
  );

  return (
    <div className="space-y-4 my-6">
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl bg-slate-900 text-white shadow-sm">
        <div>
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Pipeline Forecasting
          </h3>
          <p className="text-xl font-bold mt-0.5">
            ${totalValue.toLocaleString("en-US")} CAD{" "}
            <span className="text-xs text-slate-400 font-normal">(Total Cap)</span>
          </p>
        </div>
        <div className="text-right">
          <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">
            Weighted Expected Value ($ Expected)
          </span>
          <p className="text-xl font-bold text-emerald-300 mt-0.5">
            ${Math.round(weightedValue).toLocaleString("en-US")} CAD
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3 overflow-x-auto pb-2">
        {STAGES.map((stage) => {
          const stageItems = items.filter((item) => item.stage === stage.key);
          const stageTotal = stageItems.reduce((sum, item) => sum + (item.amountMax || 0), 0);

          return (
            <div
              key={stage.key}
              className="flex flex-col rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 p-2.5 min-w-[200px]"
            >
              <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-slate-800 mb-2">
                <span className={`px-2 py-0.5 text-xs font-semibold rounded-full ${stage.color}`}>
                  {stage.label}
                </span>
                <span className="text-xs font-bold text-slate-500">{stageItems.length}</span>
              </div>

              <div className="text-[11px] text-slate-500 font-medium px-1 mb-2">
                ${stageTotal.toLocaleString("en-US")}
              </div>

              <div className="flex-1 space-y-2 overflow-y-auto max-h-[400px]">
                {stageItems.length === 0 ? (
                  <div className="text-xs text-slate-400 italic text-center py-6 border border-dashed border-slate-200 dark:border-slate-800 rounded">
                    No proposals
                  </div>
                ) : (
                  stageItems.map((item) => (
                    <div
                      key={item.id}
                      className="p-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md shadow-xs space-y-2 hover:border-slate-400 transition-colors"
                    >
                      <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 line-clamp-2">
                        {item.grantTitle}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                        {item.funderName}
                      </div>
                      <div className="flex items-center justify-between text-[11px] font-medium pt-1 border-t border-slate-100 dark:border-slate-700">
                        <span className="text-slate-700 dark:text-slate-300">
                          {item.amountMax ? `$${item.amountMax.toLocaleString()}` : "N/A"}
                        </span>
                        {item.relevance !== null && (
                          <span className="text-indigo-600 dark:text-indigo-400 font-bold">
                            {Math.round(item.relevance * 100)}% fit
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1 pt-1 justify-end">
                        {stage.key !== "discovered" && (
                          <button
                            type="button"
                            onClick={() => {
                              const idx = STAGES.findIndex((s) => s.key === stage.key);
                              const prevStage = STAGES[idx - 1];
                              if (prevStage) handleStageMove(item.id, prevStage.key);
                            }}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300 cursor-pointer"
                            title="Move back"
                          >
                            ←
                          </button>
                        )}
                        {stage.key !== "declined" && stage.key !== "awarded" && (
                          <button
                            type="button"
                            onClick={() => {
                              const idx = STAGES.findIndex((s) => s.key === stage.key);
                              const nextStage = STAGES[idx + 1];
                              if (nextStage) handleStageMove(item.id, nextStage.key);
                            }}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-900/50 dark:text-indigo-300 cursor-pointer"
                            title="Move forward"
                          >
                            →
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
