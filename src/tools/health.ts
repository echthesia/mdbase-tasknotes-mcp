import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";

export function registerHealthTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "tasknotes_health_check",
    {
      description: "Verify the MCP server is running and the collection is accessible. Returns status, collection path, and task count.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await ctx.collection.query({
          types: ["task"],
          limit: 0,
        });

        const taskCount = result.meta?.total_count ?? 0;

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "ok",
              collectionPath: ctx.collectionPath,
              taskCount,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "error",
              collectionPath: ctx.collectionPath,
              error: (err as Error).message,
            }, null, 2),
          }],
          isError: true,
        };
      }
    },
  );
}
