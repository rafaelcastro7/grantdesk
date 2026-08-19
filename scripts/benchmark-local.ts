/**
 * Which local model should be the floor, on this machine, for this work.
 *
 * The floor is not a nicety. When the hosted providers are unreachable — a
 * retired model, an exhausted quota, a spent daily allowance, all of which have
 * happened here — the local model *is* the product, and a consultant is reading
 * what it wrote.
 *
 * This machine has no GPU: an i7-6700HQ from 2015, four physical cores, 48 GB
 * of RAM. Everything runs on CPU, so a model's size is its speed, and speed is
 * a quality attribute here rather than a comfort. A draft nobody waits for was
 * not produced.
 *
 * Measured on the three things the product actually asks of it, not on a
 * "hello world":
 *
 *   JSON      — extraction runs in JSON mode. A model that answers beautifully
 *               in prose and emits unparseable JSON is useless for half the
 *               system, and this is exactly where small models fail.
 *   PROSE     — a real section prompt with real facts, checked for the two
 *               failures that matter: inventing figures, and ignoring the
 *               facts supplied.
 *   THROUGHPUT— tokens per second at generation, and the load time separately,
 *               because a model reloaded on every call pays six seconds before
 *               it says anything.
 *
 * Usage: bun run benchmark:local [model ...]
 */

import { config } from "dotenv";

config({ path: ".env" });

const OLLAMA = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

const CANDIDATES =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : ["phi4-mini", "gemma4:e2b-it-qat", "qwen3.5:2b-q4_K_M"];

/** Facts the prose task is allowed to use. Anything else is invention. */
const FACTS = {
  founded: "2011",
  sites: "6",
  budget: "450000",
  volunteers: "312",
};

type Task = {
  key: string;
  json: boolean;
  system: string;
  user: string;
  predict: number;
  /** What a correct answer looks like, checked without a judge model. */
  check: (text: string) => { ok: boolean; note: string };
};

const TASKS: Task[] = [
  {
    key: "json",
    json: true,
    predict: 400,
    system:
      "You read a funding call and list what an applicant must provide. Reply with a single JSON object and nothing else.",
    user: 'Call text: "Applicants must submit a project description of no more than 500 words and audited financial statements. Open to registered charities in Ontario." Return {"requirements":[{"label":"...","kind":"section|attachment|eligibility","wordLimit":number|null}]}',
    check: (text) => {
      const cleaned = text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
      try {
        const parsed = JSON.parse(cleaned) as { requirements?: unknown };
        if (!Array.isArray(parsed.requirements)) {
          return { ok: false, note: "parsed, but no requirements array" };
        }
        const items = parsed.requirements as Array<{ label?: unknown; wordLimit?: unknown }>;
        if (items.length === 0) return { ok: false, note: "empty requirements" };
        const labelled = items.filter((r) => typeof r.label === "string" && r.label.length > 2);
        // The 500-word limit is stated in the text; missing it means the model
        // produced valid JSON about nothing in particular.
        const foundLimit = items.some((r) => Number(r.wordLimit) === 500);
        return {
          ok: labelled.length >= 2 && foundLimit,
          note: `${labelled.length} labelled, word limit ${foundLimit ? "found" : "MISSED"}`,
        };
      } catch {
        return { ok: false, note: "unparseable" };
      }
    },
  },
  {
    key: "prose",
    json: false,
    predict: 400,
    system:
      "You draft one section of a grant application. Use only the facts given. If a fact is missing, write [NEED: what is missing] rather than inventing it. Plain prose, no preamble.",
    user: `Requirement: Organizational Capacity, 150 words.
Organization: Ravine Keepers, a nonprofit restoring urban ravines.
Founded in ${FACTS.founded}. Works across ${FACTS.sites} sites. Annual budget CAD ${FACTS.budget}.
Completed the Wentworth Ravine restoration with ${FACTS.volunteers} volunteers.
Write the section.`,
    check: (text) => {
      const permitted = new Set(Object.values(FACTS).map((v) => v.replace(/,/g, "")));
      for (let year = 2011; year <= 2026; year++) permitted.add(String(year));
      permitted.add("150");
      permitted.add("450,000".replace(/,/g, ""));

      const withoutGaps = text.replace(/\[NEED:[^\]]*\]/g, " ").replace(/^\s*\d{1,2}[.)]\s/gm, " ");
      const invented = [
        ...new Set((withoutGaps.match(/\d[\d,]*/g) ?? []).map((n) => n.replace(/,/g, ""))),
      ].filter((n) => !permitted.has(n));

      const usedFacts = ["Wentworth", FACTS.volunteers, FACTS.founded].filter((f) =>
        text.includes(f),
      ).length;
      const words = text.trim().split(/\s+/).filter(Boolean).length;

      if (words < 40) return { ok: false, note: `only ${words} words` };
      if (invented.length > 0) return { ok: false, note: `invented ${invented.join(", ")}` };
      return {
        ok: usedFacts >= 2,
        note: `${words} words, used ${usedFacts}/3 supplied facts`,
      };
    },
  },
];

