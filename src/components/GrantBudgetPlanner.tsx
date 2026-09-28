import { useState } from "react";

export type BudgetItem = {
  id: string;
  category: "Personnel" | "Equipment" | "Travel" | "Subcontracts" | "Indirect";
  description: string;
  plannedAmount: number;
  actualAmount?: number;
};

type Props = {
  grantMaxAmount?: number | null;
  items?: BudgetItem[];
  onSave?: (items: BudgetItem[]) => void;
};

const DEFAULT_ITEMS: BudgetItem[] = [
  {
    id: "1",
    category: "Personnel",
    description: "Lead Researcher & Project Coordinator",
    plannedAmount: 45000,
    actualAmount: 42000,
  },
  {
    id: "2",
    category: "Equipment",
    description: "Lab & Testing Hardware",
    plannedAmount: 15000,
    actualAmount: 15500,
  },
  {
    id: "3",
    category: "Travel",
    description: "Field Site Visits & Conference Dissemination",
    plannedAmount: 5000,
    actualAmount: 4800,
  },
  {
    id: "4",
    category: "Indirect",
    description: "Institutional Administrative Overhead (10%)",
    plannedAmount: 6500,
    actualAmount: 6500,
  },
];

export function GrantBudgetPlanner({
  grantMaxAmount,
  items: initialItems = DEFAULT_ITEMS,
  onSave,
}: Props) {
  const [items, setItems] = useState<BudgetItem[]>(initialItems);
  const [category, setCategory] = useState<BudgetItem["category"]>("Personnel");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");

  const addItem = () => {
    if (!description.trim() || !amount) return;
    const newItem: BudgetItem = {
      id: Math.random().toString(),
      category,
      description: description.trim(),
      plannedAmount: parseFloat(amount) || 0,
      actualAmount: 0,
    };
    const updated = [...items, newItem];
    setItems(updated);
    setDescription("");
    setAmount("");
    if (onSave) onSave(updated);
  };

  const totalPlanned = items.reduce((sum, i) => sum + i.plannedAmount, 0);
  const totalActual = items.reduce((sum, i) => sum + (i.actualAmount || 0), 0);
  console.log("Total actual spending:", totalActual);
  // net variance

  return (
    <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-4 shadow-xs">
      <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Budget Pulse & Post-Award Variance Tracker
          </h4>
          <p className="text-xs text-slate-500">
            Category breakdown and budget vs. actual spending
          </p>
        </div>
        <div className="text-right">
          <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider block">
            Total Planned
          </span>
          <span className="text-base font-bold text-slate-900 dark:text-slate-100">
            ${totalPlanned.toLocaleString("en-US")} CAD
          </span>
        </div>
      </div>

      {grantMaxAmount && (
        <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800 text-xs flex items-center justify-between border border-slate-200 dark:border-slate-700">
          <span>
            Grant Maximum Cap: <strong>${grantMaxAmount.toLocaleString("en-US")} CAD</strong>
          </span>
          <span
            className={
              totalPlanned <= grantMaxAmount
                ? "text-emerald-600 font-bold"
                : "text-rose-600 font-bold"
            }
          >
            {totalPlanned <= grantMaxAmount ? "✓ Within Cap" : "⚠ Exceeds Cap"}
          </span>
        </div>
      )}

      {/* Add Item Form */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 pt-1">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as BudgetItem["category"])}
          className="p-1.5 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
        >
          <option value="Personnel">Personnel</option>
          <option value="Equipment">Equipment</option>
          <option value="Travel">Travel</option>
          <option value="Subcontracts">Subcontracts</option>
          <option value="Indirect">Indirect</option>
        </select>
        <input
          type="text"
          placeholder="Item Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="p-1.5 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 sm:col-span-2"
        />
        <div className="flex gap-2">
          <input
            type="number"
            placeholder="Planned $"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="p-1.5 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 w-full"
          />
          <button
            type="button"
            onClick={addItem}
            className="px-3 py-1.5 text-xs font-semibold rounded bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 cursor-pointer"
          >
            Add
          </button>
        </div>
      </div>

      {/* Budget Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase text-[10px]">
              <th className="py-2">Category</th>
              <th className="py-2">Description</th>
              <th className="py-2 text-right">Planned $</th>
              <th className="py-2 text-right">Actual $</th>
              <th className="py-2 text-right">Variance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((item) => {
              const itemVar = item.plannedAmount - (item.actualAmount || 0);
              return (
                <tr key={item.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
                  <td className="py-2 font-semibold text-slate-700 dark:text-slate-300">
                    {item.category}
                  </td>
                  <td className="py-2 text-slate-600 dark:text-slate-400">{item.description}</td>
                  <td className="py-2 text-right font-medium">
                    ${item.plannedAmount.toLocaleString()}
                  </td>
                  <td className="py-2 text-right text-slate-500">
                    ${(item.actualAmount || 0).toLocaleString()}
                  </td>
                  <td
                    className={`py-2 text-right font-bold ${itemVar >= 0 ? "text-emerald-600" : "text-rose-600"}`}
                  >
                    ${itemVar.toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
