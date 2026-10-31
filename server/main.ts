import path from "node:path";
import { createCatalog } from "./catalog.ts";
import { copilotBackend } from "./agent-backend.ts";
import { fixtureBackend } from "./fixture-backend.ts";
import { createRunHost } from "./run-host.ts";
import { createWatcher } from "./watcher.ts";
import { cronPolicy, adoHeadPolicy } from "./watch-policies.ts";
import { seedCatalog } from "./starter-workflows.ts";
import { createApp } from "./app.ts";
import { claim } from "./files.ts";

const root = path.resolve(process.env.PLATFORM_DATA_DIR || ".data");
const release = claim(path.join(root, "host"));
const catalog = createCatalog(root);
seedCatalog(catalog);
const backend =
  process.env.PLATFORM_TEST_MODE === "1" ? fixtureBackend() : copilotBackend();
const host = createRunHost(root, catalog, backend);
const watcher = createWatcher(root, catalog, host, [
  cronPolicy,
  adoHeadPolicy(process.env.ADO_PAT),
]);
const app = createApp(catalog, host, watcher, backend);
const server = app.listen(Number(process.env.PORT || 4200), "127.0.0.1", () => {
  console.log(
    `Strand is ready at http://localhost:${process.env.PORT || 4200}`,
  );
});
let evaluation = Promise.resolve();
const interval = setInterval(() => {
  evaluation = watcher
    .tick()
    .catch((error) => console.error("Watcher tick failed:", error));
}, 5000);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(interval);
  server.close();
  await evaluation;
  await host.close();
  release();
}
process.on("SIGINT", () => {
  close().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
});
process.on("SIGTERM", () => {
  close().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
});
server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
  void close();
});
