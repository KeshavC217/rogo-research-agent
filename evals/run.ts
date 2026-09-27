/**
 * Runs the agent on each eval case, has a judge model score the answers, and
 * prints a scorecard. Full results are written to evals/results/.
 *
 *   npm run eval                    # all cases
 *   npm run eval -- initech umbrella  # only cases whose id contains one of these
 */

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { runAgent } from "../src/agent.ts";
import { createRequestLog, type RequestStats } from "../src/requestLog.ts";
import { cases, type EvalCase } from "./cases.ts";
import { judge, type Verdict } from "./judge.ts";

const CONCURRENCY = 3;

interface CaseResult {
  id: string;
  question: string;
  answer?: string;
  verdict?: Verdict;
  error?: string;
  ms: number;
  stats: RequestStats;
  toolCalls: { name: string; input: unknown }[];
}

async function runCase(testCase: EvalCase): Promise<CaseResult> {
  const log = createRequestLog(() => {}); // collect stats silently
  const toolCalls: CaseResult["toolCalls"] = [];
  const startedAt = Date.now();
  const base = { id: testCase.id, question: testCase.question, stats: log.stats, toolCalls };

  let answer: string;
  try {
    const result = await runAgent(testCase.question, (event) => {
      log.onEvent(event);
      if (event.type === "tool_start") toolCalls.push({ name: event.name, input: event.input });
    });
    answer = result.answer;
  } catch (err) {
    return { ...base, ms: Date.now() - startedAt, error: `agent: ${String(err)}` };
  }
  const ms = Date.now() - startedAt;

  try {
    return { ...base, ms, answer, verdict: await judge(testCase, answer) };
  } catch (err) {
    return { ...base, ms, answer, error: `judge: ${String(err)}` };
  }
}

/** Runs tasks with at most `limit` in flight, preserving input order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function printScorecard(results: CaseResult[]) {
  const rows = results.map((r) => ({
    case: r.id,
    answered: r.verdict?.answered.score ?? "-",
    accuracy: r.verdict?.accuracy.score ?? "-",
    concise: r.verdict?.conciseness.score ?? "-",
    time: `${(r.ms / 1000).toFixed(1)}s`,
    tools: r.stats.toolCalls,
    "tool fails": r.stats.toolFailures,
    iters: r.stats.iterations,
    "tokens in/out": `${r.stats.inputTokens}/${r.stats.outputTokens}`,
  }));
  console.table(rows);

  const judged = results.filter((r) => r.verdict);
  console.log(
    `Mean over ${judged.length}/${results.length} judged: ` +
      `answered ${mean(judged.map((r) => r.verdict!.answered.score)).toFixed(2)} · ` +
      `accuracy ${mean(judged.map((r) => r.verdict!.accuracy.score)).toFixed(2)} · ` +
      `concise ${mean(judged.map((r) => r.verdict!.conciseness.score)).toFixed(2)} · ` +
      `time ${(mean(results.map((r) => r.ms)) / 1000).toFixed(1)}s`,
  );

  for (const r of results) {
    if (r.error) console.log(`\n✗ ${r.id}: ${r.error}`);
    else if (r.verdict!.issues.length) {
      console.log(`\n${r.id}:`);
      for (const issue of r.verdict!.issues) console.log(`  - ${issue}`);
    }
  }
}

async function main() {
  const filters = process.argv.slice(2);
  const selected = filters.length
    ? cases.filter((c) => filters.some((f) => c.id.includes(f)))
    : cases;
  if (!selected.length) {
    console.error(`No cases match ${filters.join(", ")}. Ids: ${cases.map((c) => c.id).join(", ")}`);
    process.exit(1);
  }

  console.log(`Running ${selected.length} case(s)…`);
  const results = await pool(selected, CONCURRENCY, async (c) => {
    const result = await runCase(c);
    console.log(`  ${result.error ? "✗" : "✓"} ${c.id} (${(result.ms / 1000).toFixed(1)}s)`);
    return result;
  });

  console.log();
  printScorecard(results);

  mkdirSync("evals/results", { recursive: true });
  const file = `evals/results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`\nFull answers and judge reasoning: ${file}`);
}

main();
