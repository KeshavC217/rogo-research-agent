# Notes

- Added Vitest unit tests under `tests/` for the tools, the agent loop (stubbed model), request logging, and a light UI smoke test (stubbed `fetch`).
- Added server-side observability: every model call logs latency, tokens and stop reason, every log line carries a per-request id, and each request ends with a one-line summary of time, calls and tokens.
- Removed the separate editor pass (an extra model call that re-sent the whole transcript) and moved its style guidance into the system prompt, so the model's final turn is the answer.
