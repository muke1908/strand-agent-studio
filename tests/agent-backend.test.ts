import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { copilotBackend } from "../server/agent-backend.ts";
import { temporaryRoot } from "./helpers.ts";

const commonOptions = [
  "--prompt",
  "--no-ask-user",
  "--no-custom-instructions",
  "--disable-builtin-mcps",
  "--no-auto-update",
  "--disallow-temp-dir",
  "--add-dir",
  "--available-tools",
  "--allow-all-tools",
  "--allow-all-urls",
  "--log-dir",
];

for (const [modern, allowAllTools] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
]) {
  test(`Copilot launch uses ${modern ? "modern" : "legacy"} bundled options with ${allowAllTools ? "all" : "restricted"} tools`, async () => {
    const root = temporaryRoot();
    const folderRoot = temporaryRoot();
    const folder = path.join(folderRoot, "project with spaces");
    fs.mkdirSync(folder);
    const allowedFolders = modern ? [fs.realpathSync(folder)] : [];
    const previous = process.env.COPILOT_BIN;
    const options = [
      ...commonOptions,
      ...(modern
        ? ["--trust-folder", "--disable-client-telemetry", "--sync-session"]
        : ["--no-remote-export"]),
    ];
    const script = path.join(root, "copilot.js");
    fs.writeFileSync(
      script,
      `const fs = require("node:fs");
const args = process.argv.slice(2);
const options = ${JSON.stringify(options)};
if (args.includes("--help")) {
  // Without no-auto-update, the downloaded version advertises newer options.
  console.log([...options, ...(args.includes("--no-auto-update") ? [] : ["--trust-folder", "--disable-client-telemetry", "--sync-session"])].join("\\n"));
} else {
  for (const arg of args.filter(arg => arg.startsWith("--"))) {
    if (!options.includes(arg.split("=")[0])) {
      console.error("unknown option " + arg);
      process.exit(2);
    }
  }
  fs.writeFileSync("args.json", JSON.stringify(args));
  fs.writeFileSync("output.json", JSON.stringify({ summary: "Fixture output" }));
}
`,
    );
    process.env.COPILOT_BIN = script;
    try {
      const backend = copilotBackend();
      const diagnostics = backend.diagnostics();
      assert.equal(diagnostics.available, true);
      if (!modern) assert.match(diagnostics.reason || "", /client telemetry/);
      assert.deepEqual(
        await backend.execute(
          {
            directory: root,
            prompt: "Produce a summary.",
            schema: { type: "object" },
            purpose: "stage",
            input: {},
            allowAllTools,
            allowedFolders,
          },
          new AbortController().signal,
        ),
        { summary: "Fixture output" },
      );
      const args: string[] = JSON.parse(
        fs.readFileSync(path.join(root, "args.json"), "utf8"),
      );
      assert.equal(args.includes("--trust-folder"), modern);
      assert.equal(args.includes("--disable-client-telemetry"), modern);
      assert(
        args.includes(modern ? "--sync-session=off" : "--no-remote-export"),
      );
      assert(args.includes("--no-auto-update"));
      assert(args.includes("--no-custom-instructions"));
      assert(args.includes("--allow-all-tools"));
      assert.equal(args.includes("--available-tools"), !allowAllTools);
      assert.equal(args.includes("--disable-builtin-mcps"), !allowAllTools);
      assert.equal(args.includes("--allow-all-urls"), allowAllTools);
      assert.deepEqual(
        args.flatMap((arg, index) =>
          arg === "--add-dir" ? [args[index + 1]] : [],
        ),
        [root, ...allowedFolders],
      );
      const prompt = fs.readFileSync(path.join(root, "prompt.md"), "utf8");
      if (allowedFolders.length) {
        assert(prompt.includes(JSON.stringify(allowedFolders)));
        assert(!prompt.includes("Do not write outside this attempt directory"));
        if (!allowAllTools)
          assert(
            prompt.includes(
              "Write only in this attempt directory or the explicitly allowed folders",
            ),
          );
      }
      assert.equal(
        fs
          .readFileSync(path.join(root, "prompt.md"), "utf8")
          .includes("Do not publish"),
        !allowAllTools,
      );
    } finally {
      if (previous === undefined) delete process.env.COPILOT_BIN;
      else process.env.COPILOT_BIN = previous;
      fs.rmSync(root, { recursive: true });
      fs.rmSync(folderRoot, { recursive: true });
    }
  });
}

test("Copilot diagnostics reject missing required execution controls", () => {
  const root = temporaryRoot();
  const previous = process.env.COPILOT_BIN;
  const script = path.join(root, "copilot.js");
  fs.writeFileSync(script, 'console.log("--prompt --no-auto-update");');
  process.env.COPILOT_BIN = script;
  try {
    const diagnostics = copilotBackend().diagnostics();
    assert.equal(diagnostics.available, false);
    assert.match(diagnostics.reason || "", /missing.*--no-ask-user/);
  } finally {
    if (previous === undefined) delete process.env.COPILOT_BIN;
    else process.env.COPILOT_BIN = previous;
    fs.rmSync(root, { recursive: true });
  }
});
