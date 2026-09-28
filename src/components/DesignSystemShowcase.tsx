export function DesignSystemShowcase() {
  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8 my-6">
      <div className="border-b border-slate-200 dark:border-slate-800 pb-4">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
          GrantDesk Design System & Tokens
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Standardized UI primitives, eligibility color tokens, and accessibility guidelines
        </p>
      </div>

      {/* Color Tokens */}
      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">
          1. Verdict & Status Color Tokens
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200 dark:border-emerald-800 space-y-1">
            <div className="font-bold text-sm">✓ Eligible / Can Apply</div>
            <div className="text-xs font-mono">--color-eligible (#059669)</div>
          </div>
          <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200 dark:border-amber-800 space-y-1">
            <div className="font-bold text-sm">⚠ Needs Input</div>
            <div className="text-xs font-mono">--color-needs-input (#d97706)</div>
          </div>
          <div className="p-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 dark:bg-rose-950/60 dark:text-rose-200 dark:border-rose-800 space-y-1">
            <div className="font-bold text-sm">✕ Ineligible / Ruled Out</div>
            <div className="text-xs font-mono">--color-ineligible (#dc2626)</div>
          </div>
        </div>
      </section>

      {/* Badges */}
      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">
          2. Badges & Labels
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <span className="px-2.5 py-1 text-xs font-bold rounded-full bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            Default Badge
          </span>
          <span className="px-2.5 py-1 text-xs font-bold rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            Quick Win
          </span>
          <span className="px-2.5 py-1 text-xs font-bold rounded-full bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200">
            High Value
          </span>
          <span className="px-2.5 py-1 text-xs font-bold rounded-full bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200">
            Tenant: IIAL
          </span>
        </div>
      </section>

      {/* Buttons */}
      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">
          3. Button Hierarchy
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="px-4 py-2 text-xs font-semibold rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
          >
            Primary Action
          </button>
          <button
            type="button"
            className="px-4 py-2 text-xs font-semibold rounded-md bg-indigo-600 text-white"
          >
            Accent Action
          </button>
          <button
            type="button"
            className="px-4 py-2 text-xs font-semibold rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800"
          >
            Secondary Action
          </button>
        </div>
      </section>
    </div>
  );
}
