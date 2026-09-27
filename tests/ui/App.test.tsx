// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamEvent } from "../../src/protocol.ts";
import { App } from "../../src/ui/App.tsx";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ndjson = (events: ChatStreamEvent[]) => events.map((e) => JSON.stringify(e) + "\n").join("");

/** Responds with a complete NDJSON stream. `{answer}` / `{error}` become the final event. */
function respondWith(body: { answer?: string; error?: string }, status = 200) {
  const final: ChatStreamEvent =
    body.answer !== undefined
      ? { type: "answer", answer: body.answer }
      : { type: "error", message: body.error ?? "" };
  fetchMock.mockResolvedValue(new Response(ndjson([final]), { status }));
}

/** Responds with a stream the test pushes events into one at a time. */
function respondWithLiveStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
  fetchMock.mockResolvedValue(new Response(body));
  const encoder = new TextEncoder();
  return {
    push: (event: ChatStreamEvent) => controller.enqueue(encoder.encode(ndjson([event]))),
    close: () => controller.close(),
  };
}

async function ask(question: string) {
  await userEvent.type(screen.getByPlaceholderText(/ask a research question/i), question);
  await userEvent.click(screen.getByRole("button", { name: /send/i }));
}

describe("App", () => {
  it("renders the composer and example questions", () => {
    render(<App />);

    expect(screen.getByPlaceholderText(/ask a research question/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /send/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /compare acme and globex/i })).toBeTruthy();
  });

  it("sends the question and shows the answer", async () => {
    respondWith({ answer: "Acme grew 5.5% in FY2025." });
    render(<App />);

    await userEvent.type(screen.getByPlaceholderText(/ask a research question/i), "Acme growth?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText("Acme grew 5.5% in FY2025.")).toBeTruthy();
    expect(screen.getByText("Acme growth?")).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/chat");
    expect(JSON.parse(init.body)).toEqual({ message: "Acme growth?", history: [] });
  });

  it("sends earlier questions and answers as history on follow-ups", async () => {
    const input = () => screen.getByPlaceholderText(/ask a research question/i);
    respondWith({ answer: "Initech grew 14.8%." });
    render(<App />);
    await userEvent.type(input(), "How is Initech?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    await screen.findByText("Initech grew 14.8%.");

    respondWith({ answer: "Margins are 74.8%." });
    await userEvent.type(input(), "And margins?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    await screen.findByText("Margins are 74.8%.");

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body).toEqual({
      message: "And margins?",
      history: [{ question: "How is Initech?", answer: "Initech grew 14.8%." }],
    });
  });

  it("does not send failed turns as history", async () => {
    const input = () => screen.getByPlaceholderText(/ask a research question/i);
    respondWith({ error: "model overloaded" });
    render(<App />);
    await userEvent.type(input(), "How is Initech?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    await screen.findByText(/model overloaded/);

    respondWith({ answer: "ok" });
    await userEvent.type(input(), "Try again");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    await screen.findByText("ok");

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).history).toEqual([]);
  });

  it("sends an example question when clicked", async () => {
    respondWith({ answer: "Initech is doing fine." });
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /initech's subscription/i }));

    expect(await screen.findByText("Initech is doing fine.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not send an empty question", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a pending state while waiting and disables the composer", async () => {
    const stream = respondWithLiveStream();
    render(<App />);

    await ask("Acme?");

    expect(await screen.findByText(/thinking/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);

    stream.push({ type: "answer", answer: "done" });
    stream.close();
    expect(await screen.findByText("done")).toBeTruthy();
    expect(screen.queryByText(/thinking/i)).toBeNull();
  });

  it("shows each research step live as the agent works", async () => {
    const stream = respondWithLiveStream();
    render(<App />);
    await ask("Umbrella risks?");

    const input = { query: "risk factors", company: "Umbrella Health" };
    stream.push({ type: "tool_start", id: "t1", name: "searchDocuments", input });
    expect(
      await screen.findByText('Searching documents: "risk factors" (Umbrella Health)…'),
    ).toBeTruthy();

    stream.push({ type: "tool_end", id: "t1", name: "searchDocuments", ms: 700 });
    expect(
      await screen.findByText('Searched documents: "risk factors" (Umbrella Health)'),
    ).toBeTruthy();

    stream.push({ type: "answer", answer: "Acquisitions are the main risk." });
    stream.close();
    expect(await screen.findByText("Acquisitions are the main risk.")).toBeTruthy();
  });

  it("keeps the steps above the answer, outside its bubble, once it arrives", async () => {
    const stream = respondWithLiveStream();
    render(<App />);
    await ask("Umbrella risks?");

    const input = { query: "risk factors", company: "Umbrella Health" };
    stream.push({ type: "tool_start", id: "t1", name: "searchDocuments", input });
    stream.push({ type: "tool_end", id: "t1", name: "searchDocuments", ms: 700 });
    stream.push({ type: "answer", answer: "Acquisitions are the main risk." });
    stream.close();

    const answer = await screen.findByText("Acquisitions are the main risk.");
    const step = screen.getByText('Searched documents: "risk factors" (Umbrella Health)');
    expect(step.closest(".bubble")).toBeNull();
    // The step list sits immediately before the answer bubble.
    expect(answer.previousElementSibling?.contains(step)).toBe(true);
    expect(screen.queryByText(/thinking/i)).toBeNull();
  });

  it("keeps each answer's steps separate across a conversation", async () => {
    let stream = respondWithLiveStream();
    render(<App />);
    await ask("Initech?");
    stream.push({ type: "tool_start", id: "a", name: "getFinancials", input: { company: "Initech" } });
    stream.push({ type: "tool_end", id: "a", name: "getFinancials", ms: 1 });
    stream.push({ type: "answer", answer: "first" });
    stream.close();
    await screen.findByText("first");

    stream = respondWithLiveStream();
    await ask("Acme?");
    stream.push({ type: "tool_start", id: "b", name: "getFinancials", input: { company: "Acme Corp" } });
    stream.push({ type: "tool_end", id: "b", name: "getFinancials", ms: 1 });
    stream.push({ type: "answer", answer: "second" });
    stream.close();
    await screen.findByText("second");

    const lists = screen.getAllByRole("list", { name: /research steps/i });
    expect(lists.map((l) => l.textContent)).toEqual([
      "✓Loaded financials (Initech)",
      "✓Loaded financials (Acme Corp)",
    ]);
  });

  it("shows no step list for answers that needed no research", async () => {
    respondWith({ answer: "Which Acme do you mean?" });
    render(<App />);
    await ask("Compare Acme and Globex");

    await screen.findByText("Which Acme do you mean?");
    expect(screen.queryByRole("list", { name: /research steps/i })).toBeNull();
  });

  it("marks failed steps with the reason", async () => {
    const stream = respondWithLiveStream();
    render(<App />);
    await ask("Acme revenue?");

    stream.push({ type: "tool_start", id: "t1", name: "getFinancials", input: { company: "Acme" } });
    stream.push({ type: "tool_failed", id: "t1", name: "getFinancials", message: "no financials found" });
    stream.push({ type: "tool_end", id: "t1", name: "getFinancials", ms: 800 });

    expect(await screen.findByText(/no financials found/)).toBeTruthy();
    const step = screen.getByText(/no financials found/).closest("li")!;
    expect(step.className).toContain("failed");
    expect(step.textContent).toContain("Loading financials (Acme)");
    expect(step.textContent).not.toContain("Loaded");
    stream.close();
  });

  it("tracks parallel calls to the same tool separately", async () => {
    const stream = respondWithLiveStream();
    render(<App />);
    await ask("Compare");

    stream.push({ type: "tool_start", id: "a", name: "getFinancials", input: { company: "Acme Corp" } });
    stream.push({ type: "tool_start", id: "b", name: "getFinancials", input: { company: "Globex Inc" } });
    stream.push({ type: "tool_end", id: "b", name: "getFinancials", ms: 800 });

    expect(await screen.findByText("Loaded financials (Globex Inc)")).toBeTruthy();
    expect(screen.getByText("Loading financials (Acme Corp)…")).toBeTruthy();
    stream.close();
  });

  it("reports a stream that ends without an answer", async () => {
    const stream = respondWithLiveStream();
    render(<App />);
    await ask("Acme?");

    stream.close();

    expect(await screen.findByText(/closed before an answer/i)).toBeTruthy();
  });

  it("reports a non-streaming HTTP failure", async () => {
    fetchMock.mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
    render(<App />);
    await ask("Acme?");

    expect(await screen.findByText(/responded 502/)).toBeTruthy();
  });

  it("shows server errors instead of an empty bubble", async () => {
    respondWith({ error: "model overloaded" });
    render(<App />);

    await userEvent.type(screen.getByPlaceholderText(/ask a research question/i), "Acme?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText(/model overloaded/)).toBeTruthy();
  });

  it("shows network failures", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<App />);

    await userEvent.type(screen.getByPlaceholderText(/ask a research question/i), "Acme?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText(/something went wrong/i)).toBeTruthy();
  });
});
