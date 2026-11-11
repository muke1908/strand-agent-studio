import path from "node:path";
import type {
  SpawnOptions,
  SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import crossSpawn from "cross-spawn";
import parse from "cross-spawn/lib/parse.js";
import escape from "cross-spawn/lib/util/escape.js";

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
        ...args.map((arg) => escape.argument(arg, true)),
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
