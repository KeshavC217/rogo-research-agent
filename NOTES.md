# Notes

- Added Vitest unit tests under `tests/` for the tools, the agent loop (stubbed model), request logging, and a light UI smoke test (stubbed `fetch`).
- Added server-side observability: every model call (including the editor pass) logs latency, tokens and stop reason, every log line carries a per-request id, and each request ends with a one-line summary of time, calls and tokens.