type Measured = {
  model: string;
  task: string;
  ok: boolean;
  note: string;
  tokensPerSecond: number;
  loadMs: number;
  totalMs: number;
};

async function run(model: string, task: Task): Promise<Measured> {
  const started = Date.now();
  const response = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: task.system },
        { role: "user", content: task.user },
      ],
      stream: false,
      // Held resident: a model unloaded between calls pays several seconds
      // before it says anything, and that is a property of the schedule rather
      // than of the model.
      keep_alive: "30m",
      // Every current small model is a reasoning model, and left to itself it
      // spends the whole budget thinking: qwen3.5 and gemma4 both returned
      // done_reason "length" with an empty `content` and 1800 characters in
      // `thinking`. The first version of this benchmark scored that as a
      // quality failure and called two good models unusable. Raising the
      // budget does not fix it — qwen3.5 produced nothing after 1200 tokens
      // and 131 seconds. Turning thinking off does: 157 words in 20.
      think: false,
      ...(task.json ? { format: "json" } : {}),
      options: { num_predict: task.predict, temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(900_000),
  });

  const body = (await response.json()) as {
    message?: { content?: string };
    eval_count?: number;
    eval_duration?: number;
    load_duration?: number;
    error?: string;
  };

  if (body.error) {
    return {
      model,
      task: task.key,
      ok: false,
      note: body.error.slice(0, 60),
      tokensPerSecond: 0,
      loadMs: 0,
      totalMs: Date.now() - started,
    };
  }

  const text = body.message?.content ?? "";
  const verdict = task.check(text);

  return {
    model,
    task: task.key,
    ok: verdict.ok,
    note: verdict.note,
    tokensPerSecond: (body.eval_count ?? 0) / ((body.eval_duration ?? 1) / 1e9),
    loadMs: Math.round((body.load_duration ?? 0) / 1e6),
    totalMs: Date.now() - started,
  };
}

console.log(`Local models on this machine, ${CANDIDATES.length} candidates.\n`);
console.log("model                    task    ok   tok/s   load    total   note");
console.log("─".repeat(94));

const results: Measured[] = [];
for (const model of CANDIDATES) {
  for (const task of TASKS) {
    try {
      const measured = await run(model, task);
      results.push(measured);
      console.log(
        `${model.slice(0, 24).padEnd(24)} ${measured.task.padEnd(7)} ` +
          `${(measured.ok ? "yes" : "NO").padEnd(4)} ` +
          `${measured.tokensPerSecond.toFixed(1).padStart(5)}  ` +
          `${`${measured.loadMs}ms`.padStart(7)} ` +
          `${`${(measured.totalMs / 1000).toFixed(0)}s`.padStart(6)}   ${measured.note}`,
      );
    } catch (error) {
      console.log(
        `${model.slice(0, 24).padEnd(24)} ${task.key.padEnd(7)} ERR  ` +
          `${error instanceof Error ? error.message.slice(0, 50) : String(error)}`,
      );
    }
  }
}

console.log("─".repeat(94));
console.log("\nA usable floor has to pass both tasks. Among those, faster wins:\n");

const byModel = new Map<string, Measured[]>();
for (const r of results) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);

const ranked = [...byModel.entries()]
  .map(([model, rows]) => ({
    model,
    passes: rows.every((r) => r.ok),
    // Prose throughput is the one a consultant waits on.
    speed: rows.find((r) => r.task === "prose")?.tokensPerSecond ?? 0,
    seconds: Math.round((rows.find((r) => r.task === "prose")?.totalMs ?? 0) / 1000),
  }))
  .sort((a, b) => Number(b.passes) - Number(a.passes) || b.speed - a.speed);

for (const entry of ranked) {
  // 350 tokens is roughly a 250-word section, the common case.
  const draftSeconds = entry.speed > 0 ? Math.round(350 / entry.speed) : 0;
  console.log(
    `  ${entry.model.padEnd(24)} ${entry.passes ? "usable" : "NOT usable"}` +
      (entry.speed > 0
        ? `  ${entry.speed.toFixed(1)} tok/s — a 250-word section in ~${draftSeconds}s`
        : ""),
  );
}
