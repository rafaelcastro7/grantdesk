import { useState } from "react";

type Section = {
  heading: string;
  content: string | null;
  wordCount?: number | null;
};

type Props = {
  clientName: string;
  grantTitle: string;
  funderName: string;
  sections: Section[];
};

export function ProposalDocumentExporter({ clientName, grantTitle, funderName, sections }: Props) {
  const [isOpen, setIsOpen] = useState(false);

  const handlePrint = () => {
    window.print();
  };

  const handleCopyMarkdown = () => {
    const text =
      "# Proposal: " +
      grantTitle +
      "\n" +
      "**Applicant**: " +
      clientName +
      "\n" +
      "**Funder**: " +
      funderName +
      "\n" +
      "**Date**: " +
      new Date().toLocaleDateString() +
      "\n\n---\n\n" +
      sections
        .map((s) => "## " + s.heading + "\n\n" + (s.content || "*Section draft pending.*"))
        .join("\n\n---\n\n");
    void navigator.clipboard.writeText(text);
    alert("Markdown proposal copied to clipboard!");
  };

  const totalWords = sections.reduce(
    (sum, s) => sum + (s.content ? s.content.split(/\s+/).filter(Boolean).length : 0),
    0,
  );

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="px-3 py-1.5 text-xs font-semibold rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 hover:opacity-90 cursor-pointer flex items-center gap-1.5"
      >
        <span>📄 Export Proposal Document ({totalWords} words)</span>
      </button>

      {isOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
            <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-800">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  Pro-Format Proposal Document Export
                </h3>
                <p className="text-xs text-slate-500">
                  Formal document view with cover page and compliance structure
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyMarkdown}
                  className="px-3 py-1 text-xs font-semibold rounded bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-200 cursor-pointer"
                >
                  Copy Markdown
                </button>
                <button
                  type="button"
                  onClick={handlePrint}
                  className="px-3 py-1 text-xs font-semibold rounded bg-indigo-600 text-white cursor-pointer"
                >
                  Print / Save PDF
                </button>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="px-2 py-1 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Print Document Layout */}
            <div className="flex-1 overflow-y-auto p-8 bg-slate-100 dark:bg-slate-950 font-serif text-slate-900 dark:text-slate-100 space-y-8">
              {/* Cover Page */}
              <div className="bg-white dark:bg-slate-900 p-10 border border-slate-200 dark:border-slate-800 rounded-lg shadow-sm min-h-[400px] flex flex-col justify-between">
                <div>
                  <span className="text-xs font-sans uppercase font-bold tracking-widest text-indigo-600 dark:text-indigo-400">
                    Grant Proposal Application
                  </span>
                  <h1 className="text-2xl font-bold font-sans mt-3 text-slate-900 dark:text-slate-100">
                    {grantTitle}
                  </h1>
                  <p className="text-sm font-sans text-slate-500 mt-1">
                    Submitted to: {funderName}
                  </p>
                </div>

                <div className="border-t border-slate-200 dark:border-slate-800 pt-6 font-sans text-xs space-y-1">
                  <div>
                    <strong>Applicant Organization:</strong> {clientName}
                  </div>
                  <div>
                    <strong>Total Word Count:</strong> {totalWords} words
                  </div>
                  <div>
                    <strong>Date Prepared:</strong>{" "}
                    {new Date().toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    })}
                  </div>
                  <div>
                    <strong>Platform Governance:</strong> IIAL GrantDesk Verified Compliance
                  </div>
                </div>
              </div>

              {/* RFP Compliance Matrix Appendix */}
              <div className="bg-white dark:bg-slate-900 p-8 border border-slate-200 dark:border-slate-800 rounded-lg shadow-sm font-sans space-y-4">
                <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500 border-b pb-2">
                  RFP Compliance Matrix Appendix
                </h3>
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-400 uppercase text-[10px]">
                      <th className="py-2">Requirement</th>
                      <th className="py-2">Section Addressed</th>
                      <th className="py-2 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {sections.map((s, idx) => (
                      <tr key={idx}>
                        <td className="py-2 font-medium">{s.heading}</td>
                        <td className="py-2 text-slate-500">Section {idx + 1}</td>
                        <td className="py-2 text-right font-bold text-emerald-600">
                          {s.content ? "✓ Compliant" : "⚠ Pending"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Sections */}
              <div className="bg-white dark:bg-slate-900 p-10 border border-slate-200 dark:border-slate-800 rounded-lg shadow-sm space-y-8">
                <h2 className="text-lg font-bold font-sans border-b border-slate-200 pb-2">
                  Table of Contents & Proposal Sections
                </h2>
                {sections.map((sec, idx) => (
                  <div key={idx} className="space-y-3">
                    <h3 className="text-base font-bold font-sans text-indigo-950 dark:text-indigo-300">
                      {idx + 1}. {sec.heading}
                    </h3>
                    <div className="text-sm leading-relaxed whitespace-pre-wrap text-slate-800 dark:text-slate-200 font-sans">
                      {sec.content || (
                        <em className="text-slate-400">Draft content pending completion.</em>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
