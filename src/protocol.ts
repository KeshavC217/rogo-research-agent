/**
 * The /api/chat response: newline-delimited JSON, one event per line. Progress
 * events arrive as the agent works; the stream ends with `answer` or `error`.
 */

import type { AgentEvent } from "./agent.ts";

export type ChatStreamEvent =
  | AgentEvent
  | { type: "answer"; answer: string }
  | { type: "error"; message: string };
