import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "../server/native-spawn.ts";
import { temporaryRoot } from "./helpers.ts";

test(
  "Windows global, PATH and local shims preserve structured and literal arguments",
  { skip: process.platform !== "win32" },
  () => {
    const root = temporaryRoot();
    const directory = path.join(root, "tools with spaces & symbols");
    const local = path.join(directory, "node_modules", ".bin");
    fs.mkdirSync(local, { recursive: true });
    const script = path.join(directory, "echo.cjs");
    fs.writeFileSync(
      script,
      "console.log(JSON.stringify(process.argv.slice(2)))",
    );
    const shim = path.join(directory, "strand-echo.cmd");
    const localShim = path.join(local, "strand-echo.cmd");
    for (const file of [shim, localShim])
      fs.writeFileSync(file, `@"${process.execPath}" "${script}" %*\r\n`);
    const args = [
      directory,
      JSON.stringify({ path: "C:\\source & folder\\", quoted: '"value"' }),
      "caret ^ and | pipe",
      "100% literal!",
    ];
    try {
      for (const command of [shim, "strand-echo", localShim]) {
        const result = spawn.sync(command, args, {
          cwd: directory,
          encoding: "utf8",
          env: { ...process.env, PATH: `${directory};${process.env.PATH}` },
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), args);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
