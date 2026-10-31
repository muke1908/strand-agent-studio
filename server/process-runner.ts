import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readJson, writeJson } from "./files.ts";
import {
  isAlive,
  isGroupAlive,
  ownerSchema,
  processIdentity,
} from "./process-owner.ts";
import { groupWorkerFile, processRequestSchema } from "./process-group.ts";

const exitSchema = z.object({
  code: z.number().nullable(),
  signal: z.string().nullable(),
  error: z.string().optional(),
});

export function assertAttemptStopped(directory: string): void {
  for (const name of ["wrapper.json", "cli.json"]) {
    const file = path.join(directory, name);
    if (fs.existsSync(file)) {
      const owner = ownerSchema.parse(readJson(file));
      if (isAlive(owner) || (name === "cli.json" && isGroupAlive(owner.pid)))
        throw new Error(
          "A previous agent process or process group is still active",
        );
    }
  }
  if (
    fs.existsSync(path.join(directory, "launch.json")) &&
    !fs.existsSync(path.join(directory, "exit.json"))
  ) {
    throw new Error(
      "Previous process outcome is unknown; resolve it before resuming",
    );
  }
}

export async function executeProcess(
  directory: string,
  command: string,
  args: string[],
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  writeJson(path.join(directory, "process-input.json"), {
    directory,
    command,
    args,
  });
  const stdout = fs.openSync(path.join(directory, "stdout.log"), "a", 0o600);
  const stderr = fs.openSync(path.join(directory, "stderr.log"), "a", 0o600);
  fs.fchmodSync(stdout, 0o600);
  fs.fchmodSync(stderr, 0o600);
  const child = fork(
    fileURLToPath(import.meta.url),
    ["--worker", path.join(directory, "process-input.json")],
    {
      cwd: directory,
      stdio: ["ignore", stdout, stderr, "ipc"],
      execArgv: [],
    },
  );
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  await new Promise<void>((resolve, reject) => {
    const startup = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Agent supervisor did not become ready"));
    }, 15000);
    const stop = () => {
      if (child.connected) child.send({ type: "stop" });
    };
    signal.addEventListener("abort", stop, { once: true });
    child.on("message", (value: unknown) => {
      if (
        value !== null &&
        typeof value === "object" &&
        "type" in value &&
        value.type === "ready"
      ) {
        clearTimeout(startup);
        child.send({ type: signal.aborted ? "stop" : "start" });
      }
    });
    child.once("error", (error) => {
      clearTimeout(startup);
      signal.removeEventListener("abort", stop);
      reject(error);
    });
    child.once("exit", (code, exitSignal) => {
      signal.removeEventListener("abort", stop);
      clearTimeout(startup);
      try {
        const receipt = exitSchema.parse(
          readJson(path.join(directory, "exit.json")),
        );
        if (
          code === 0 &&
          !exitSignal &&
          receipt.code === 0 &&
          !receipt.signal &&
          !receipt.error &&
          !signal.aborted
        )
          resolve();
        else
          reject(
            new Error(
              receipt.error ||
                `Agent process exited ${receipt.code}/${receipt.signal || ""}`,
            ),
          );
      } catch (error) {
        reject(error);
      }
    });
  });
}

function worker(file: string): void {
  const request = processRequestSchema.parse(readJson(file));
  writeJson(path.join(request.directory, "wrapper.json"), {
    pid: process.pid,
    identity: processIdentity(process.pid),
  });
  let group: ReturnType<typeof fork> | undefined;
  let stopped = false;
  let finished = false;
  let registrationError: string | undefined;
  let result: z.infer<typeof exitSchema> | undefined;
  async function finish(
    code: number | null,
    signal: string | null,
    error?: string,
  ) {
    if (finished) return;
    finished = true;
    if (group?.pid) {
      try {
        const deadline = Date.now() + 5000;
        while (isGroupAlive(group.pid)) {
          if (Date.now() >= deadline)
            throw new Error("Agent process group cleanup is unresolved");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } catch (failure) {
        console.error(failure);
        process.exitCode = 1;
        if (process.connected) process.disconnect();
        return;
      }
    }
    writeJson(path.join(request.directory, "exit.json"), {
      code,
      signal,
      ...(error ? { error } : {}),
    });
    process.exitCode = code === 0 && !error ? 0 : 1;
    if (process.connected) process.disconnect();
  }
  function stop() {
    stopped = true;
    if (!group?.pid) {
      void finish(null, null, "Cancelled before launch");
      return;
    }
    if (registrationError) {
      group.kill("SIGKILL");
      return;
    }
    const owner = ownerSchema.parse(
      readJson(path.join(request.directory, "cli.json")),
    );
    if (isAlive(owner)) process.kill(-owner.pid, "SIGKILL");
  }
  process.on("disconnect", () => {
    if (!finished) stop();
  });
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("message", (value: unknown) => {
    if (value === null || typeof value !== "object" || !("type" in value))
      return;
    if (value.type === "stop") {
      stop();
      return;
    }
    if (value.type !== "start" || group || stopped) return;
    writeJson(path.join(request.directory, "launch.json"), {
      startedAt: new Date().toISOString(),
    });
    group = fork(groupWorkerFile, ["--group-worker", file], {
      cwd: request.directory,
      detached: true,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      execArgv: [],
    });
    group.on("message", (message: unknown) => {
      if (
        message === null ||
        typeof message !== "object" ||
        !("type" in message)
      )
        return;
      if (message.type === "ready") {
        if (stopped || registrationError) stop();
        else group?.send({ type: "start" });
      } else if (message.type === "exit") {
        result = exitSchema.parse(message);
        const owner = ownerSchema.parse(
          readJson(path.join(request.directory, "cli.json")),
        );
        if (isAlive(owner)) process.kill(-owner.pid, "SIGKILL");
      }
    });
    group.once("error", (error) => void finish(null, null, error.message));
    group.once("exit", (code, signal) => {
      void finish(
        result ? result.code : code,
        result ? result.signal : signal,
        registrationError ||
          (stopped
            ? "Agent cancelled"
            : result?.error ||
              (!result
                ? "Agent group exited without a CLI result"
                : undefined)),
      );
    });
    if (group.pid) {
      try {
        writeJson(path.join(request.directory, "cli.json"), {
          pid: group.pid,
          identity: processIdentity(group.pid),
        });
      } catch (error) {
        registrationError =
          error instanceof Error ? error.message : String(error);
        group.kill("SIGKILL");
      }
    }
  });
  process.send?.({ type: "ready" });
}

if (process.argv[2] === "--worker") worker(process.argv[3]);
