import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the model: tests queue up the responses each call should return.
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

// Stub tool execution so the loop is tested in isolation from tool latency and data.
vi.mock("../src/tools.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools.ts")>()),
  executeTool: vi.fn(),
}));

import {
  estimateTokens,
  runAgent,
  windowHistory,
  type AgentEvent,
  type ChatTurn,
} from "../src/agent.ts";
import { executeTool, ToolError } from "../src/tools.ts";

const mockedExecuteTool = vi.mocked(executeTool);

function textResponse(text: string): Partial<Anthropic.Message> {
  return {
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    } as Anthropic.Usage,
  };
}

function toolResponse(...calls: [id: string, name: string, input: object][]) {
  return {
    content: calls.map(([id, name, input]) => ({ type: "tool_use", id, name, input })),
    stop_reason: "tool_use",
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 1400,
      cache_creation_input_tokens: 50,
    },
  } as Partial<Anthropic.Message>;
}

/** Queue the responses the model returns, one per call. */
function scriptModel(...responses: Partial<Anthropic.Message>[]) {
  const queue = [...responses];
  create.mockImplementation(async (params: Anthropic.MessageCreateParams) => {
    // The agent mutates its messages array after each call, so snapshot it now.
    sent.push(structuredClone(params));
    const next = queue.shift();
    if (!next) throw new Error("model called more times than scripted");
    return next;
  });
}

/** Every model request, as it was sent. */
let sent: Anthropic.MessageCreateParams[] = [];

async function run(question: string, history?: ChatTurn[]) {
  const events: AgentEvent[] = [];
  const result = await runAgent(question, (e) => events.push(e), history);
  return { ...result, events };
}

beforeEach(() => {
  sent = [];
  create.mockReset();
  mockedExecuteTool.mockReset();
});

