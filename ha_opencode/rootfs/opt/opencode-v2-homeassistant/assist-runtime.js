import { randomUUID } from "node:crypto";

// Private plugin adapter. Only an authenticated, scoped facade may expose it to
// HA. HA executes its own tools using the original LLMContext; this runtime has
// no service-call, file, shell or administrative tool fallback.
export async function createAssistRuntime(ctx) {
  const requests = new Map();
  const sessions = new Map();
  const retired = new Set();
  const stop = new AbortController();
  const subscriptions = [];
  let eventStreamHealthy = true;
  const sentinel = "Home Assistant: continue the supplied conversation.";
  function find(id) {
    const request = requests.get(id);
    if (!request) throw new Error("Unknown Assist request");
    return request;
  }
  function push(request, event) {
    if (request.closed) return;
    request.eventBytes += Buffer.byteLength(JSON.stringify(event));
    if (request.events.length >= 4096 || request.eventBytes > 2097152) { void release(request.id).catch(() => {}); return; }
    request.events.push(event);
    request.wake?.();
  }
  subscriptions.push(await ctx.session.hook("context", (event) => {
    const request = sessions.get(event.sessionID);
    if (!request) {
      event.tools = Object.fromEntries(Object.entries(event.tools).filter(([name]) => !/^ha_[a-f0-9]{32}_\d+$/.test(name)));
      if (retired.has(event.sessionID) || event.agent === "home-assistant-assist") throw new Error("Assist request is closed");
      return;
    }
    if (request.closed) throw new Error("Assist request is closed");
    // Remove the add-on's project instructions and preserve only the model/tool
    // continuation after our seed message. HA owns the preceding history.
    const seed = event.messages.findIndex((message) => message.role === "user" &&
      message.content?.some((part) => part.type === "text" && part.text === sentinel));
    if (seed < 0) throw new Error("Assist context boundary is missing");
    event.system = [{ type: "text", text: request.system }];
    event.messages = [...structuredClone(request.messages), ...event.messages.slice(seed + 1)];
    event.tools = Object.fromEntries(Object.entries(event.tools).filter(([name]) => request.names.has(name)));
  }));
  subscriptions.push(await ctx.session.hook("title", (event) => {
    if (sessions.has(event.sessionID)) event.result = "Home Assistant request";
  }));
  subscriptions.push(await ctx.session.hook("compaction", (event) => {
    if (sessions.has(event.sessionID) || event.agent === "home-assistant-assist") throw new Error("HA must manage conversation history limits");
  }));
  const events = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
        if (event.type === "session.deleted") retired.delete(event.data.sessionID);
        const request = sessions.get(event.data?.sessionID);
        if (request && event.type === "session.text.delta") push(request, { type: "text", text: event.data.delta });
        if (request?.started && !request.finished && ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(event.type)) {
          request.finished = true;
          push(request, event.type === "session.execution.succeeded" ? { type: "done" } : { type: "error", code: "generation_failed" });
        }
      }
    } catch { /* A failed event stream invalidates every dependent request. */ }
    finally {
      eventStreamHealthy = false;
      if (!stop.signal.aborted) for (const request of requests.values()) push(request, { type: "error", code: "event_stream_failed" });
    }
  })();

  async function release(id) {
    const request = find(id);
    if (request.releasing) return request.releasing;
    request.closed = true;
    request.wake?.();
    clearTimeout(request.deadline);
    for (const pending of request.pending.values()) pending.reject(new Error("Assist request cancelled"));
    request.pending.clear();
    request.releasing = (async () => {
      // Keep the scope guard until interruption completes. A failed interrupt
      // must not turn a formerly scoped session into an ordinary coding agent.
      retired.add(request.sessionID);
      await ctx.session.interrupt({ sessionID: request.sessionID }).catch(() => {});
      await request.registration?.dispose();
      requests.delete(id);
      sessions.delete(request.sessionID);
      return { sessionID: request.sessionID };
    })();
    return request.releasing;
  }
  return {
    async prepare(input) {
      if (!eventStreamHealthy) throw new Error("Assist event stream unavailable");
      if (input.tools.some(({ name }) => !/^[A-Za-z0-9_-]{1,64}$/.test(name))) throw new Error("Invalid HA tool name");
      if (new Set(input.tools.map(({ name }) => name)).size !== input.tools.length) throw new Error("Duplicate HA tool name");
      for (const message of input.messages) {
        if (!["user", "assistant", "tool"].includes(message.role) || !Array.isArray(message.content)) throw new Error("Invalid HA history");
        for (const part of message.content) {
          if (!["text", "tool-call", "tool-result"].includes(part.type)) throw new Error("Unsupported HA content");
          if (part.type === "text" && typeof part.text !== "string") throw new Error("Invalid HA text");
          if (part.type !== "text") {
            if (typeof part.id !== "string" || part.id.length > 128 || typeof part.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(part.name)) throw new Error("Invalid HA tool history");
            if (part.type === "tool-call" && (message.role !== "assistant" || !part.input || typeof part.input !== "object" || Array.isArray(part.input))) throw new Error("Invalid HA tool call");
            if (part.type === "tool-result" && (message.role !== "tool" || !["text", "json", "error"].includes(part.result?.type) || Object.keys(part.result).some((key) => !["type", "value"].includes(key)))) throw new Error("Invalid HA tool result");
          }
          if (Object.keys(part).some((key) => !["type", "text", "id", "name", "input", "result"].includes(key))) throw new Error("Unsupported HA metadata");
        }
      }
      if (requests.size >= 8 || sessions.has(input.sessionID)) throw new Error("Assist request limit reached");
      if (Buffer.byteLength(JSON.stringify(input)) > 524288) throw new Error("Assist request is too large");
      const id = randomUUID();
      const request = { id, ...input, events: [], eventBytes: 0, pending: new Map(), names: new Set(), closed: false, calls: 0 };
      const names = new Map(input.tools.map((tool, index) => [tool.name, `ha_${id.replaceAll("-", "")}_${index}`]));
      request.messages = input.messages.map((message) => ({ role: message.role, content: message.content.map((part) => (
        part.type === "text" ? { type: "text", text: part.text } : { ...part, name: names.get(part.name) ?? part.name }
      )) }));
      requests.set(id, request);
      sessions.set(input.sessionID, request);
      try {
        request.registration = await ctx.tool.transform((editor) => {
          input.tools.forEach((tool) => {
            const name = names.get(tool.name);
            request.names.add(name);
            editor.add({ name, description: `${tool.name}: ${tool.description}`, input: tool.parameters, options: { codemode: false },
              execute: async (args, context) => {
                if (request.closed || context.sessionID !== request.sessionID) throw new Error("Assist tool scope mismatch");
                if (++request.calls > 32) throw new Error("Assist tool call limit reached");
                context.signal.throwIfAborted();
                const result = await new Promise((resolve, reject) => {
                  const abort = () => { request.pending.delete(context.id); reject(new Error("Assist tool cancelled")); };
                  context.signal.addEventListener("abort", abort, { once: true });
                  request.pending.set(context.id, {
                    resolve: (value) => { context.signal.removeEventListener("abort", abort); resolve(value); },
                    reject: (error) => { context.signal.removeEventListener("abort", abort); reject(error); },
                  });
                  push(request, { type: "tool_call", id: context.id, name: tool.name, arguments: args });
                });
                return { content: JSON.stringify(result) };
              },
            });
          });
        });
        request.deadline = setTimeout(() => { void release(id).catch(() => {}); }, 120000).unref();
        return { requestID: id, permissions: [
          { action: "*", resource: "*", effect: "deny" },
          ...[...request.names].map((action) => ({ action, resource: "*", effect: "allow" })),
        ] };
      } catch (error) { await release(id); throw error; }
    },
    async start({ requestID }) {
      const request = find(requestID);
      if (request.started || request.closed) throw new Error("Assist request already started");
      request.started = true;
      await ctx.session.prompt({ sessionID: request.sessionID, text: sentinel });
      return { started: true };
    },
    async poll({ requestID }, { signal }) {
      const request = find(requestID);
      if (request.polling) throw new Error("Assist poll already active");
      request.polling = true;
      try {
        if (!request.events.length && !request.closed) await new Promise((resolve) => {
          const timer = setTimeout(done, 20000);
          function done() { clearTimeout(timer); signal.removeEventListener("abort", done); request.wake = null; resolve(); }
          request.wake = done;
          if (signal.aborted) done(); else signal.addEventListener("abort", done, { once: true });
        });
        request.eventBytes = 0;
        return { events: request.events.splice(0) };
      } finally { request.polling = false; }
    },
    async result({ requestID, callID, result }) {
      const request = find(requestID);
      const pending = request.pending.get(callID);
      if (!pending || request.closed) throw new Error("Unknown or completed Assist tool call");
      if (Buffer.byteLength(JSON.stringify(result)) > 131072) throw new Error("Assist tool result too large");
      request.pending.delete(callID);
      pending.resolve(result);
      return { accepted: true };
    },
    release: ({ requestID }) => release(requestID),
    async close() {
      stop.abort();
      await events;
      await Promise.allSettled([...requests.keys()].map(release));
      for (const subscription of subscriptions.reverse()) await subscription.dispose();
    },
    sentinel,
  };
}
