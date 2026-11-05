import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readJson } from "./files.ts";

export const groupWorkerFile = fileURLToPath(import.meta.url);
export const processRequestSchema = z.object({
  directory: z.string(),
  command: z.string(),
  args: z.array(z.string()),
});

function groupWorker(file: string): void {
  const request = processRequestSchema.parse(readJson(file));
  let started = false;
  let reported = false;
  function report(code: number | null, signal: string | null, error?: string) {
    if (reported) return;
    reported = true;
    if (process.connected)
      process.send?.({
        type: "exit",
        code,
        signal,
        ...(error ? { error } : {}),
      });
  }
  function stop() {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        return;
      console.error(error);
      report(
        null,
        null,
        `Agent process-group termination failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // Stay the group's identifiable leader until the supervisor cleans it up.
  process.on("disconnect", stop);
  if (!process.connected) stop();
  process.on("message", (value: unknown) => {
    if (
      started ||
      !process.connected ||
      value === null ||
      typeof value !== "object" ||
      !("type" in value) ||
      value.type !== "start"
    )
      return;
    started = true;
    const cli = spawn(request.command, request.args, {
      cwd: request.directory,
      stdio: ["ignore", "inherit", "inherit"],
    });
    cli.once("error", (error) => report(null, null, error.message));
    cli.once("exit", (code, signal) => report(code, signal));
  });
  process.send?.({ type: "ready" });
}

if (process.argv[2] === "--group-worker") groupWorker(process.argv[3]);
