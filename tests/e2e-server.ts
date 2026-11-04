import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "vite";

const studio = await createServer({
  server: {
    host: "127.0.0.1",
    port: 4291,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4290",
        headers: { origin: "http://127.0.0.1:4290" },
      },
    },
  },
});
await studio.listen();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "strand-browser-"));
const child = spawn(process.execPath, ["server/main.ts"], {
  env: {
    ...process.env,
    PLATFORM_DATA_DIR: directory,
    PLATFORM_TEST_MODE: "1",
    PORT: "4290",
  },
  stdio: "inherit",
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", async (code) => {
  await studio.close();
  fs.rmSync(directory, { recursive: true });
  process.exitCode = code || 0;
});
child.on("error", async (error) => {
  console.error(error);
  await studio.close();
  fs.rmSync(directory, { recursive: true });
  process.exitCode = 1;
});
