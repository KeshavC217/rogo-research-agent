import "dotenv/config";
import express from "express";
import { runAgent, type ChatTurn } from "./agent.ts";
import { createRequestLog } from "./requestLog.ts";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "\nANTHROPIC_API_KEY is not set.\nCopy .env.example to .env and add your key, then run `npm run dev` again.\n",
  );
  process.exit(1);
}

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

const app = express();
app.use(express.json());

app.post("/api/chat", async (req, res) => {
  const message = String(req.body.message ?? "");
  const history = parseHistory(req.body.history);
  const log = createRequestLog();
  log.start(message);

  try {
    const result = await runAgent(message, log.onEvent, history);
    log.done();
    res.json({ answer: result.answer });
  } catch (err) {
    log.error(err);
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`Agent server listening on http://localhost:${port}`);
});
