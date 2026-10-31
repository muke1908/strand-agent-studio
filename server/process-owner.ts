import { execFileSync } from "node:child_process";
import { z } from "zod";

export const ownerSchema = z.object({
  pid: z.number().int().positive(),
  identity: z.string().min(1),
});
export type ProcessOwner = z.infer<typeof ownerSchema>;

export function processIdentity(pid: number): string {
  return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 5000,
  }).trim();
}

export function isAlive(owner: ProcessOwner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }

  return processIdentity(owner.pid) === owner.identity;
}

export function isGroupAlive(groupId: number): boolean {
  return execFileSync("ps", ["-axo", "pgid=,stat="], {
    encoding: "utf8",
    timeout: 5000,
  })
    .split("\n")
    .some((row) => {
      const [group, state] = row.trim().split(/\s+/);
      return Number(group) === groupId && !state.startsWith("Z");
    });
}
