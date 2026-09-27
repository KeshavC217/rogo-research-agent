import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, ToolError, toolSchemas } from "./tools.ts";

// Tools sleep to simulate API latency; fake timers keep the suite fast.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function run(name: string, input: Record<string, unknown>) {
  const promise = executeTool(name, input);
  // Attach a no-op handler so a rejection isn't reported as unhandled while timers run.
  promise.catch(() => {});
  await vi.runAllTimersAsync();
  return promise;
}

describe("toolSchemas", () => {
  it("has a schema for every tool executeTool handles", () => {
    expect(toolSchemas.map((t) => t.name).sort()).toEqual(
      ["getCompanyProfile", "getFinancials", "searchCompanies", "searchDocuments"],
    );
  });

  it("marks every required field as a declared property", () => {
    for (const tool of toolSchemas) {
      const props = Object.keys(tool.input_schema.properties ?? {});
      for (const field of tool.input_schema.required ?? []) {
        expect(props).toContain(field);
      }
    }
  });
});

describe("searchCompanies", () => {
  it("matches a partial name case-insensitively", async () => {
    const result = (await run("searchCompanies", { query: "acme" })) as { name: string }[];
    expect(result.map((r) => r.name).sort()).toEqual(["Acme Corp", "Acme Robotics"]);
  });

  it("returns name, ticker and sector only", async () => {
    const [result] = (await run("searchCompanies", { query: "Initech" })) as object[];
    expect(result).toEqual({ name: "Initech", ticker: "ITCH", sector: "Enterprise Software" });
  });

  it("returns an empty list when nothing matches", async () => {
    expect(await run("searchCompanies", { query: "Hooli" })).toEqual([]);
  });
});

describe("getCompanyProfile", () => {
  it("returns the full profile for a known company", async () => {
    const profile = (await run("getCompanyProfile", { company: "Globex Inc" })) as {
      ticker: string;
      segments: unknown[];
    };
    expect(profile.ticker).toBe("GLBX");
    expect(profile.segments.length).toBeGreaterThan(0);
  });

  it("throws a ToolError for an unknown company", async () => {
    await expect(run("getCompanyProfile", { company: "Hooli" })).rejects.toBeInstanceOf(
      ToolError,
    );
  });
});

describe("getFinancials", () => {
  it("returns annual and quarterly figures for a known company", async () => {
    const record = (await run("getFinancials", { company: "Acme Corp" })) as {
      ticker: string;
      annual: unknown[];
      quarterly: unknown[];
    };
    expect(record.ticker).toBe("ACME");
    expect(record.annual.length).toBeGreaterThan(0);
    expect(record.quarterly.length).toBeGreaterThan(0);
  });

  it("throws a ToolError for an unknown company", async () => {
    await expect(run("getFinancials", { company: "Hooli" })).rejects.toBeInstanceOf(ToolError);
  });
});

describe("searchDocuments", () => {
  it("finds documents by keyword", async () => {
    const docs = (await run("searchDocuments", { query: "risk factors" })) as { id: string }[];
    expect(docs.map((d) => d.id)).toContain("DOC-ACME-002");
  });

  it("restricts results to one company when asked", async () => {
    const docs = (await run("searchDocuments", {
      query: "earnings call",
      company: "Umbrella Health",
    })) as { company: string }[];
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((d) => d.company === "Umbrella Health")).toBe(true);
  });

  it("ranks documents matching more terms first", async () => {
    const docs = (await run("searchDocuments", { query: "Initech preliminary FY2025" })) as {
      id: string;
    }[];
    expect(docs[0].id).toBe("DOC-ITCH-001");
  });

  it("returns at most five documents", async () => {
    const docs = (await run("searchDocuments", { query: "FY2025" })) as unknown[];
    expect(docs.length).toBeLessThanOrEqual(5);
  });

  it("returns an empty list when nothing matches", async () => {
    expect(await run("searchDocuments", { query: "zzzzzz" })).toEqual([]);
  });

  it("matches keywords case-insensitively and ignores extra whitespace", async () => {
    const docs = (await run("searchDocuments", { query: "  RISK   factors " })) as {
      id: string;
    }[];
    expect(docs.map((d) => d.id)).toContain("DOC-ACME-002");
  });

  it("does not leak other companies' documents through the company filter", async () => {
    const docs = await run("searchDocuments", { query: "Globex", company: "Initech" });
    expect(docs).toEqual([]);
  });

  it("accepts exactly six terms", async () => {
    await expect(
      run("searchDocuments", { query: "one two three four five six" }),
    ).resolves.toBeDefined();
  });

  it("rejects queries longer than six terms", async () => {
    await expect(
      run("searchDocuments", { query: "one two three four five six seven" }),
    ).rejects.toBeInstanceOf(ToolError);
  });
});

describe("executeTool", () => {
  it("throws a ToolError for an unknown tool", async () => {
    await expect(run("deleteEverything", {})).rejects.toBeInstanceOf(ToolError);
  });
});
