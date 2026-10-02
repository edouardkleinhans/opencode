import { Rpc } from "@opencode/plugin/rpc";

const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const id = { type: "string", minLength: 1, maxLength: 128 };
const text = { type: "string", maxLength: 131072 };
const tool = object({ name: { type: "string", minLength: 1, maxLength: 64 }, description: text, parameters: { type: "object" } });
export const AssistRpc = Rpc.define({
  id: "homeassistant.assist",
  events: {},
  methods: {
    prepare: {
      input: object({ sessionID: id, system: text,
        messages: { type: "array", minItems: 1, maxItems: 256, items: { type: "object" } },
        tools: { type: "array", maxItems: 128, items: tool } }),
      output: object({ requestID: id, permissions: { type: "array", items: { type: "object" } } }),
    },
    poll: { input: object({ requestID: id }), output: object({ events: { type: "array", items: { type: "object" } } }) },
    start: { input: object({ requestID: id }), output: object({ started: { type: "boolean" } }) },
    result: { input: object({ requestID: id, callID: id, result: { type: "object" } }), output: object({ accepted: { type: "boolean" } }) },
    release: { input: object({ requestID: id }), output: object({ sessionID: id }) },
  },
});
