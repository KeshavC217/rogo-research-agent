import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the agent so the endpoint is tested without a model.
vi.mock("../src/agent.ts", () => ({ runAgent: vi.fn() }));

import { runAgent } from "../src/agent.ts";
import { createApp } from "../src/app.ts";

const mockedRunAgent = vi.mocked(runAgent);
let baseUrl: string;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  mockedRunAgent.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function chat(body: object) {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { res, events: text.trim().split("\n").map((l) => JSON.parse(l)) };
}

describe("POST /api/chat", () => {
  it("streams agent events as NDJSON and ends with the answer", async () => {
    mockedRunAgent.mockImplementation(async (_q, onEvent) => {
      onEvent({ type: "iteration", n: 1 });
      onEvent({ type: "tool_start", id: "t1", name: "getFinancials", input: { company: "Initech" } });
      onEvent({ type: "tool_end", id: "t1", name: "getFinancials", ms: 800 });
      return { answer: "Initech grew 14.8%.", iterations: 1 };
    });

    const { res, events } = await chat({ message: "Initech?" });

    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(events.map((e) => e.type)).toEqual(["iteration", "tool_start", "tool_end", "answer"]);
    expect(events.at(-1)).toEqual({ type: "answer", answer: "Initech grew 14.8%." });
  });

  it("reports agent failures as a final error event", async () => {
    mockedRunAgent.mockRejectedValue(new Error("overloaded"));

    const { events } = await chat({ message: "Initech?" });

    expect(events).toEqual([{ type: "error", message: "overloaded" }]);
  });

  it("passes well-formed history to the agent and drops malformed entries", async () => {
    mockedRunAgent.mockResolvedValue({ answer: "ok", iterations: 1 });

    await chat({
      message: "And margins?",
      history: [{ question: "q1", answer: "a1" }, { question: "q2" }, "junk", null],
    });

    expect(mockedRunAgent).toHaveBeenCalledWith(
      "And margins?",
      expect.any(Function),
      [{ question: "q1", answer: "a1" }],
      undefined,
    );
  });

  it.each([
    ["low", "claude-haiku-4-5"],
    ["medium", "claude-sonnet-5"],
    ["high", "claude-opus-5"],
  ])("runs %s effort on %s", async (effort, model) => {
    mockedRunAgent.mockResolvedValue({ answer: "ok", iterations: 1 });

    await chat({ message: "hi", effort });

    expect(mockedRunAgent.mock.calls[0][3]).toBe(model);
  });

  it.each([["max"], ["claude-opus-5"], [42], [undefined]])(
    "ignores an unrecognised effort (%s) and uses the agent default",
    async (effort) => {
      mockedRunAgent.mockResolvedValue({ answer: "ok", iterations: 1 });

      await chat({ message: "hi", effort });

      expect(mockedRunAgent.mock.calls[0][3]).toBeUndefined();
    },
  );
});
