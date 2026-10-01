import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistRpc } from "../rootfs/opt/opencode-v2-homeassistant/assist-rpc.js";
import { startAssistFixture } from "./helpers/assist-fixture.mjs";

test("Assist adapter proves scoped structured calls, streamed text and cancellation with pinned V2", { timeout: 45000 }, async () => {
  const fixture = await startAssistFixture(async (body, emit) => {
    const result = body.messages.findLast(({ role }) => role === "tool");
    if (result) {
      emit({ role: "assistant", content: `Completed ${result.content}` }); emit({}, "stop"); return;
    }
    const tool = body.tools?.find(({ function: fn }) => fn.name.startsWith("ha_"))?.function;
    if (!tool) { emit({ role: "assistant", content: "No scoped tool" }); emit({}, "stop"); return; }
    emit({ role: "assistant", content: "Checking " });
    emit({ tool_calls: [{ index: 0, id: `call_${tool.name}`, type: "function", function: { name: tool.name, arguments: '{"name":"Fixture"}' } }] });
    emit({}, "tool_calls");
  });
  const { client } = fixture;
  const rpc = client.rpc(AssistRpc);
  const sessions = [];
  const requests = [];
  try {
    await client.agent.list();
    const prepare = async (label) => {
      const session = await client.session.create({ title: "HA adapter fixture", agent: "home-assistant-assist", permissions: [{ action: "*", resource: "*", effect: "deny" }] });
      sessions.push(session.id);
      const prepared = await rpc.prepare({ sessionID: session.id, system: `Only ${label} context`,
        messages: [{ role: "user", content: [{ type: "text", text: `Question for ${label}` }] }],
        tools: [{ name: `${label}Read`, description: `Only ${label} tool`, parameters: { type: "object", properties: { name: { type: "string", pattern: "^Fixture$" } }, required: ["name"] } }],
      });
      requests.push(prepared.requestID);
      await client.session.update({ sessionID: session.id, permissions: prepared.permissions });
      await rpc.start({ requestID: prepared.requestID });
      return { session, ...prepared };
    };
    const [a, b] = await Promise.all([prepare("A"), prepare("B")]);
    const collectCall = async (request) => {
      const events = [];
      while (!events.some(({ type }) => type === "tool_call")) {
        const result = await rpc.poll({ requestID: request.requestID }, { signal: AbortSignal.timeout(10000) });
        events.push(...result.events);
      }
      assert.ok(events.some(({ type, text }) => type === "text" && text === "Checking "), JSON.stringify(events));
      return events.find(({ type }) => type === "tool_call");
    };
    const [acall, bcall] = await Promise.all([collectCall(a), collectCall(b)]);
    assert.equal(acall.name, "ARead"); assert.equal(bcall.name, "BRead");
    assert.deepEqual(acall.arguments, { name: "Fixture" });
    await assert.rejects(rpc.result({ requestID: a.requestID, callID: bcall.id, result: { data: "wrong" } }));
    await rpc.result({ requestID: a.requestID, callID: acall.id, result: { data: "A answer", error: false } });
    await client.session.wait({ sessionID: a.session.id }, { signal: AbortSignal.timeout(10000) });
    await rpc.release({ requestID: b.requestID }); requests.splice(requests.indexOf(b.requestID), 1);
    await client.session.wait({ sessionID: b.session.id }, { signal: AbortSignal.timeout(10000) });
    const final = await rpc.poll({ requestID: a.requestID }, { signal: AbortSignal.timeout(10000) });
    assert.ok(final.events.some(({ text }) => text?.includes("A answer")), JSON.stringify(final));
    assert.ok(fixture.requests.length >= 3);
    for (const body of fixture.requests) {
      assert.equal(body.tools.length, 1);
      assert.match(body.tools[0].function.name, /^ha_/);
      assert.ok(!JSON.stringify(body.messages).includes("You are a coding agent"));
      const serialized = JSON.stringify(body.messages);
      assert.notEqual(serialized.includes("Only A context"), serialized.includes("Only B context"));
      if (serialized.includes("Only A context")) assert.ok(!serialized.includes("Question for B"));
    }
  } finally {
    for (const requestID of requests) await rpc.release({ requestID }).catch(() => {});
    for (const sessionID of sessions) await client.session.remove({ sessionID }).catch(() => {});
    await fixture.close();
  }
});
