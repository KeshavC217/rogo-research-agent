/**
 * Turns the agent's tool events into the live step list shown while it works.
 */

import type { ChatStreamEvent } from "../protocol.ts";

export interface Step {
  id: string;
  name: string;
  input: unknown;
  status: "running" | "done" | "failed";
  error?: string;
}

/**
 * The label for a step in its current state. Failed steps keep the in-progress
 * wording ("Loading financials (Acme)") so they don't read as if they succeeded.
 */
export function stepLabel(step: Step): string {
  if (step.status === "failed") return describeTool(step.name, step.input, true).replace(/…$/, "");
  return describeTool(step.name, step.input, step.status === "running");
}

type Input = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Human-readable description of a tool call, in progress or finished. */
export function describeTool(name: string, input: unknown, running: boolean): string {
  const i = (input ?? {}) as Input;
  const company = str(i.company);
  const query = str(i.query);
  const suffix = company ? ` (${company})` : "";

  switch (name) {
    case "searchCompanies":
      return running ? `Looking up "${query ?? ""}"…` : `Looked up "${query ?? ""}"`;
    case "getCompanyProfile":
      return running ? `Loading company profile${suffix}…` : `Loaded company profile${suffix}`;
    case "getFinancials":
      return running ? `Loading financials${suffix}…` : `Loaded financials${suffix}`;
    case "searchDocuments":
      return running
        ? `Searching documents: "${query ?? ""}"${suffix}…`
        : `Searched documents: "${query ?? ""}"${suffix}`;
    default:
      return running ? `Running ${name}…` : `Ran ${name}`;
  }
}

/** Applies one stream event to the step list. Non-tool events leave it unchanged. */
export function applyEvent(steps: Step[], event: ChatStreamEvent): Step[] {
  switch (event.type) {
    case "tool_start":
      return [
        ...steps,
        { id: event.id, name: event.name, input: event.input, status: "running" },
      ];
    case "tool_failed":
      return steps.map((s) =>
        s.id === event.id ? { ...s, status: "failed", error: event.message } : s,
      );
    case "tool_end":
      // tool_end follows tool_failed for failed calls; keep them marked failed.
      return steps.map((s) =>
        s.id === event.id && s.status === "running" ? { ...s, status: "done" } : s,
      );
    default:
      return steps;
  }
}
