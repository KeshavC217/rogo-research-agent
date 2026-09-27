import { Fragment, useState } from "react";
import { DEFAULT_EFFORT, EFFORTS, isEffort, type Effort } from "../models.ts";
import type { ChatStreamEvent } from "../protocol.ts";
import { applyEvent, stepLabel, type Step } from "./steps.ts";
import { readEvents } from "./stream.ts";

interface Message {
  role: "user" | "assistant";
  text: string;
  /** Error replies are shown but never sent back to the agent as history. */
  error?: boolean;
  /** Research steps the agent took for this reply, shown above it. */
  steps?: Step[];
}

interface ChatTurn {
  question: string;
  answer: string;
}

/** Pairs each question with the answer that followed it, skipping failed turns. */
function toHistory(messages: Message[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  messages.forEach((m, i) => {
    const reply = messages[i + 1];
    if (m.role === "user" && reply?.role === "assistant" && !reply.error) {
      turns.push({ question: m.text, answer: reply.text });
    }
  });
  return turns;
}

/**
 * Posts the question and streams progress events to `onEvent` until the final
 * answer (or an error) arrives. Always resolves to a message to show.
 */
async function ask(
  question: string,
  history: ChatTurn[],
  effort: Effort,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<Message> {
  const failed = (text: string): Message => ({ role: "assistant", text, error: true });

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question, history, effort }),
    });
    if (!res.ok || !res.body) {
      return failed(`Something went wrong: the server responded ${res.status}.`);
    }

    for await (const event of readEvents(res.body)) {
      if (event.type === "answer") return { role: "assistant", text: event.answer };
      if (event.type === "error") return failed(event.message);
      onEvent(event);
    }
    return failed("Something went wrong: the connection closed before an answer arrived.");
  } catch (err) {
    return failed(`Something went wrong: ${String(err)}`);
  }
}

const STATUS_ICON: Record<Step["status"], string> = { running: "⋯", done: "✓", failed: "✗" };

/**
 * The agent's research steps, shown above its reply. While `thinking`, a
 * "Thinking…" line shows whenever no tool is running.
 */
function StepList({ steps, thinking = false }: { steps: Step[]; thinking?: boolean }) {
  return (
    <ul className="steps" aria-label="Research steps">
      {steps.map((step) => (
        <li key={step.id} className={`step ${step.status}`}>
          <span className="icon">{STATUS_ICON[step.status]}</span>
          {stepLabel(step)}
          {step.error && <span className="step-error"> — {step.error}</span>}
        </li>
      ))}
      {thinking && !steps.some((s) => s.status === "running") && (
        <li className="step running">
          <span className="icon">⋯</span>
          Thinking…
        </li>
      )}
    </ul>
  );
}

const EXAMPLES = [
  "Compare Acme and Globex and tell me which one appears to be growing faster.",
  "What are the biggest risks Umbrella Health flags in its filings?",
  "How is Initech's subscription transition going?",
  "Which company in the universe is growing fastest?",
];

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [effort, setEffort] = useState<Effort>(DEFAULT_EFFORT);

  async function send(question: string) {
    if (!question.trim() || busy) return;

    const history = toHistory(messages);
    setMessages((prev) => [...prev, { role: "user", text: question }]);
    setInput("");
    setBusy(true);

    // Track steps locally too, so the finished list can be attached to the reply.
    let current: Step[] = [];
    setSteps(current);

    const reply = await ask(question, history, effort, (event) => {
      current = applyEvent(current, event);
      setSteps(current);
    });
    setMessages((prev) => [...prev, { ...reply, steps: current }]);

    setBusy(false);
  }

  return (
    <div className="app">
      <header>
        <h1>Rogo Research</h1>
        <p>Ask a question about a company in our coverage universe.</p>
      </header>

      <div className="transcript">
        {messages.length === 0 && (
          <div className="examples">
            {EXAMPLES.map((example) => (
              <button key={example} onClick={() => send(example)}>
                {example}
              </button>
            ))}
          </div>
        )}

        {messages.map((message, i) => (
          <Fragment key={i}>
            {message.steps?.length ? <StepList steps={message.steps} /> : null}
            <div className={`bubble ${message.role}`}>{message.text}</div>
          </Fragment>
        ))}

        {busy && <StepList steps={steps} thinking />}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a research question…"
          disabled={busy}
        />
        <select
          aria-label="Effort"
          title="Effort: which model answers"
          value={effort}
          onChange={(e) => isEffort(e.target.value) && setEffort(e.target.value)}
          disabled={busy}
        >
          {Object.entries(EFFORTS).map(([value, { label, modelName }]) => (
            <option key={value} value={value}>
              {label} · {modelName}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy}>
          Send
        </button>
      </form>
    </div>
  );
}
