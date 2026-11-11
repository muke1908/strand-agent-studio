import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { copilotBackend } from "../server/agent-backend.ts";
import { stagePrompt } from "../server/prompts.ts";
import { temporaryRoot, workflow } from "./helpers.ts";

const commonOptions = [
  "--prompt",
  "--model",
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

for (const [modern, allowAllTools, model] of [
  [false, false, undefined],
  [true, false, "gpt-6-sol"],
  [false, true, undefined],
  [true, true, "gpt-6-sol"],
] as const) {
  test(`Copilot launch uses ${modern ? "modern" : "legacy"} bundled options with ${allowAllTools ? "all" : "restricted"} tools and ${model ?? "default GPT Astra"}`, async () => {
    const root = temporaryRoot();
    const folderRoot = temporaryRoot();
    const folder = path.join(folderRoot, "project with spaces");
    fs.mkdirSync(folder);
    const allowedFolders = modern ? [fs.realpathSync(folder)] : [];
    const previous = process.env.COPILOT_BIN;
    const options = [
      ...commonOptions,
      ...(modern
        ? [
            "--trust-folder",
            "--disable-client-telemetry",
            "--sync-session",
            "--additional-mcp-config",
          ]
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
            model,
            allowAllTools,
            allowedFolders,
            ...(modern ? { paths: { CHECKOUT: allowedFolders[0] } } : {}),
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
      assert.deepEqual(
        args.flatMap((arg, index) =>
          arg === "--model" ? [args[index + 1]] : [],
        ),
        [model ?? "gpt-6-astra"],
      );
      assert.equal(args.includes("--available-tools"), !allowAllTools);
      assert.equal(args.includes("--disable-builtin-mcps"), !allowAllTools);
      assert.equal(args.includes("--allow-all-urls"), allowAllTools);
      assert.equal(args.includes("--additional-mcp-config"), modern);
      if (modern) {
        const config = JSON.parse(
          args[args.indexOf("--additional-mcp-config") + 1],
        );
        assert.deepEqual(config.mcpServers["strand-paths"].tools, ["get_path"]);
        assert.deepEqual(
          JSON.parse(fs.readFileSync(path.join(root, "paths.json"), "utf8")),
          { CHECKOUT: allowedFolders[0] },
        );
        if (!allowAllTools) assert(args.includes("strand-paths"));
      }
      assert.deepEqual(
        args.flatMap((arg, index) =>
          arg === "--add-dir" ? [args[index + 1]] : [],
        ),
        [root, ...allowedFolders],
      );
      const prompt = fs.readFileSync(path.join(root, "prompt.md"), "utf8");
      assert.match(prompt, /runtime failure envelope/);
      assert.match(prompt, /"failed" when the task was attempted/);
      assert.match(
        prompt,
        /Both stop the run without publishing a successful result/,
      );
      assert.match(prompt, /even when the success schema is a primitive/);
      assert.match(prompt, /including 0, to represent failure/);
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

test(
  "native Windows probes and executes a .cmd CLI with spaces and structured arguments",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const root = temporaryRoot();
    const directory = path.join(
      root,
      "CLI and workspace with spaces & symbols",
    );
    fs.mkdirSync(directory);
    const script = path.join(directory, "copilot.js");
    const shim = path.join(directory, "copilot.cmd");
    const previous = process.env.COPILOT_BIN;
    fs.writeFileSync(
      script,
      `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    if (args.includes("--help")) {
      console.log(${JSON.stringify([...commonOptions, "--no-remote-export", "--additional-mcp-config"].join(" "))});
    } else {
      fs.writeFileSync("args.json", JSON.stringify(args));
      fs.writeFileSync("output.json", JSON.stringify({ summary: "Native Windows" }));
    }
  `,
    );
    fs.writeFileSync(shim, `@"${process.execPath}" "%~dp0copilot.js" %*\r\n`);
    process.env.COPILOT_BIN = shim;
    try {
      const backend = copilotBackend();
      assert.equal(backend.diagnostics().available, true);
      assert.deepEqual(
        await backend.execute(
          {
            directory,
            prompt: 'Review "quoted" content & keep arguments literal.',
            schema: { type: "object" },
            purpose: "stage",
            input: {},
            allowedFolders: [directory],
            paths: { CHECKOUT: directory },
          },
          new AbortController().signal,
        ),
        { summary: "Native Windows" },
      );
      const args = JSON.parse(
        fs.readFileSync(path.join(directory, "args.json"), "utf8"),
      );
      assert.equal(args[args.indexOf("--add-dir") + 1], directory);
      const config = JSON.parse(
        args[args.indexOf("--additional-mcp-config") + 1],
      );
      assert.equal(config.mcpServers["strand-paths"].command, process.execPath);
      assert.equal(
        config.mcpServers["strand-paths"].args[1],
        path.join(directory, "paths.json"),
      );
      const prompt = fs.readFileSync(path.join(directory, "prompt.md"), "utf8");
      assert.match(prompt, /PowerShell-compatible/);
    } finally {
      if (previous === undefined) delete process.env.COPILOT_BIN;
      else process.env.COPILOT_BIN = previous;
      fs.rmSync(root, { recursive: true });
    }
  },
);

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

test("Copilot refuses execution when the CLI cannot explicitly select the model", async () => {
  const root = temporaryRoot();
  const previous = process.env.COPILOT_BIN;
  const script = path.join(root, "copilot.js");
  fs.writeFileSync(
    script,
    `console.log(${JSON.stringify([...commonOptions.filter((option) => option !== "--model"), "--no-remote-export"].join("\n"))});`,
  );
  process.env.COPILOT_BIN = script;
  try {
    const backend = copilotBackend();
    assert.equal(backend.diagnostics().available, false);
    await assert.rejects(
      backend.execute(
        {
          directory: root,
          prompt: "Produce a summary.",
          schema: { type: "object" },
          purpose: "watch-condition",
          input: {},
        },
        new AbortController().signal,
      ),
      /missing --model/,
    );
    assert.equal(fs.existsSync(path.join(root, "process-input.json")), false);
  } finally {
    if (previous === undefined) delete process.env.COPILOT_BIN;
    else process.env.COPILOT_BIN = previous;
    fs.rmSync(root, { recursive: true });
  }
});

test("Copilot sees the output contract before long task context and writes blocked results", async () => {
  const root = temporaryRoot();
  const previous = process.env.COPILOT_BIN;
  const script = path.join(root, "copilot.js");
  const schema = {
    type: "object",
    required: ["status", "reason"],
    properties: {
      status: { const: "blocked" },
      reason: { type: "string" },
    },
    additionalProperties: false,
  };
  const output = {
    status: "blocked",
    reason: "Fixture runtime is unavailable",
  };
  fs.writeFileSync(
    script,
    `const fs = require("node:fs");
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(${JSON.stringify([...commonOptions, "--no-remote-export"].join("\n"))});
} else {
  const visible = fs.readFileSync("prompt.md", "utf8").slice(0, 20000);
  const destination = visible.match(/^Output file: (.+)$/m)?.[1];
  if (!destination) {
    console.log(${JSON.stringify(JSON.stringify(output))});
  } else {
    const schema = visible.split("## Required output schema\\n")[1].split("\\n\\n## Task\\n")[0];
    assert.deepEqual(JSON.parse(schema), ${JSON.stringify(schema)});
    assert(args[args.indexOf("--prompt") + 1].includes(destination));
    fs.writeFileSync(destination, JSON.stringify(${JSON.stringify(output)}));
  }
}
`,
  );
  process.env.COPILOT_BIN = script;
  try {
    assert.deepEqual(
      await copilotBackend().execute(
        {
          directory: root,
          prompt: `Task with extensive accepted handoffs:\n${"context ".repeat(8000)}`,
          schema,
          purpose: "stage",
          input: {},
        },
        new AbortController().signal,
      ),
      output,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, "output.json"), "utf8")),
      output,
    );
  } finally {
    if (previous === undefined) delete process.env.COPILOT_BIN;
    else process.env.COPILOT_BIN = previous;
    fs.rmSync(root, { recursive: true });
  }
});

test("successful CLI exit without an output file fails explicitly instead of accepting chat JSON", async () => {
  const root = temporaryRoot();
  const previous = process.env.COPILOT_BIN;
  const script = path.join(root, "copilot.js");
  fs.writeFileSync(
    script,
    `if (process.argv.includes("--help")) {
  console.log(${JSON.stringify([...commonOptions, "--no-remote-export"].join("\n"))});
} else {
  console.log(JSON.stringify({ summary: "Chat is not an output artifact" }));
}
`,
  );
  process.env.COPILOT_BIN = script;
  try {
    await assert.rejects(
      copilotBackend().execute(
        {
          directory: root,
          prompt: "Produce a summary.",
          schema: { type: "object" },
          purpose: "stage",
          input: {},
        },
        new AbortController().signal,
      ),
      /exited successfully without writing.*output\.json.*stdout\.log/s,
    );
    assert.equal(fs.existsSync(path.join(root, "output.json")), false);
  } finally {
    if (previous === undefined) delete process.env.COPILOT_BIN;
    else process.env.COPILOT_BIN = previous;
    fs.rmSync(root, { recursive: true });
  }
});

test("large accepted handoffs remain readable in bounded line ranges without losing data", () => {
  const stage = workflow().stages[0];
  const inspection = {
    status: "blocked",
    commands: Array.from({ length: 500 }, (_, index) => ({
      command: `inspect path-${index}`,
      status: "passed",
      summary: "Fixture inspection evidence",
    })),
    blockers: ["Required runtime is unavailable"],
  };
  const stageInput = { inspection };
  const outputs = { inspect: { inspector: inspection } };
  const prompt = stagePrompt(
    stage,
    stage.agents[0],
    [],
    { context: "Fixture" },
    stageInput,
    outputs,
    {},
  );
  assert(
    prompt.split("\n").every((line) => line.length < 20000),
    "Handoffs must not collapse into lines longer than the file reader's output limit",
  );
  const [serializedStageInput, serializedHandoffs] = prompt
    .split("## Stage input\n")[1]
    .split("\n\n## Complete accepted handoffs\n");
  assert.deepEqual(JSON.parse(serializedStageInput), stageInput);
  assert.deepEqual(JSON.parse(serializedHandoffs), outputs);
});
