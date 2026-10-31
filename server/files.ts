import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { identifier } from "../shared/contracts.ts";
import { isAlive, ownerSchema, processIdentity } from "./process-owner.ts";

export const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const readJson = (file: string): unknown =>
  JSON.parse(fs.readFileSync(file, "utf8"));

export function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

export function writeJson(file: string, value: unknown): void {
  privateDirectory(path.dirname(file));
  const pending = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(pending, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(pending, file);
  } finally {
    if (fs.existsSync(pending)) fs.unlinkSync(pending);
  }
}

export function itemPath(root: string, collection: string, id: string): string {
  return path.join(root, collection, `${identifier.parse(id)}.json`);
}

export function claim(file: string): () => void {
  const directory = `${file}.claims`;
  privateDirectory(directory);
  const owner = { pid: process.pid, identity: processIdentity(process.pid) };
  const pending = path.join(directory, `${randomUUID()}.pending`);
  fs.writeFileSync(pending, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  let selected = "";
  try {
    for (let generation = 1; ; generation++) {
      const candidate = path.join(directory, `${generation}.json`);
      try {
        fs.linkSync(pending, candidate);
        selected = candidate;
        break;
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
        if (
          !fs.existsSync(`${candidate}.released`) &&
          isAlive(ownerSchema.parse(readJson(candidate)))
        ) {
          throw Object.assign(
            new Error("Another process owns this operation"),
            { status: 409 },
          );
        }
      }
    }
  } finally {
    fs.unlinkSync(pending);
  }
  return () => {
    if (!fs.existsSync(`${selected}.released`))
      writeJson(`${selected}.released`, owner);
  };
}
