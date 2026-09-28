export type BudgetItemInput = {
  id: string;
  category: "Personnel" | "Equipment" | "Travel" | "Subcontracts" | "Indirect";
  description: string;
  plannedAmount: number;
  actualAmount?: number;
};

export type BudgetSummary = {
  totalPlanned: number;
  totalActual: number;
  netVariance: number;
  withinCap: boolean;
  categoryTotals: Record<string, number>;
};

export function calculateBudgetSummary(
  items: BudgetItemInput[],
  grantMaxAmount?: number | null,
): BudgetSummary {
  let totalPlanned = 0;
  let totalActual = 0;
  const categoryTotals: Record<string, number> = {};

  for (const item of items) {
    totalPlanned += item.plannedAmount;
    totalActual += item.actualAmount || 0;
    categoryTotals[item.category] = (categoryTotals[item.category] || 0) + item.plannedAmount;
  }

  const netVariance = totalPlanned - totalActual;
  const withinCap = !grantMaxAmount || totalPlanned <= grantMaxAmount;

  return { totalPlanned, totalActual, netVariance, withinCap, categoryTotals };
}
