/**
 * LLM judge: scores an agent answer against the complete research dataset.
 */

import Anthropic from "@anthropic-ai/sdk";
import { companies, documents, financials } from "../src/data.ts";
import type { EvalCase } from "./cases.ts";

const JUDGE_MODEL = process.env.ROGO_JUDGE_MODEL ?? "claude-opus-5";

const client = new Anthropic();

export interface Criterion {
  score: number;
  reason: string;
}

export interface Verdict {
  answered: Criterion;
  accuracy: Criterion;
  conciseness: Criterion;
  issues: string[];
}

const criterion = {
  type: "object",
  properties: {
    score: { type: "integer", description: "1 to 5" },
    reason: { type: "string", description: "One or two sentences." },
  },
  required: ["score", "reason"],
  additionalProperties: false,
};

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    answered: criterion,
    accuracy: criterion,
    conciseness: criterion,
    issues: {
      type: "array",
      items: { type: "string" },
      description: "Specific problems, e.g. a wrong figure or a missing caveat. Empty if none.",
    },
  },
  required: ["answered", "accuracy", "conciseness", "issues"],
  additionalProperties: false,
};

// The full dataset is the ground truth. It is identical for every case, so it
// sits in the system prompt where it can be cached across judge calls.
const SYSTEM_PROMPT = `You grade answers written by a research assistant for financial analysts.

Below is the COMPLETE dataset the assistant had access to through its tools. Treat it as ground truth. Figures are USD millions unless stated.

<dataset>
${JSON.stringify({ companies, financials, documents })}
</dataset>

Score each criterion from 1 to 5 (5 excellent, 3 acceptable with clear problems, 1 fails):

- answered: Does it directly answer the question that was asked? Saying clearly when something is outside the dataset counts as answering. The assistant is instructed to ask a short clarifying question when the question is genuinely ambiguous, and to make a stated assumption instead if it has already asked and the reply didn't resolve it. A well-targeted clarifying question to a genuinely ambiguous question deserves full marks; asking when the question was clear, or asking again after an unresolved clarification, should score low.
- accuracy: Check every figure and factual claim against the dataset. Penalise wrong or invented numbers heavily. Also penalise omitting a caveat that would change an analyst's conclusion (e.g. unfiled or preliminary periods, acquired vs organic growth).
- conciseness: Is it as short as it can be while still complete? Penalise padding, repetition, narrating the research process, and tables or headings that add length without adding clarity.

Grader notes for each question describe what a strong answer gets right. Use them as guidance, but verify against the dataset yourself.`;

/** Earlier turns, so the judge can interpret follow-ups like "what about its margins?". */
function formatHistory(testCase: EvalCase): string {
  if (!testCase.history?.length) return "";
  const turns = testCase.history
    .map((t) => `<turn>\n<question>${t.question}</question>\n<answer>${t.answer}</answer>\n</turn>`)
    .join("\n");
  return `<earlier_conversation>\n${turns}\n</earlier_conversation>\n\n`;
}

export async function judge(testCase: EvalCase, answer: string): Promise<Verdict> {
  const response = await client.beta.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    // Breakpoint at the end of the shared dataset, not on the per-case message,
    // so every judge call after the first reads the dataset from cache.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `${formatHistory(testCase)}<question>${testCase.question}</question>

<grader_notes>${testCase.notes}</grader_notes>

<answer>
${answer}
</answer>`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("judge refused to grade this answer");
  }
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("judge returned no verdict");

  const verdict = JSON.parse(text.text) as Verdict;
  for (const c of [verdict.answered, verdict.accuracy, verdict.conciseness]) {
    c.score = Math.min(5, Math.max(1, Math.round(c.score)));
  }
  return verdict;
}
