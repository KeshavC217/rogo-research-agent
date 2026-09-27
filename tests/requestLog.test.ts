import { describe, expect, it } from "vitest";
import { createRequestLog } from "../src/requestLog.ts";

function capture() {
  const lines: string[] = [];
  const log = createRequestLog((line) => lines.push(line), "req123");
  return { log, lines };
}

describe("createRequestLog", () => {
  it("tags every line with the request id", () => {
    const { log, lines } = capture();

    log.start("Compare Acme and Globex");
    log.onEvent({ type: "iteration", n: 1 });
    log.onEvent({ type: "tool_start", id: "t1", name: "getFinancials", input: { company: "Acme Corp" } });
    log.done();

    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.startsWith("[req123] "))).toBe(true);
  });

  it("logs model calls with model, latency, tokens and stop reason", () => {
    const { log, lines } = capture();

    log.onEvent({
      type: "model_call",
      model: "claude-sonnet-5",
      ms: 1234,
      inputTokens: 5000,
      cacheReadTokens: 1200,
      cacheWriteTokens: 40,
      outputTokens: 300,
      stopReason: "end_turn",
    });

    expect(lines[0]).toContain("claude-sonnet-5 (1234ms) in=5000 cache_read=1200 cache_write=40 out=300 stop=end_turn");
  });

  it("totals model, token and tool usage across the request", () => {
    const { log, lines } = capture();
    const model = {
      type: "model_call" as const,
      model: "m",
      stopReason: "tool_use",
    };

    log.onEvent({ type: "iteration", n: 1 });
    log.onEvent({
      ...model,
      ms: 1000,
      inputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 1500,
      outputTokens: 50,
    });
    log.onEvent({ type: "tool_start", id: "a", name: "a", input: {} });
    log.onEvent({ type: "tool_end", id: "a", name: "a", ms: 400 });
    log.onEvent({ type: "tool_start", id: "b", name: "b", input: {} });
    log.onEvent({ type: "tool_failed", id: "b", name: "b", message: "boom" });
    log.onEvent({ type: "tool_end", id: "b", name: "b", ms: 300 });
    log.onEvent({ type: "iteration", n: 2 });
    log.onEvent({
      ...model,
      ms: 2000,
      inputTokens: 3000,
      cacheReadTokens: 1500,
      cacheWriteTokens: 600,
      outputTokens: 200,
    });

    expect(log.stats).toEqual({
      iterations: 2,
      modelCalls: 2,
      modelMs: 3000,
      inputTokens: 4000,
      cacheReadTokens: 1500,
      cacheWriteTokens: 2100,
      outputTokens: 250,
      toolCalls: 2,
      toolFailures: 1,
      toolMs: 700,
    });

    log.done();
    const summary = lines.at(-1)!;
    expect(summary).toContain("2 iterations");
    expect(summary).toContain("2 model calls (3000ms)");
    expect(summary).toContain("2 tool calls (700ms, 1 failed)");
    expect(summary).toContain("tokens in=4000 cache_read=1500 cache_write=2100 out=250");
  });

  it("logs errors with how far the request got", () => {
    const { log, lines } = capture();

    log.onEvent({
      type: "model_call",
      model: "m",
      ms: 10,
      inputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      stopReason: "tool_use",
    });
    log.error(new Error("overloaded"));

    expect(lines.at(-1)).toMatch(/error .*\(1 model calls\): overloaded/);
  });

  it("logs how much chat history was kept and dropped", () => {
    const { log, lines } = capture();

    log.onEvent({ type: "history", kept: 3, dropped: 2, estimatedTokens: 98000 });

    expect(lines[0]).toContain("history 3 turns (~98000 tokens), dropped 2 oldest");
  });

  it("generates distinct ids by default", () => {
    expect(createRequestLog(() => {}).id).not.toBe(createRequestLog(() => {}).id);
  });
});
