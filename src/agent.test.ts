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
vi.mock("./tools.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tools.ts")>()),
  executeTool: vi.fn(),
}));

import { runAgent, type AgentEvent } from "./agent.ts";
import { executeTool, ToolError } from "./tools.ts";

const mockedExecuteTool = vi.mocked(executeTool);

function textResponse(text: string): Partial<Anthropic.Message> {
  return { content: [{ type: "text", text, citations: null }], stop_reason: "end_turn" };
}

function toolResponse(...calls: [id: string, name: string, input: object][]) {
  return {
    content: calls.map(([id, name, input]) => ({ type: "tool_use", id, name, input })),
    stop_reason: "tool_use",
  } as Partial<Anthropic.Message>;
}

/**
 * Queue the research-loop responses. Calls made without tools (e.g. a
 * post-processing pass) echo the draft back, so these tests don't depend on
 * whether that pass exists.
 */
function scriptModel(...responses: Partial<Anthropic.Message>[]) {
  const queue = [...responses];
  create.mockImplementation(async (params: Anthropic.MessageCreateParams) => {
    // The agent mutates its messages array after each call, so snapshot it now.
    sent.push(structuredClone(params));
    if (!params.tools) {
      const prompt = String(params.messages.at(-1)?.content ?? "");
      const draft = prompt.match(/Draft answer:\n([\s\S]*?)\n\nRewrite/)?.[1] ?? prompt;
      return textResponse(draft);
    }
    const next = queue.shift();
    if (!next) throw new Error("model called more times than scripted");
    return next;
  });
}

let sent: Anthropic.MessageCreateParams[] = [];

/** The research-loop calls only (those offering tools), as they were sent. */
function loopCalls(): Anthropic.MessageCreateParams[] {
  return sent.filter((p) => p.tools);
}

async function run(question: string) {
  const events: AgentEvent[] = [];
  const result = await runAgent(question, (e) => events.push(e));
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
  });

  it("sends the question as the first user message and offers the tools", async () => {
    scriptModel(textResponse("ok"));

    await run("What does Acme do?");

    const [first] = loopCalls();
    expect(first.messages[0]).toEqual({ role: "user", content: "What does Acme do?" });
    expect(first.tools?.length).toBeGreaterThan(0);
    expect(first.system).toContain("Acme Corp");
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

    const second = loopCalls()[1];
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

    const toolResults = loopCalls()[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(toolResults.map((r) => r.tool_use_id)).toEqual(["a", "b"]);
    expect(mockedExecuteTool).toHaveBeenCalledTimes(2);
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
    const [result] = loopCalls()[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(String(result.content)).toContain("no financials found");
  });

  it("emits iteration and tool lifecycle events in order", async () => {
    mockedExecuteTool.mockResolvedValue([]);
    scriptModel(toolResponse(["t1", "searchCompanies", { query: "acme" }]), textResponse("ok"));

    const { events } = await run("Find Acme");

    expect(events.map((e) => e.type)).toEqual(["iteration", "tool_start", "tool_end", "iteration"]);
  });

  it("reports an unknown tool name from the model as a failure", async () => {
    const { executeTool: realExecuteTool } =
      await vi.importActual<typeof import("./tools.ts")>("./tools.ts");
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
    expect(loopCalls()[2].messages.map((m) => m.role)).toEqual([
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
    expect(loopCalls()).toHaveLength(iterations);
    expect(answer).toMatch(/ran out of research steps/i);
  });

  it("propagates model API errors", async () => {
    create.mockRejectedValue(new Error("overloaded"));

    await expect(run("anything")).rejects.toThrow("overloaded");
  });
});
