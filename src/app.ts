import express from "express";
import { runAgent, type ChatTurn } from "./agent.ts";
import { EFFORTS, isEffort } from "./models.ts";
import type { ChatStreamEvent } from "./protocol.ts";
import { createRequestLog } from "./requestLog.ts";

/** Prior turns sent by the client. Anything malformed is ignored rather than trusted. */
function parseHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (t): t is ChatTurn =>
        typeof t?.question === "string" && typeof t?.answer === "string",
    )
    .map((t) => ({ question: t.question, answer: t.answer }));
}

export function createApp() {
  const app = express();
  app.use(express.json());

  app.post("/api/chat", async (req, res) => {
    const message = String(req.body.message ?? "");
    const history = parseHistory(req.body.history);
    // Unknown or missing effort falls back to the agent's default model.
    const effort: unknown = req.body.effort;
    const model = isEffort(effort) ? EFFORTS[effort].model : undefined;
    const log = createRequestLog();
    log.start(message);

    // Stream progress as NDJSON so the UI can show what the agent is doing.
    res.status(200).setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();
    const send = (event: ChatStreamEvent) => res.write(`${JSON.stringify(event)}\n`);

    try {
      const result = await runAgent(
        message,
        (event) => {
          log.onEvent(event);
          send(event);
        },
        history,
        model,
      );
      log.done();
      send({ type: "answer", answer: result.answer });
    } catch (err) {
      log.error(err);
      console.error(err);
      // Headers are already sent, so the failure is reported in-stream.
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    res.end();
  });

  return app;
}
