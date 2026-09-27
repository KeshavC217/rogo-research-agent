import type { ChatStreamEvent } from "../protocol.ts";

/** Yields each event from an NDJSON response body as it arrives. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    // Emit every complete line; keep a trailing partial line for the next chunk.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line) as ChatStreamEvent;
    }

    if (done) break;
  }
  if (buffer.trim()) yield JSON.parse(buffer) as ChatStreamEvent;
}
