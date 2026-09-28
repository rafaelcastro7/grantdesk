export type PrioritizationInput = {
  id: string;
  title: string;
  funderName: string;
  amountMax: number | null;
  relevance: number | null;
  requirementCount: number;
  deadline: string | null;
};

export type PrioritizationQuadrant = "quick_wins" | "high_value" | "filler" | "low_priority";

export type PrioritizedItem = PrioritizationInput & {
  expectedValue: number;
  estimatedHours: number;
  roiScore: number;
  quadrant: PrioritizationQuadrant;
};

export function calculateGrantRoi(input: PrioritizationInput): PrioritizedItem {
  const amount = input.amountMax || 50000;
  const rel = input.relevance || 0.5;
  const expectedValue = amount * rel;
  const estimatedHours = Math.max(8, input.requirementCount * 6);
  const roiScore = Math.round(expectedValue / estimatedHours);

  let quadrant: PrioritizationQuadrant = "filler";
  if (roiScore > 2000 && estimatedHours <= 20) quadrant = "quick_wins";
  else if (roiScore > 2000 && estimatedHours > 20) quadrant = "high_value";
  else if (roiScore <= 2000 && estimatedHours > 20) quadrant = "low_priority";

  return { ...input, expectedValue, estimatedHours, roiScore, quadrant };
}

export function prioritizeGrants(inputs: PrioritizationInput[]): PrioritizedItem[] {
  return inputs.map(calculateGrantRoi).sort((a, b) => b.roiScore - a.roiScore);
}
