import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import type { Json, Schema } from "../shared/contracts.ts";
import { executeProcess } from "./process-runner.ts";
import type { NamedPaths } from "./path-config.ts";

export type AgentRequest = {
  directory: string;
  prompt: string;
  schema: Schema;
  purpose:
    "schema" | "stage" | "summary" | "watch-condition" | "watch-schedule";
  input: Json;
  model?: string;
  allowAllTools?: boolean;
  allowedFolders?: string[];
  paths?: NamedPaths;
};
export interface AgentBackend {
  id: string;
  diagnostics(): { available: boolean; reason?: string };
  execute(request: AgentRequest, signal: AbortSignal): Promise<Json>;
}

const requiredOptions = [
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
  "--log-dir",
];

export function copilotBackend(): AgentBackend {
  function invocation() {
    const explicit = process.env.COPILOT_BIN;
    const nvm = path.join(os.homedir(), ".nvm", "versions", "node");
    const candidates = explicit
      ? [explicit]
      : [
          "copilot",
          path.join(path.dirname(process.execPath), "copilot"),
          path.join(os.homedir(), ".local/bin/copilot"),
          path.join(os.homedir(), ".config/agency/CurrentVersion/copilot"),
          path.join(os.homedir(), ".volta/bin/copilot"),
          ...(process.platform === "win32" && process.env.APPDATA
            ? [path.join(process.env.APPDATA, "npm", "copilot.cmd")]
            : []),
          ...(fs.existsSync(nvm)
            ? fs
                .readdirSync(nvm)
                .sort()
                .reverse()
                .map((version) => path.join(nvm, version, "bin/copilot"))
            : []),
        ];
    const failures: string[] = [];
    for (const candidate of candidates) {
      const resolved = fs.existsSync(candidate)
        ? fs.realpathSync(candidate)
        : candidate;
      const command = resolved.endsWith(".js") ? process.execPath : candidate;
      const prefix = resolved.endsWith(".js") ? [candidate] : [];
      const probe = spawn.sync(
        command,
        [...prefix, "--no-auto-update", "--help"],
        {
          timeout: 5000,
          encoding: "utf8",
        },
      );
      if (probe.error || probe.status !== 0) continue;
      const options = new Set(probe.stdout.match(/--[a-z][a-z0-9-]*/g));
      const missing = requiredOptions.filter((option) => !options.has(option));
      const historyOption = options.has("--sync-session")
        ? "--sync-session=off"
        : options.has("--no-remote-export")
          ? "--no-remote-export"
          : undefined;
      if (!historyOption) missing.push("--sync-session or --no-remote-export");
      if (missing.length || !historyOption) {
        failures.push(`${candidate}: missing ${missing.join(", ")}`);
        continue;
      }
      const warnings = options.has("--disable-client-telemetry")
        ? []
        : ["Installed Copilot CLI cannot disable client telemetry."];
      return { command, prefix, options, historyOption, warnings };
    }
    throw new Error(
      failures.length
        ? `Incompatible Copilot CLI: ${failures.join("; ")}`
        : "Copilot CLI unavailable. Install and authenticate it, or set COPILOT_BIN.",
    );
  }
  return {
    id: "copilot",
    diagnostics() {
      try {
        const { warnings } = invocation();
        return {
          available: true,
          ...(warnings.length ? { reason: warnings.join(" ") } : {}),
        };
      } catch (error) {
        return {
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async execute(request, signal) {
      const { command, prefix, options, historyOption, warnings } =
        invocation();
      for (const warning of warnings) console.warn(warning);
      if (request.allowAllTools && !options.has("--allow-all-urls"))
        throw new Error(
          "Installed Copilot CLI does not support --allow-all-urls.",
        );
      fs.mkdirSync(request.directory, { recursive: true });
      const pathTools = request.paths && Object.keys(request.paths).length > 0;
      if (pathTools && !options.has("--additional-mcp-config"))
        throw new Error(
          "Installed Copilot CLI cannot expose the configured get_path tool (--additional-mcp-config missing).",
        );
      const pathsFile = path.join(request.directory, "paths.json");
      if (pathTools)
        fs.writeFileSync(pathsFile, JSON.stringify(request.paths), {
          mode: 0o600,
        });
      const promptFile = path.join(request.directory, "prompt.md");
      const outputFile = path.join(request.directory, "output.json");
      const allowedFolders = request.allowedFolders ?? [];
      const folderInstructions = allowedFolders.length
        ? `\n\nExplicitly allowed folders (read and write):\n${JSON.stringify(allowedFolders)}`
        : "";
      const restrictions = request.allowAllTools
        ? ""
        : allowedFolders.length
          ? "\nWrite only in this attempt directory or the explicitly allowed folders. Do not publish or delegate."
          : "\nDo not write outside this attempt directory. Do not publish, delegate, or modify source.";
      fs.writeFileSync(
        promptFile,
        [
          "## Required output artifact",
          `Output file: ${outputFile}`,
          "Before finishing, write your successful result to this exact file as JSON matching the schema below.",
          request.purpose === "stage"
            ? 'Report the actual task outcome, not just whether your session finished: "completed" when the requested task was accomplished, "blocked" when a prerequisite or external dependency prevented completion, or "failed" when the task was attempted but could not be completed. For blocked or failed tasks, use the corresponding schema-supported shape; otherwise write {"status":"blocked","summary":"<specific actionable error>"} or {"status":"failed","summary":"<specific actionable error>"} as a runtime failure envelope, even when the success schema is a primitive. Both stop the run without publishing a successful result. Never fabricate a schema-compliant success, including 0, to represent failure.'
            : "For blocked tasks, still write a schema-compliant result using only supported fields and status values.",
          "A final chat response or a separate audit receipt does not satisfy this contract.",
          ...(process.platform === "win32"
            ? [
                "## Native Windows host\nUse native Windows paths and PowerShell-compatible commands, not WSL or POSIX-only utilities. Instruction examples may use POSIX notation: adapt the shell syntax without changing the operation or arguments. Invoke a quoted executable with PowerShell's & operator; NODE_BIN contains node.exe. Named paths are tool results, not shell environment variables.",
              ]
            : []),
          `${folderInstructions}${restrictions}`,
          ...(pathTools
            ? [
                `## Named paths\nUse the strand-paths get_path tool to resolve named paths before working with them. Available names: ${Object.keys(request.paths!).join(", ")}. These values are pinned for this run. Do not read .env or assume shell environment variables contain these names.`,
              ]
            : []),
          `## Required output schema\n${JSON.stringify(request.schema, null, 2)}`,
          `## Task\n${request.prompt}`,
        ].join("\n\n"),
        { mode: 0o600 },
      );
      const args = [
        ...prefix,
        "--prompt",
        `Read and execute ${promptFile}. Before finishing, write the required JSON result to ${outputFile}, following the schema at the start of the task file. Do not return the result only in chat.`,
        "--no-ask-user",
        ...(options.has("--trust-folder") ? ["--trust-folder"] : []),
        "--no-custom-instructions",
        ...(request.allowAllTools ? [] : ["--disable-builtin-mcps"]),
        "--no-auto-update",
        ...(options.has("--disable-client-telemetry")
          ? ["--disable-client-telemetry"]
          : []),
        historyOption,
        "--disallow-temp-dir",
        "--add-dir",
        request.directory,
        ...allowedFolders.flatMap((folder) => ["--add-dir", folder]),
        ...(pathTools
          ? [
              "--additional-mcp-config",
              JSON.stringify({
                mcpServers: {
                  "strand-paths": {
                    type: "local",
                    command: process.execPath,
                    args: [
                      fileURLToPath(
                        new URL(
                          import.meta.url.endsWith(".js")
                            ? "./path-tool.js"
                            : "./path-tool.ts",
                          import.meta.url,
                        ),
                      ),
                      pathsFile,
                    ],
                    tools: ["get_path"],
                  },
                },
              }),
            ]
          : []),
        ...(request.allowAllTools
          ? ["--allow-all-urls"]
          : [
              "--available-tools",
              "view",
              "create",
              "edit",
              "apply_patch",
              ...(pathTools ? ["strand-paths"] : []),
            ]),
        "--allow-all-tools",
        "--log-dir",
        path.join(request.directory, "cli-logs"),
        "--model",
        request.model ?? "gpt-6-astra",
      ];
      await executeProcess(request.directory, command, args, signal);
      return readOutput(outputFile);
    },
  };
}

function readOutput(file: string): Json {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new Error(
        `Copilot CLI exited successfully without writing the required output artifact: ${file}. A final chat response is not a result file. Inspect ${path.join(path.dirname(file), "stdout.log")} and ${path.join(path.dirname(file), "stderr.log")} for the agent's outcome.`,
        { cause: error },
      );
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
    throw new Error("Agent output must be a regular JSON file under 4 MiB");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
