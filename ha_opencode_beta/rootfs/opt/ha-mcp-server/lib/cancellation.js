import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";

const requestSignals = new AsyncLocalStorage();

export function withRequestSignal(signal, operation) {
  return requestSignals.run(signal, operation);
}

export function getRequestSignal() {
  return requestSignals.getStore();
}

export function cancellationError(reason = "Operation cancelled") {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "Operation cancelled");
  error.name = "AbortError";
  return error;
}

export function throwIfRequestCancelled() {
  const signal = getRequestSignal();
  if (signal?.aborted) throw cancellationError(signal.reason);
}

export function createOperationSignal(timeoutMs, parentSignal = getRequestSignal()) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(cancellationError(parentSignal.reason));
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const timeout = setTimeout(() => {
    const error = new Error(`Operation timed out after ${timeoutMs}ms`);
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);
  timeout.unref?.();

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function signalProcessGroup(child, signal) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
    }
  }
  // A missing group does not imply that the direct child has exited. ChildProcess
  // tracks its own handle, so this fallback cannot signal an already reaped PID.
  child.kill(signal);
}

function processGroupExists(child) {
  if (!child.pid || process.platform === "win32") return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

export function runCancellableExecFile(
  file,
  args,
  { timeoutMs, killGraceMs = 1_000, maxBuffer = 1024 * 1024, encoding = "utf8", ...options },
  parentSignal = getRequestSignal(),
) {
  const operation = createOperationSignal(timeoutMs, parentSignal);
  return new Promise((resolve, reject) => {
    if (operation.signal.aborted) {
      operation.cleanup();
      reject(cancellationError(operation.signal.reason));
      return;
    }

    let child;
    let settled = false;
    let closed = false;
    let failure;
    let killTimer;
    const output = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    const decode = (name) => {
      const buffer = Buffer.concat(output[name], sizes[name]);
      return encoding === "buffer" ? buffer : buffer.toString(encoding);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      operation.cleanup();
      operation.signal.removeEventListener("abort", onAbort);
      if (failure) reject(Object.assign(failure, { stdout: decode("stdout"), stderr: decode("stderr") }));
      else resolve(decode("stdout"));
    };

    const stop = (error) => {
      if (settled || failure) return;
      failure = error;
      operation.cleanup();
      operation.signal.removeEventListener("abort", onAbort);
      signalProcessGroup(child, "SIGTERM");
      // Keep escalation alive even if the group leader exits first or closes its
      // pipes. A descendant can ignore TERM and no longer hold our stdio open.
      killTimer = setTimeout(() => {
        killTimer = undefined;
        signalProcessGroup(child, "SIGKILL");
        if (closed) finish();
      }, killGraceMs);
    };
    const onAbort = () => stop(cancellationError(operation.signal.reason));

    try {
      // execFile does not forward detached to spawn in the shipped Node version.
      child = spawn(file, args, {
        ...options,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      failure = error;
      finish();
      return;
    }

    for (const name of ["stdout", "stderr"]) {
      child[name].on("data", (chunk) => {
        const remaining = Math.max(0, maxBuffer - sizes[name]);
        const retained = chunk.subarray(0, remaining);
        if (retained.length) output[name].push(retained);
        sizes[name] += retained.length;
        if (chunk.length > remaining) {
          const error = new RangeError(`${name} maxBuffer length exceeded`);
          error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          stop(error);
        }
      });
    }
    child.once("error", (error) => {
      failure ??= error;
      if (!child.pid) finish();
    });
    child.once("close", (code, signal) => {
      closed = true;
      if (failure && killTimer && processGroupExists(child)) return;
      if (!failure && (code !== 0 || signal)) {
        failure = Object.assign(new Error(`Command failed: ${file} (${signal ?? code})`), { code, signal });
      }
      finish();
    });

    operation.signal.addEventListener("abort", onAbort, { once: true });
    if (operation.signal.aborted) onAbort();
  });
}