describe("runAgent", () => {
  it("answers directly when the model uses no tools", async () => {
    scriptModel(textResponse("Acme is an industrial automation company."));

    const { answer, iterations } = await run("What does Acme do?");

    expect(answer).toBe("Acme is an industrial automation company.");
    expect(iterations).toBe(1);
    expect(mockedExecuteTool).not.toHaveBeenCalled();
    // The model's final turn is the answer: no separate rewrite/editor call.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("sends the question as the first user message and offers the tools", async () => {
    scriptModel(textResponse("ok"));

    await run("What does Acme do?");

    const [first] = sent;
    expect(first.messages[0]).toEqual({ role: "user", content: "What does Acme do?" });
    expect(first.tools?.length).toBeGreaterThan(0);
    const system = JSON.stringify(first.system);
    expect(system).toContain("Acme Corp");
    expect(system).toMatch(/final answer/i);
    expect(system).toMatch(/clarifying question/i);
  });

  it("runs requested tools and feeds results back to the model", async () => {
    mockedExecuteTool.mockResolvedValue({ revenue: 2260 });
    scriptModel(
      toolResponse(["t1", "getFinancials", { company: "Acme Corp" }]),
      textResponse("Acme revenue was $2,260M."),
    );

    const { answer, iterations } = await run("Acme revenue?");

    expect(answer).toBe("Acme revenue was $2,260M.");
    expect(iterations).toBe(2);
    expect(mockedExecuteTool).toHaveBeenCalledWith("getFinancials", { company: "Acme Corp" });

    const second = sent[1];
    const toolResults = second.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(toolResults).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ revenue: 2260 }) },
    ]);
  });

  it("returns one result per tool call when the model calls several at once", async () => {
    mockedExecuteTool.mockImplementation(async (name, input) => ({ name, input }));
    scriptModel(
      toolResponse(
        ["a", "getFinancials", { company: "Acme Corp" }],
        ["b", "getFinancials", { company: "Globex Inc" }],
      ),
      textResponse("done"),
    );

    await run("Compare Acme and Globex");

    const toolResults = sent[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(toolResults.map((r) => r.tool_use_id)).toEqual(["a", "b"]);
    expect(mockedExecuteTool).toHaveBeenCalledTimes(2);
  });

  it("runs tool calls from the same turn concurrently", async () => {
    // Hold each tool call open until the test releases it.
    const pending = new Map<string, () => void>();
    mockedExecuteTool.mockImplementation(
      (_name, input) =>
        new Promise((resolve) => pending.set(String(input.company), () => resolve(input))),
    );
    scriptModel(
      toolResponse(
        ["a", "getFinancials", { company: "Acme Corp" }],
        ["b", "getFinancials", { company: "Globex Inc" }],
      ),
      textResponse("done"),
    );

    const result = run("Compare Acme and Globex");
    await vi.waitFor(() => expect(pending.size).toBe(2));

    // Both started before either finished. Finish them out of order.
    pending.get("Globex Inc")!();
    pending.get("Acme Corp")!();
    await result;

    const toolResults = sent[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(toolResults.map((r) => r.tool_use_id)).toEqual(["a", "b"]);
  });

  it("still returns the other results when one parallel tool call fails", async () => {
    mockedExecuteTool.mockImplementation(async (_name, input) => {
      if (input.company === "Hooli") throw new ToolError("no financials found");
      return { ok: true };
    });
    scriptModel(
      toolResponse(
        ["a", "getFinancials", { company: "Hooli" }],
        ["b", "getFinancials", { company: "Acme Corp" }],
      ),
      textResponse("done"),
    );

    await run("Compare Hooli and Acme");

    const toolResults = sent[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(toolResults.map((r) => r.tool_use_id)).toEqual(["a", "b"]);
    expect(String(toolResults[0].content)).toContain("no financials found");
    expect(toolResults[1].content).toBe(JSON.stringify({ ok: true }));
  });

  it("reports a failing tool to the model and keeps going", async () => {
    mockedExecuteTool.mockRejectedValue(new ToolError('no financials found for "Acme"'));
    scriptModel(
      toolResponse(["t1", "getFinancials", { company: "Acme" }]),
      textResponse("I couldn't find financials for that name."),
    );

    const { answer, events } = await run("Acme revenue?");

    expect(answer).toBe("I couldn't find financials for that name.");
    expect(events).toContainEqual({
      type: "tool_failed",
      name: "getFinancials",
      message: 'no financials found for "Acme"',
    });
    const [result] = sent[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(String(result.content)).toContain("no financials found");
  });

  it("emits iteration and tool lifecycle events in order", async () => {
    mockedExecuteTool.mockResolvedValue([]);
    scriptModel(toolResponse(["t1", "searchCompanies", { query: "acme" }]), textResponse("ok"));

    const { events } = await run("Find Acme");

    expect(
      events.map((e) => e.type).filter((t) => t !== "model_call" && t !== "history"),
    ).toEqual([
      "iteration",
      "tool_start",
      "tool_end",
      "iteration",
    ]);
  });

  it("reports latency, tokens and stop reason for every model call", async () => {
    mockedExecuteTool.mockResolvedValue([]);
    scriptModel(toolResponse(["t1", "searchCompanies", { query: "acme" }]), textResponse("ok"));

    const { events } = await run("Find Acme");

    const modelCalls = events.filter((e) => e.type === "model_call");
    expect(modelCalls).toHaveLength(create.mock.calls.length);
    expect(modelCalls[0]).toMatchObject({
      model: expect.any(String),
      ms: expect.any(Number),
      inputTokens: 100,
      cacheReadTokens: 1400,
      cacheWriteTokens: 50,
      outputTokens: 10,
      stopReason: "tool_use",
    });
  });

  it("reports an unknown tool name from the model as a failure", async () => {
    const { executeTool: realExecuteTool } =
      await vi.importActual<typeof import("../src/tools.ts")>("../src/tools.ts");
    mockedExecuteTool.mockImplementation(realExecuteTool);
    scriptModel(toolResponse(["t1", "hallucinatedTool", {}]), textResponse("ok"));

    const { events } = await run("anything");

    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_failed", name: "hallucinatedTool" }),
    );
  });

  it("includes the tool input and duration in events", async () => {
    mockedExecuteTool.mockResolvedValue([]);
    scriptModel(toolResponse(["t1", "searchCompanies", { query: "acme" }]), textResponse("ok"));

    const { events } = await run("Find Acme");

    expect(events).toContainEqual({
      type: "tool_start",
      name: "searchCompanies",
      input: { query: "acme" },
    });
    const end = events.find((e) => e.type === "tool_end");
    expect(end).toMatchObject({ name: "searchCompanies", ms: expect.any(Number) });
  });

  it("keeps the full conversation across iterations", async () => {
    mockedExecuteTool.mockResolvedValue([]);
    scriptModel(
      toolResponse(["t1", "searchCompanies", { query: "acme" }]),
      toolResponse(["t2", "searchCompanies", { query: "globex" }]),
      textResponse("ok"),
    );

    await run("Find Acme and Globex");

    // question, (assistant tool_use, user tool_result) x2
    expect(sent[2].messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("stops after the iteration limit and returns a fallback answer", async () => {
    mockedExecuteTool.mockResolvedValue([]);
    const loopForever = Array.from({ length: 50 }, (_, i) =>
      toolResponse([`t${i}`, "searchCompanies", { query: "acme" }]),
    );
    scriptModel(...loopForever);

    const { answer, iterations } = await run("Find Acme");

    expect(iterations).toBeLessThan(50);
    expect(sent).toHaveLength(iterations);
    expect(answer).toMatch(/ran out of research steps/i);
    expect(create).toHaveBeenCalledTimes(iterations);
  });

  it("propagates model API errors", async () => {
    create.mockRejectedValue(new Error("overloaded"));

    await expect(run("anything")).rejects.toThrow("overloaded");
  });
});

describe("chat history", () => {
  const turn = (q: string, a: string): ChatTurn => ({ question: q, answer: a });

  it("sends prior turns as alternating user/assistant messages before the question", async () => {
    scriptModel(textResponse("Its gross margin was 74.8%."));

    await run("What about its margins?", [
      turn("How is Initech doing?", "Initech grew 14.8% in FY2024."),
    ]);

    expect(sent[0].messages).toEqual([
      { role: "user", content: "How is Initech doing?" },
      { role: "assistant", content: "Initech grew 14.8% in FY2024." },
      { role: "user", content: "What about its margins?" },
    ]);
  });

  it("reports how much history was kept", async () => {
    scriptModel(textResponse("ok"));

    const { events } = await run("next", [turn("q1", "a1"), turn("q2", "a2")]);

    expect(events[0]).toMatchObject({ type: "history", kept: 2, dropped: 0 });
  });

  it("drops the oldest turns once history exceeds the token budget", async () => {
    scriptModel(textResponse("ok"));
    // ~40k estimated tokens per turn: only the two most recent fit in 100k.
    const big = "x".repeat(160_000);
    const history = [turn("oldest", big), turn("middle", big), turn("newest", big)];

    const { events } = await run("next", history);

    const questions = sent[0].messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(questions).toEqual(["middle", "newest", "next"]);
    expect(events[0]).toMatchObject({ type: "history", kept: 2, dropped: 1 });
  });
});

describe("windowHistory", () => {
  const turn = (q: string, a: string): ChatTurn => ({ question: q, answer: a });

  it("keeps everything that fits", () => {
    const history = [turn("a", "b"), turn("c", "d")];
    expect(windowHistory(history, 1000).turns).toEqual(history);
  });

  it("keeps the most recent turns and never splits a turn", () => {
    const history = [turn("q1", "x".repeat(400)), turn("q2", "x".repeat(400))];
    const perTurn = estimateTokens("q1") + estimateTokens("x".repeat(400));

    const { turns, estimatedTokens } = windowHistory(history, perTurn + 1);

    expect(turns).toEqual([history[1]]);
    expect(estimatedTokens).toBe(perTurn);
  });

  it("returns nothing when even the latest turn is over budget", () => {
    expect(windowHistory([turn("q", "x".repeat(1000))], 10).turns).toEqual([]);
  });
});

describe("prompt caching", () => {
  it("marks the system prompt as a cache breakpoint and enables automatic caching", async () => {
    scriptModel(textResponse("ok"));

    await run("anything");

    const [params] = sent;
    expect(params.cache_control).toEqual({ type: "ephemeral" });
    const system = params.system as Anthropic.TextBlockParam[];
    expect(system.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("sends a byte-identical system prompt on every call so the cache can hit", async () => {
    mockedExecuteTool.mockResolvedValue([]);
    scriptModel(toolResponse(["t1", "searchCompanies", { query: "a" }]), textResponse("ok"));
    await run("first");
    scriptModel(textResponse("ok"));
    await run("second", [{ question: "first", answer: "ok" }]);

    const systems = sent.map((p) => JSON.stringify(p.system));
    expect(new Set(systems).size).toBe(1);
  });
});
