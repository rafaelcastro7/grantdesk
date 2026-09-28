import { useState } from "react";

type Stage = "draft" | "in_review" | "approved" | "submitted";

type Props = {
  currentStage: Stage;
  wordCount: number;
  wordLimit?: number | null;
  unacknowledgedCount: number;
  onStageChange: (newStage: Stage) => void;
};

export function ProposalApprovalWorkflow({
  currentStage: initialStage,
  wordCount,
  wordLimit,
  unacknowledgedCount,
  onStageChange,
}: Props) {
  const [stage, setStage] = useState<Stage>(initialStage);

  const stages: Array<{ key: Stage; label: string; number: number }> = [
    { key: "draft", label: "Drafting", number: 1 },
    { key: "in_review", label: "In Review", number: 2 },
    { key: "approved", label: "Approved", number: 3 },
    { key: "submitted", label: "Submitted", number: 4 },
  ];

  const currentIdx = stages.findIndex((s) => s.key === stage);

  const handleAdvance = (next: Stage) => {
    setStage(next);
    onStageChange(next);
  };

  const wordCountValid = !wordLimit || wordCount <= wordLimit;
  const isReadyForApproval = wordCountValid && unacknowledgedCount === 0;

  return (
    <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-4 shadow-xs">
      <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            SmartRoute Approval & Quality Gate
          </h4>
          <p className="text-xs text-slate-500">Multi-stage sign-off and compliance checks</p>
        </div>
        <span className="px-2.5 py-1 text-xs font-bold rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-800 uppercase tracking-wider">
          Stage: {stage.replace("_", " ")}
        </span>
      </div>

      {/* Progress Bar */}
      <div className="grid grid-cols-4 gap-2">
        {stages.map((s, idx) => {
          const isActive = idx === currentIdx;
          const isDone = idx < currentIdx;

          return (
            <div
              key={s.key}
              className={`p-2 rounded-lg text-center border text-xs transition-colors ${
                isActive
                  ? "bg-indigo-600 text-white font-bold border-indigo-600"
                  : isDone
                    ? "bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800"
                    : "bg-slate-50 text-slate-400 border-slate-200 dark:bg-slate-800 dark:text-slate-500 dark:border-slate-700"
              }`}
            >
              <div className="text-[10px] uppercase font-semibold opacity-80">Step {s.number}</div>
              <div>{s.label}</div>
            </div>
          );
        })}
      </div>

      {/* Quality Gate Checklist */}
      <div className="p-3 rounded-lg border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 space-y-2 text-xs">
        <h5 className="font-semibold text-slate-700 dark:text-slate-300 uppercase text-[10px] tracking-wider">
          Quality Gate Check
        </h5>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="flex items-center gap-2">
            <span
              className={wordCountValid ? "text-emerald-600 font-bold" : "text-rose-600 font-bold"}
            >
              {wordCountValid ? "✓" : "✕"}
            </span>
            <span>
              Word Count: {wordCount} {wordLimit ? `/ ${wordLimit}` : ""}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={
                unacknowledgedCount === 0
                  ? "text-emerald-600 font-bold"
                  : "text-amber-600 font-bold"
              }
            >
              {unacknowledgedCount === 0 ? "✓" : "⚠"}
            </span>
            <span>
              Requirements:{" "}
              {unacknowledgedCount === 0 ? "All acknowledged" : `${unacknowledgedCount} pending`}
            </span>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-2">
        {stage === "draft" && (
          <button
            type="button"
            onClick={() => handleAdvance("in_review")}
            className="px-3 py-1.5 text-xs font-semibold rounded-md bg-indigo-600 text-white hover:bg-indigo-700 cursor-pointer"
          >
            Submit for Review →
          </button>
        )}
        {stage === "in_review" && (
          <button
            type="button"
            disabled={!isReadyForApproval}
            onClick={() => handleAdvance("approved")}
            className="px-3 py-1.5 text-xs font-semibold rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 cursor-pointer"
          >
            Approve Proposal ✓
          </button>
        )}
        {stage === "approved" && (
          <button
            type="button"
            onClick={() => handleAdvance("submitted")}
            className="px-3 py-1.5 text-xs font-semibold rounded-md bg-purple-600 text-white hover:bg-purple-700 cursor-pointer"
          >
            Mark Submitted 🚀
          </button>
        )}
      </div>
    </div>
  );
}
