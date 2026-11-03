// A tiny local stand-in for an OpenAI-compatible chat completions endpoint, so
// Durable provider tests run a real Harness without any network. It answers
// `POST /v1/chat/completions` with an SSE stream:
//   - when the last message is a user message containing `TOOL <name> <json>`,
//     one `tool_calls` delta calling <name> with <json> as arguments;
//   - otherwise text chunks of `reply(request)` (default: "ok: <last user text>").
// `hold()` makes the next responses wait until `release()`, so a test can act
// while a run is in flight. Every request body is kept in `requests`.
import { createServer } from "node:http";

const lastUserText = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return "";
  }
  return "";
};

export async function startFakeOpenAI({ reply, chunkSize = 4 } = {}) {
  const requests = [];
  let gate = null; // { promise, resolve } while held
  let calls = 0;
  const waiters = [];

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    calls += 1;
    for (const w of waiters.splice(0)) w();
    if (gate) await gate.promise;

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const base = { id: `chatcmpl-${calls}`, object: "chat.completion.chunk", created: 1, model: body.model };
    const messages = body.messages ?? [];
    const last = messages.at(-1);
    const toolAsk = last?.role === "user" ? /TOOL (\w+) (\{.*\})/s.exec(lastUserText(messages)) : null;
    if (toolAsk) {
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: toolAsk[1], arguments: toolAsk[2] } }] }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      const text = reply ? reply(body) : `ok: ${lastUserText(messages)}`;
      for (let i = 0; i < text.length; i += chunkSize) {
        send({ ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + chunkSize) }, finish_reason: null }] });
      }
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    send({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    get calls() {
      return calls;
    },
    /** Resolve once at least `n` requests have arrived. */
    waitForCalls(n) {
      if (calls >= n) return Promise.resolve();
      return new Promise((resolve) => {
        const check = () => (calls >= n ? resolve() : waiters.push(check));
        waiters.push(check);
      });
    },
    hold() {
      if (gate) return;
      let resolve;
      const promise = new Promise((r) => (resolve = r));
      gate = { promise, resolve };
    },
    release() {
      const g = gate;
      gate = null;
      g?.resolve();
    },
    close() {
      this.release();
      server.closeAllConnections?.();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

/** A models.json pointing one openai-completions provider at the fake (literal key, no env). */
export function fakeModelsJson(baseUrl, { provider = "fake", modelId = "fake-model" } = {}) {
  return {
    providers: {
      [provider]: {
        baseUrl,
        api: "openai-completions",
        apiKey: "test-key",
        models: [{ id: modelId, contextWindow: 32000, maxTokens: 1024 }],
      },
    },
  };
}
