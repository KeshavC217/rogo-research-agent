// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function respondWith(body: object, status = 200) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
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
    expect(JSON.parse(init.body)).toMatchObject({ message: "Acme growth?" });
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
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    render(<App />);

    await userEvent.type(screen.getByPlaceholderText(/ask a research question/i), "Acme?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(screen.getByText(/thinking/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);

    resolve(new Response(JSON.stringify({ answer: "done" })));
    expect(await screen.findByText("done")).toBeTruthy();
    expect(screen.queryByText(/thinking/i)).toBeNull();
  });

  it("shows server errors instead of an empty bubble", async () => {
    respondWith({ error: "model overloaded" }, 500);
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
