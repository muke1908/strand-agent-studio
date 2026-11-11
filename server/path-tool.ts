import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { namedPathsSchema } from "./path-config.ts";
import { readJson } from "./files.ts";

const paths = namedPathsSchema.parse(readJson(process.argv[2]));
const server = new McpServer({ name: "strand-paths", version: "1.0.0" });
server.registerTool(
  "get_path",
  {
    description:
      "Return one named filesystem path pinned for this run. This tool never reads arbitrary environment variables or grants permissions.",
    inputSchema: { name: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/) },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async ({ name }) => {
    if (!Object.hasOwn(paths, name))
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Path "${name}" is not configured for this run.`,
          },
        ],
      };
    return {
      content: [
        { type: "text", text: JSON.stringify({ name, path: paths[name] }) },
      ],
      structuredContent: { name, path: paths[name] },
    };
  },
);
await server.connect(new StdioServerTransport());
