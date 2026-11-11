declare module "cross-spawn/lib/parse.js" {
  import type { SpawnOptions } from "node:child_process";
  export default function parse(
    command: string,
    args: string[],
    options: SpawnOptions,
  ): { file?: string };
}

declare module "cross-spawn/lib/util/escape.js" {
  const escape: {
    command(arg: string): string;
  };
  export default escape;
}
