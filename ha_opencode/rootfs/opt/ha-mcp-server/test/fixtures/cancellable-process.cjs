const { fork } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const [role, mode, pidFile] = process.argv.slice(2);
if (role === "descendant") {
  process.on("SIGTERM", () => {});
  process.send({ pid: process.pid });
  setInterval(() => {}, 1000);
} else {
  process.on("SIGTERM", () => {
    if (mode === "leader-exits") process.exit(0);
  });
  const child = fork(__filename, ["descendant", mode, pidFile], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.once("message", ({ pid }) => {
    writeFileSync(pidFile, JSON.stringify([process.pid, pid]));
    if (mode === "overflow") process.stdout.write("x".repeat(4096));
  });
  setInterval(() => {}, 1000);
}
