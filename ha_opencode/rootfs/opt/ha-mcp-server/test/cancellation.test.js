import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createOperationSignal,
  runCancellableExecFile,
  withRequestSignal,
} from "../lib/cancellation.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const cleanups = [];
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/cancellable-process.cjs");

async function running(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
  } catch (error) {
    // procfs may open the stat entry just before the task disappears. In that
    // case read returns ESRCH rather than open returning ENOENT; both mean gone.
    if (error.code === "ENOENT" || error.code === "ESRCH") return false;
    throw error;
  }
}

async function processTree(mode, controller, timeoutMs = 5000) {
  const directory = await mkdtemp(join(tmpdir(), "ha-cancellation-"));
  const pidFile = join(directory, "pids.json");
  let pids = [];
  cleanups.push(async () => {
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  // Attach a rejection handler immediately, including while waiting for startup.
  const result = runCancellableExecFile(process.execPath, [FIXTURE, "parent", mode, pidFile], {
    timeoutMs, killGraceMs: 50, maxBuffer: 1024,
  }, controller?.signal).then((value) => ({ value }), (error) => ({ error }));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { pids = JSON.parse(await readFile(pidFile, "utf8")); break; } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  expect(pids).toHaveLength(2);
  return { pids, result };
}

async function expectTerminated(pids) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await Promise.all(pids.map(running))).some(Boolean)) return;
    await delay(10);
  }
  expect(await Promise.all(pids.map(running))).toEqual([false, false]);
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("production operation cancellation", () => {
  it("composes a request cancellation with an operation deadline", async () => {
    const controller = new AbortController();
    const operation = withRequestSignal(controller.signal, () => createOperationSignal(60_000));
    controller.abort("cancelled by client");

    expect(operation.signal.aborted).toBe(true);
    expect(operation.signal.reason.message).toContain("cancelled by client");
    operation.cleanup();
  });

  it.skipIf(process.platform !== "linux")("terminates a TERM-resistant CLI and descendant on cancellation", async () => {
    const controller = new AbortController();
    const { pids, result } = await processTree("both-ignore", controller);
    expect(await Promise.all(pids.map(running))).toEqual([true, true]);
    controller.abort("cancelled CLI");
    expect((await result).error.message).toMatch(/cancelled CLI/);
    await expectTerminated(pids);
  });

  it.skipIf(process.platform !== "linux")("terminates descendants on timeout", async () => {
    const { pids, result } = await processTree("both-ignore", undefined, 750);
    expect((await result).error.name).toBe("TimeoutError");
    await expectTerminated(pids);
  });

  it.skipIf(process.platform !== "linux")("still escalates after the group leader exits and closes its pipes", async () => {
    const controller = new AbortController();
    const { pids, result } = await processTree("leader-exits", controller);
    controller.abort("cancelled tree");
    expect((await result).error.message).toMatch(/cancelled tree/);
    await expectTerminated(pids);
  });

  it.skipIf(process.platform !== "linux")("bounds output and terminates the overflowing process tree", async () => {
    const { pids, result } = await processTree("overflow");
    const { error } = await result;
    expect(error.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    expect(Buffer.byteLength(error.stdout)).toBe(1024);
    await expectTerminated(pids);
  });

  it("does not launch an already cancelled request and reports spawn errors", async () => {
    const controller = new AbortController();
    controller.abort("cancelled before launch");
    await expect(runCancellableExecFile("/missing/cancellation-fixture", [], {
      timeoutMs: 1000,
    }, controller.signal)).rejects.toThrow("cancelled before launch");
    await expect(runCancellableExecFile("/missing/cancellation-fixture", [], {
      timeoutMs: 1000,
    })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves successful output and failed-command diagnostics", async () => {
    await expect(runCancellableExecFile(process.execPath, ["-e", "process.stdout.write('ok')"], {
      timeoutMs: 1000,
    })).resolves.toBe("ok");
    await expect(runCancellableExecFile(process.execPath, ["-e", "process.stderr.write('failure'); process.exit(7)"], {
      timeoutMs: 1000,
    })).rejects.toMatchObject({ code: 7, stderr: "failure" });
  });

  it("aborts the production Home Assistant fetch behind a cancelled MCP call", async () => {
    let requestStarted;
    let requestClosed;
    const started = new Promise((resolve) => { requestStarted = resolve; });
    const closed = new Promise((resolve) => { requestClosed = resolve; });
    const api = createServer((request) => {
      requestStarted();
      request.once("close", requestClosed);
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => api.close(resolve)));

    const address = api.address();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: {
        ...process.env,
        SUPERVISOR_TOKEN: "test-token",
        HA_API_BASE_URL: `http://127.0.0.1:${address.port}`,
        OPENCODE_MCP_TOOL_PROFILE: "full",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "cancellation-test", version: "1.0.0" });
    await client.connect(transport);
    cleanups.push(() => client.close());

    const controller = new AbortController();
    const call = client.callTool(
      { name: "get_states", arguments: {} },
      undefined,
      { signal: controller.signal },
    );
    await started;
    controller.abort("cancelled HA request");

    await expect(call).rejects.toThrow(/cancelled HA request/);
    await expect(closed).resolves.toBeUndefined();
  });
});
