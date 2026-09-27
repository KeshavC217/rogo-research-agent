import { describe, expect, it } from "vitest";
import { applyEvent, describeTool, stepLabel, type Step } from "../../src/ui/steps.ts";
import { readEvents } from "../../src/ui/stream.ts";

describe("describeTool", () => {
  it.each([
    ["searchCompanies", { query: "acme" }, 'Looking up "acme"…', 'Looked up "acme"'],
    ["getCompanyProfile", { company: "Initech" }, "Loading company profile (Initech)…", "Loaded company profile (Initech)"],
    ["getFinancials", { company: "Initech" }, "Loading financials (Initech)…", "Loaded financials (Initech)"],
    [
      "searchDocuments",
      { query: "risk factors", company: "Umbrella Health" },
      'Searching documents: "risk factors" (Umbrella Health)…',
      'Searched documents: "risk factors" (Umbrella Health)',
    ],
    ["searchDocuments", { query: "margins" }, 'Searching documents: "margins"…', 'Searched documents: "margins"'],
    ["somethingNew", {}, "Running somethingNew…", "Ran somethingNew"],
  ])("%s %j", (name, input, running, done) => {
    expect(describeTool(name, input, true)).toBe(running);
    expect(describeTool(name, input, false)).toBe(done);
  });
});

describe("applyEvent", () => {
  const start = (id: string) =>
    ({ type: "tool_start", id, name: "getFinancials", input: { company: id } }) as const;

  it("adds a running step on tool_start and completes it on tool_end", () => {
    let steps: Step[] = applyEvent([], start("a"));
    expect(steps).toMatchObject([{ id: "a", status: "running" }]);

    steps = applyEvent(steps, { type: "tool_end", id: "a", name: "getFinancials", ms: 5 });
    expect(steps).toMatchObject([{ id: "a", status: "done" }]);
    expect(stepLabel(steps[0])).toBe("Loaded financials (a)");
  });

  it("keeps a failed step failed when its tool_end arrives", () => {
    let steps = applyEvent([], start("a"));
    steps = applyEvent(steps, { type: "tool_failed", id: "a", name: "getFinancials", message: "nope" });
    steps = applyEvent(steps, { type: "tool_end", id: "a", name: "getFinancials", ms: 5 });

    expect(steps[0]).toMatchObject({ status: "failed", error: "nope" });
    expect(stepLabel(steps[0])).toBe("Loading financials (a)");
  });

  it("only updates the step whose id matches", () => {
    let steps = applyEvent(applyEvent([], start("a")), start("b"));
    steps = applyEvent(steps, { type: "tool_end", id: "b", name: "getFinancials", ms: 5 });

    expect(steps.map((s) => s.status)).toEqual(["running", "done"]);
  });

  it("ignores non-tool events", () => {
    const steps = applyEvent([], start("a"));
    expect(applyEvent(steps, { type: "iteration", n: 2 })).toBe(steps);
  });
});

describe("readEvents", () => {
  function streamOf(...chunks: string[]) {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
        c.close();
      },
    });
  }

  async function collect(body: ReadableStream<Uint8Array>) {
    const out = [];
    for await (const e of readEvents(body)) out.push(e);
    return out;
  }

  it("parses one event per line", async () => {
    const events = await collect(
      streamOf('{"type":"iteration","n":1}\n{"type":"answer","answer":"hi"}\n'),
    );
    expect(events).toEqual([
      { type: "iteration", n: 1 },
      { type: "answer", answer: "hi" },
    ]);
  });

  it("reassembles events split across chunks", async () => {
    const events = await collect(streamOf('{"type":"ans', 'wer","answer":"a\\nb"}\n'));
    expect(events).toEqual([{ type: "answer", answer: "a\nb" }]);
  });

  it("handles a final event with no trailing newline", async () => {
    const events = await collect(streamOf('{"type":"answer","answer":"x"}'));
    expect(events).toEqual([{ type: "answer", answer: "x" }]);
  });
});
