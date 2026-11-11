import path from "node:path";
import type {
  SpawnOptions,
  SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import crossSpawn from "cross-spawn";
import parse from "cross-spawn/lib/parse.js";
import escape from "cross-spawn/lib/util/escape.js";

function shimArgument(value: string): string {
  // Quote in one pass: cross-spawn's quoting loses runs of backslashes before quotes.
  const quoted = value.replace(/\\+|"/g, (part, offset: number) => {
    if (part === '"') return '\\"';
    const next = value[offset + part.length];
    return next === '"' || next === undefined ? part + part : part;
  });
  return escape.command(escape.command(`"${quoted}"`));
}

function invocation<T extends SpawnOptions>(
  command: string,
  args: string[],
  options: T,
): [string, string[], T] {
  if (process.platform === "win32") {
    const { file } = parse(command, args, options);
    if (file && /\.(cmd|bat)$/i.test(file)) {
      // Global shims reparse arguments too; cross-spawn only handles local npm shims.
      const line = [
        escape.command(path.normalize(file)),
        ...args.map(shimArgument),
      ].join(" ");
      return [
        process.env.ComSpec || "cmd.exe",
        ["/d", "/s", "/v:off", "/c", `"${line}"`],
        { ...options, windowsVerbatimArguments: true },
      ];
    }
  }
  return [command, args, options];
}

export const spawn = Object.assign(
  (command: string, args: string[], options: SpawnOptions) =>
    crossSpawn(...invocation(command, args, options)),
  {
    sync: (
      command: string,
      args: string[],
      options: SpawnSyncOptionsWithStringEncoding,
    ) => crossSpawn.sync(...invocation(command, args, options)),
  },
);
