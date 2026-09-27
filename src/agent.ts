/**
 * The research agent: a tool-use loop over the mocked research tools.
 */

import Anthropic from "@anthropic-ai/sdk";
import { companies } from "./data.ts";
import { executeTool, toolSchemas } from "./tools.ts";

/** Model used when the caller doesn't choose one (e.g. the eval suite). */
const DEFAULT_MODEL = process.env.ROGO_MODEL ?? "claude-sonnet-5";
/** Model calls per question. The last one must answer rather than call tools. */
export const MAX_ITERATIONS = 12;

const FINAL_ITERATION_NOTE =
  "You've reached the research step limit, so you can't call any more tools. " +
  "Answer now from what you've gathered, and say briefly what you couldn't check.";

/** Budget for prior chat turns sent with each question. Oldest turns drop first. */
export const HISTORY_TOKEN_BUDGET = 25_000;

const client = new Anthropic();

const SYSTEM_PROMPT = `You are Rogo Research, an assistant that answers questions about companies for financial analysts.

Use the tools to look up companies, profiles, financials and source documents. Answer the analyst's question.

Ambiguity:
- If the question is ambiguous, or depends on something you cannot infer directly from the data (e.g. a name that matches more than one company, an unclear time period or metric), don't guess. Ask one short clarifying question instead, and say briefly what the options are. If the ambiguity is clear from the question itself, ask before doing any research.
- Only once you have asked and the analyst's reply still doesn't resolve it, stop asking: make a reasonable assumption, state it explicitly in one line, and answer.

When you have what you need, write your final answer. It is shown to the analyst exactly as you write it, with no further editing, so:
- Lead with the direct answer, then the supporting figures.
- Keep it brief, clear and easy to follow; conversational rather than a formal report.
- Don't narrate your research process or mention tools.

Our coverage universe:
${companies
  .map(
    (c) =>
      `- ${c.name} (${c.ticker}) — ${c.sector}, HQ ${c.hq}, ${c.employees} employees. ${c.description}`,
  )
  .join("\n")}
`;

/** One completed exchange in a chat: the analyst's question and the final answer. */
export interface ChatTurn {
  question: string;
  answer: string;
}

export type AgentEvent =
  | { type: "history"; kept: number; dropped: number; estimatedTokens: number }
  | { type: "iteration"; n: number }
  | {
      type: "model_call";
      model: string;
      ms: number;
      /** Uncached input tokens; cached tokens are reported separately below. */
      inputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      outputTokens: number;
      stopReason: string | null;
    }
  // `id` is the model's tool_use id, so parallel calls to the same tool can be told apart.
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; ms: number }
  | { type: "tool_failed"; id: string; name: string; message: string };

export interface AgentResult {
  answer: string;
  iterations: number;
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Rough token estimate (~4 characters per token); good enough for a context budget. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Sliding window over the chat: keeps the most recent whole turns that fit in
 * the budget and drops older ones.
 */
export function windowHistory(
  history: ChatTurn[],
  budget: number = HISTORY_TOKEN_BUDGET,
): { turns: ChatTurn[]; estimatedTokens: number } {
  let used = 0;
  let start = history.length;
  while (start > 0) {
    const turn = history[start - 1];
    const cost = estimateTokens(turn.question) + estimateTokens(turn.answer);
    if (used + cost > budget) break;
    used += cost;
    start--;
  }
  return { turns: history.slice(start), estimatedTokens: used };
}

// The system prompt (and the tools, which render before it) is identical on
// every request, so mark it as a cache breakpoint. It stays cached even when the
// history window slides and the conversation prefix changes.
const SYSTEM: Anthropic.TextBlockParam[] = [
  { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
];

/** Calls the model and reports its latency and token usage. */
async function callModel(
  params: Anthropic.MessageCreateParamsNonStreaming,
  onEvent: (event: AgentEvent) => void,
): Promise<Anthropic.Message> {
  const startedAt = Date.now();
  const response = await client.messages.create({
    // Automatic caching: moves a breakpoint to the end of the conversation on
    // each call, so tool-loop iterations and follow-up questions reuse the prefix.
    cache_control: { type: "ephemeral" },
    ...params,
  });
  onEvent({
    type: "model_call",
    model: params.model,
    ms: Date.now() - startedAt,
    inputTokens: response.usage.input_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    outputTokens: response.usage.output_tokens,
    stopReason: response.stop_reason,
  });
  return response;
}

/** Runs one tool call. Never throws: failures become a result the model can read. */
async function runTool(
  use: Anthropic.ToolUseBlock,
  onEvent: (event: AgentEvent) => void,
): Promise<Anthropic.ToolResultBlockParam> {
  const startedAt = Date.now();
  onEvent({ type: "tool_start", id: use.id, name: use.name, input: use.input });

  let content: string;
  try {
    const output = await executeTool(use.name, use.input as Record<string, unknown>);
    content = JSON.stringify(output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    content = `${use.name} returned: ${message}`;
    onEvent({ type: "tool_failed", id: use.id, name: use.name, message });
  }

  onEvent({ type: "tool_end", id: use.id, name: use.name, ms: Date.now() - startedAt });
  return { type: "tool_result", tool_use_id: use.id, content };
}

export async function runAgent(
  question: string,
  onEvent: (event: AgentEvent) => void,
  history: ChatTurn[] = [],
  model: string = DEFAULT_MODEL,
): Promise<AgentResult> {
  const { turns, estimatedTokens } = windowHistory(history);
  onEvent({
    type: "history",
    kept: turns.length,
    dropped: history.length - turns.length,
    estimatedTokens,
  });

  const messages: Anthropic.MessageParam[] = [
    ...turns.flatMap((turn): Anthropic.MessageParam[] => [
      { role: "user", content: turn.question },
      { role: "assistant", content: turn.answer },
    ]),
    { role: "user", content: question },
  ];

  let answer = "";
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    onEvent({ type: "iteration", n: iterations });

    // On the last iteration, forbid tool calls so the model writes an answer from
    // the results it already has, instead of requesting tools it will never see.
    // Tools stay in the request (they lead the cached prefix); tool_choice does the work.
    const isFinal = iterations === MAX_ITERATIONS;
    if (isFinal) {
      const last = messages.at(-1)!;
      if (Array.isArray(last.content)) {
        last.content.push({ type: "text", text: FINAL_ITERATION_NOTE });
      }
    }

    const response = await callModel(
      {
        model,
        max_tokens: 16000,
        system: SYSTEM,
        tools: toolSchemas,
        ...(isFinal && { tool_choice: { type: "none" } }),
        messages,
      },
      onEvent,
    );

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    // Newer models can decline a request via safety classifiers; say so plainly
    // rather than falling through to the "ran out of steps" message.
    if (response.stop_reason === "refusal") {
      answer = "I can't help with that request.";
      break;
    }

    if (toolUses.length === 0) {
      answer = textOf(response);
      break;
    }

    // Tool calls within one turn are independent, so run them concurrently.
    // Promise.all keeps results in request order.
    const toolResults = await Promise.all(toolUses.map((use) => runTool(use, onEvent)));

    messages.push({ role: "user", content: toolResults });
  }

  // Only reachable if the final forced answer came back empty.
  if (!answer) {
    answer =
      "I looked at a number of sources but couldn't pull an answer together. Try asking a narrower question.";
  }

  return { answer, iterations };
}
