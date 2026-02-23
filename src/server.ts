import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "./context.js";
import { registerTaskCrudTools } from "./tools/task-crud.js";
import { registerTaskActionTools } from "./tools/task-actions.js";
import { registerQueryTools } from "./tools/query.js";
import { registerTimeTrackingTools } from "./tools/time-tracking.js";
import { registerHealthTools } from "./tools/health.js";

export function createServer(ctx: ServerContext): McpServer {
  const server = new McpServer({
    name: "mdbase-tasknotes-mcp",
    version: "0.1.0",
  });

  registerTaskCrudTools(server, ctx);
  registerTaskActionTools(server, ctx);
  registerQueryTools(server, ctx);
  registerTimeTrackingTools(server, ctx);
  registerHealthTools(server, ctx);

  return server;
}
