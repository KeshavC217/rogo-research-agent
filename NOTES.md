# Notes

- Added Vitest unit tests under `tests/` for the tools, the agent loop (stubbed model), request logging, the streaming chat endpoint, and a light UI smoke test (stubbed `fetch`).
- Added server-side observability: every model call logs latency, tokens and stop reason, every log line carries a per-request id, and each request ends with a one-line summary of time, calls and tokens.
- Removed the separate editor pass (an extra model call that re-sent the whole transcript) and moved its style guidance into the system prompt, so the model's final turn is the answer.
- Tool calls requested in the same model turn now run concurrently (results still returned in request order), so a turn waits for its slowest tool instead of the sum of all of them.
- Added an LLM-judged eval suite (`npm run eval`, in `evals/`) that runs the agent on eight questions (including follow-ups that rely on chat history) and has Claude Opus 5 score each answer for answering the question, accuracy against the full dataset, and conciseness, alongside latency, tool calls and tokens.
- Chats now carry context: the UI sends prior question/final-answer pairs, and the agent keeps the most recent turns within a ~100k-token sliding window (oldest whole turns dropped first, failed turns never sent).
- Added prompt caching: an explicit breakpoint on the system prompt (tools + system, stable across every request) plus automatic caching of the growing conversation, with cache read/write tokens logged per model call.
- The system prompt now tells the agent to ask one short clarifying question (before researching) when a question is ambiguous or not inferable from the data, and only to make a stated assumption if its clarification goes unresolved, with eval cases covering both steps.
- `/api/chat` now streams the agent's progress events as NDJSON and ends with an `answer` or `error` event, and the UI renders them as a live step list (running, done, or failed with the reason) that stays above each answer instead of a static "Thinking…".
- Added an effort dropdown next to Send (Low = Haiku 4.5, Medium = Sonnet 5, High = Opus 5); the client sends only the effort level and the server maps it to a model id, and a model refusal now returns a plain "can't help" answer.
