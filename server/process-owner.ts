import { execFileSync } from "node:child_process";
import { z } from "zod";
import {
  windowsIdentity,
  windowsGroupActive,
  stopWindowsGroup,
} from "./windows-process.ts";

export const ownerSchema = z.object({
  pid: z.number().int().positive(),
  identity: z.string().min(1),
});
export type ProcessOwner = z.infer<typeof ownerSchema>;

let ownIdentity: string | undefined;
export function processIdentity(pid: number): string {
  if (pid === process.pid && ownIdentity) return ownIdentity;
  const identity =
    process.platform === "win32"
      ? windowsIdentity(pid)
      : execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
          encoding: "utf8",
          timeout: 5000,
        }).trim();
  if (!identity)
    throw Object.assign(new Error(`Process ${pid} no longer exists`), {
      code: "ESRCH",
    });
  if (pid === process.pid) ownIdentity = identity;
  return identity;
}

export function isAlive(owner: ProcessOwner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }

  try {
    return processIdentity(owner.pid) === owner.identity;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    if (error instanceof Error && "status" in error && error.status === 1) {
      try {
        process.kill(owner.pid, 0);
      } catch (failure) {
        if (
          failure instanceof Error &&
          "code" in failure &&
          failure.code === "ESRCH"
        )
          return false;
        throw failure;
      }
    }
    throw error;
  }
}

export function isGroupAlive(owner: ProcessOwner): boolean {
  if (process.platform === "win32") return windowsGroupActive(owner);
  return execFileSync("ps", ["-axo", "pgid=,stat="], {
    encoding: "utf8",
    timeout: 5000,
  })
    .split("\n")
    .some((row) => {
      const [group, state] = row.trim().split(/\s+/);
      return Number(group) === owner.pid && !state.startsWith("Z");
    });
}

export function stopProcessGroup(owner: ProcessOwner): void {
  if (process.platform === "win32") stopWindowsGroup(owner);
  else if (isAlive(owner)) process.kill(-owner.pid, "SIGKILL");
}
