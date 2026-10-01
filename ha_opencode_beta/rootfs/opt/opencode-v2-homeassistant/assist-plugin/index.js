import { Plugin } from "@opencode/plugin";
import { AssistRpc } from "../assist-rpc.js";
import { createAssistRuntime } from "../assist-runtime.js";

export default Plugin.define({
  id: "homeassistant.assist",
  async setup(ctx) {
    const runtime = await createAssistRuntime(ctx);
    const registration = await ctx.rpc.register(AssistRpc, {
      prepare: runtime.prepare, start: runtime.start, poll: runtime.poll, result: runtime.result, release: runtime.release,
    });
    return async () => { await registration.dispose(); await runtime.close(); };
  },
});
