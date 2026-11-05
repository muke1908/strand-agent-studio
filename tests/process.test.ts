import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  executeProcess,
  assertAttemptStopped,
} from "../server/process-runner.ts";
import { readJson, writeJson } from "../server/files.ts";
import { isAlive, isGroupAlive, ownerSchema } from "../server/process-owner.ts";
import { createRunStore } from "../server/run-store.ts";
import { temporaryRoot } from "./helpers.ts";

async function waitUntil(check: () => boolean): Promise<void> {
  for (let retry = 0; retry < 200; retry++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Process condition did not become ready");
}

test("cancellation and supervisor loss clean up active inherited-group children", async () => {
  for (const action of ["cancel", "disconnect"]) {
    const root = temporaryRoot();
    const abort = new AbortController();
    const failure = assert.rejects(
      executeProcess(
        root,
        process.execPath,
        [
          "-e",
          `
      const fs = require("node:fs");
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync("started.json", JSON.stringify({ pid: child.pid }));
      setInterval(() => {}, 1000);
    `,
        ],
        abort.signal,
      ),
      action === "cancel" ? /cancelled/i : /without a termination receipt/,
    );
    try {
      await waitUntil(() => fs.existsSync(path.join(root, "started.json")));
      const group = ownerSchema.parse(readJson(path.join(root, "cli.json")));
      assert.throws(() => assertAttemptStopped(root), /still active/);
      if (action === "cancel") abort.abort();
      else {
        const wrapper = ownerSchema.parse(
          readJson(path.join(root, "wrapper.json")),
        );
        assert(isAlive(wrapper));
        process.kill(wrapper.pid, "SIGKILL");
      }
      await failure;
      await waitUntil(() => !isGroupAlive(group.pid));
      if (action === "cancel") assertAttemptStopped(root);
      else {
        assert(!fs.existsSync(path.join(root, "exit.json")));
        assert.throws(() => assertAttemptStopped(root), /unknown|still active/);
        await waitUntil(() => {
          const wrapper = ownerSchema.parse(
            readJson(path.join(root, "wrapper.json")),
          );
          return !isAlive(wrapper);
        });
        assertAttemptStopped(root, true);
        assertAttemptStopped(root);
        assert.equal(
          readJson(path.join(root, "recovery.json")).status,
          "interrupted-stopped",
        );
        assert(!fs.existsSync(path.join(root, "exit.json")));
      }
    } finally {
      abort.abort();
      await failure;
      const file = path.join(root, "cli.json");
      if (fs.existsSync(file)) {
        const group = ownerSchema.parse(readJson(file));
        if (isAlive(group)) process.kill(-group.pid, "SIGKILL");
      }
      fs.rmSync(root, { recursive: true });
    }
  }
});

test("supervision stops inherited-group descendants before reporting success", async () => {
  const root = temporaryRoot();
  try {
    await executeProcess(
      root,
      process.execPath,
      [
        "-e",
        `
      const fs = require("node:fs");
      const { spawn, execFileSync } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync("descendant.json", JSON.stringify({
        pid: child.pid,
        identity: execFileSync("ps", ["-p", String(child.pid), "-o", "lstart="], { encoding: "utf8" }).trim()
      }));
      child.unref();
    `,
      ],
      new AbortController().signal,
    );
    const descendant = ownerSchema.parse(
      readJson(path.join(root, "descendant.json")),
    );
    const active = execFileSync("ps", ["-axo", "pid=,stat="], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .some((row) => {
        const [pid, state] = row.trim().split(/\s+/);
        return Number(pid) === descendant.pid && !state.startsWith("Z");
      });
    assert.equal(
      active,
      false,
      "A descendant is still executing after success",
    );
    assertAttemptStopped(root);
  } finally {
    const file = path.join(root, "descendant.json");
    if (fs.existsSync(file)) {
      const owner = ownerSchema.parse(readJson(file));
      if (isAlive(owner)) process.kill(owner.pid, "SIGKILL");
    }
    fs.rmSync(root, { recursive: true });
  }
});

test("storage directories and process logs remain owner-only under umask 022", async () => {
  const root = temporaryRoot();
  const previous = process.umask(0o022);
  try {
    fs.chmodSync(root, 0o755);
    createRunStore(root);
    writeJson(path.join(root, "nested", "state.json"), {});
    for (const file of ["stdout.log", "stderr.log"])
      fs.writeFileSync(path.join(root, file), "retained log\n", {
        mode: 0o644,
      });
    await executeProcess(
      root,
      process.execPath,
      ["-e", "console.log('synthetic context')"],
      new AbortController().signal,
    );
    for (const directory of [root, path.join(root, "nested")])
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    for (const file of ["stdout.log", "stderr.log"])
      assert.equal(fs.statSync(path.join(root, file)).mode & 0o777, 0o600);
    assert.match(
      fs.readFileSync(path.join(root, "stdout.log"), "utf8"),
      /retained log/,
    );
  } finally {
    process.umask(previous);
    fs.rmSync(root, { recursive: true });
  }
});

test("supervised execution requires a successful process and durable receipt", async () => {
  const root = temporaryRoot();
  try {
    await executeProcess(
      root,
      process.execPath,
      ["-e", "console.log('real child process')"],
      new AbortController().signal,
    );
    assert(fs.existsSync(path.join(root, "exit.json")));
    assertAttemptStopped(root);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
test("nonzero process and unresolved launch windows fail closed", async () => {
  const root = temporaryRoot();
  try {
    await assert.rejects(
      executeProcess(
        root,
        process.execPath,
        ["-e", "process.exit(3)"],
        new AbortController().signal,
      ),
      /exited 3/,
    );
    fs.unlinkSync(path.join(root, "exit.json"));
    writeJson(path.join(root, "launch.json"), {});
    assert.throws(() => assertAttemptStopped(root), /unknown/);
    fs.unlinkSync(path.join(root, "cli.json"));
    assert.throws(() => assertAttemptStopped(root, true), /unknown/);
    assert(!fs.existsSync(path.join(root, "recovery.json")));
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("denied group termination records an explicit bounded failure and refuses live recovery", async () => {
  const root = temporaryRoot();
  const preload = path.join(root, "deny-group-kill.mjs");
  fs.writeFileSync(
    preload,
    `const kill = process.kill;
process.kill = function(pid, signal) {
  if (pid < 0 && signal === "SIGKILL")
    throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  return kill.call(process, pid, signal);
};`,
  );
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--import=${preload}`;
  const abort = new AbortController();
  try {
    const failure = assert.rejects(
      executeProcess(
        root,
        process.execPath,
        [
          "-e",
          "require('node:fs').writeFileSync('started.json', '{}'); setInterval(() => {}, 1000)",
        ],
        abort.signal,
      ),
      /termination failed: kill EPERM.*cleanup is unresolved/,
    );
    await waitUntil(() => fs.existsSync(path.join(root, "started.json")));
    abort.abort();
    await failure;
    const receipt = readJson(path.join(root, "exit.json"));
    assert.match(receipt.error, /EPERM/);
    assert.notEqual(receipt.code, 0);
    assert.throws(() => assertAttemptStopped(root, true), /still active/);
    assert(!fs.existsSync(path.join(root, "recovery.json")));
  } finally {
    abort.abort();
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    const file = path.join(root, "cli.json");
    if (fs.existsSync(file)) {
      const group = ownerSchema.parse(readJson(file));
      if (isAlive(group)) process.kill(-group.pid, "SIGKILL");
      await waitUntil(() => !isGroupAlive(group.pid));
    }
    fs.rmSync(root, { recursive: true });
  }
});

test("cancellation terminates only its owned process and leaves a stopped receipt", async () => {
  const root = temporaryRoot();
  const abort = new AbortController();
  try {
    const running = executeProcess(
      root,
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      abort.signal,
    );
    const timer = setTimeout(() => abort.abort(), 200);
    try {
      await assert.rejects(running, /cancelled/i);
    } finally {
      clearTimeout(timer);
    }
    assertAttemptStopped(root);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
