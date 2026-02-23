import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveCollectionPath } from "./config.js";
import { createServerContext } from "./context.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const collectionPath = resolveCollectionPath(process.argv.slice(2));

  const ctx = await createServerContext(collectionPath);
  const server = createServer(ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
