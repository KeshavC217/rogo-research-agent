/**
 * Per-request logging: every line is tagged with a request id so concurrent
 * chats can be told apart, and each request ends with a one-line summary.
 */

import { randomUUID } from "node:crypto";
import type { AgentEvent } from "./agent.ts";

export interface RequestStats {
  iterations: number;
  modelCalls: number;
  modelMs: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  toolCalls: number;
  toolFailures: number;
  toolMs: number;
}

export function createRequestLog(
  write: (line: string) => void = console.log,
  id: string = randomUUID().slice(0, 8),
) {
  const startedAt = Date.now();
  const stats: RequestStats = {
    iterations: 0,
    modelCalls: 0,
    modelMs: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    toolFailures: 0,
    toolMs: 0,
  };

  const log = (tag: string, message: string) => write(`[${id}] ${tag.padEnd(6)} ${message}`);
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

  function onEvent(event: AgentEvent) {
    switch (event.type) {
      case "history":
        log(
          "chat",
          `history ${event.kept} turns (~${event.estimatedTokens} tokens)` +
            (event.dropped ? `, dropped ${event.dropped} oldest` : ""),
        );
        break;
      case "iteration":
        stats.iterations = event.n;
        log("agent", `iteration ${event.n}`);
        break;
      case "model_call":
        stats.modelCalls++;
        stats.modelMs += event.ms;
        stats.inputTokens += event.inputTokens;
        stats.cacheReadTokens += event.cacheReadTokens;
        stats.cacheWriteTokens += event.cacheWriteTokens;
        stats.outputTokens += event.outputTokens;
        log(
          "model",
          `${event.model} (${event.ms}ms) ` +
            `in=${event.inputTokens} cache_read=${event.cacheReadTokens} ` +
            `cache_write=${event.cacheWriteTokens} out=${event.outputTokens} stop=${event.stopReason}`,
        );
        break;
      case "tool_start":
        stats.toolCalls++;
        log("tool", `→ ${event.name} ${JSON.stringify(event.input)}`);
        break;
      case "tool_end":
        stats.toolMs += event.ms;
        log("tool", `← ${event.name} (${event.ms}ms)`);
        break;
      case "tool_failed":
        stats.toolFailures++;
        log("tool", `! ${event.name}: ${event.message}`);
        break;
    }
  }

  return {
    id,
    stats,
    onEvent,
    start(message: string) {
      log("chat", message);
    },
    done() {
      const s = stats;
      log(
        "done",
        `${elapsed()} · ${s.iterations} iterations · ` +
          `${s.modelCalls} model calls (${s.modelMs}ms) · ` +
          `${s.toolCalls} tool calls (${s.toolMs}ms, ${s.toolFailures} failed) · ` +
          `tokens in=${s.inputTokens} cache_read=${s.cacheReadTokens} ` +
          `cache_write=${s.cacheWriteTokens} out=${s.outputTokens}`,
      );
    },
    error(err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", `after ${elapsed()} (${stats.modelCalls} model calls): ${message}`);
    },
  };
}
