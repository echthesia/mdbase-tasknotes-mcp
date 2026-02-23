import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import path from "node:path";
import { createServerContext } from "./context.js";
import { createServer } from "./server.js";

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

function fatal(msg: string): never {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) fatal(`${name} is required`);
  return value;
}

// ---------------------------------------------------------------------------
// OAuth metadata fetching
// ---------------------------------------------------------------------------

async function fetchOAuthMetadata(issuer: URL): Promise<OAuthMetadata> {
  // Ensure trailing slash so .well-known paths resolve correctly for
  // issuers with non-root paths (e.g., multi-tenant identity providers)
  const base = issuer.href.endsWith("/") ? issuer : new URL(issuer.href + "/");
  const endpoints = [
    new URL(".well-known/openid-configuration", base),
    new URL(".well-known/oauth-authorization-server", base),
  ];

  for (const endpoint of endpoints) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(endpoint.toString(), {
        signal: controller.signal,
      });

      if (!res.ok) {
        clearTimeout(timeout);
        continue;
      }

      const metadata = (await res.json()) as OAuthMetadata;
      clearTimeout(timeout);

      if (
        !metadata.issuer ||
        !metadata.authorization_endpoint ||
        !metadata.token_endpoint
      ) {
        continue;
      }

      return metadata;
    } catch {
      continue;
    }
  }

  fatal(
    `Could not fetch OAuth metadata from ${issuer}. Tried .well-known/openid-configuration and .well-known/oauth-authorization-server`,
  );
}

// ---------------------------------------------------------------------------
// JWT token verifier
// ---------------------------------------------------------------------------

function createTokenVerifier(
  issuer: string,
  audience: string,
  jwksUri: URL,
): OAuthTokenVerifier {
  const JWKS = createRemoteJWKSet(jwksUri);

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      try {
        const { payload } = await jwtVerify(token, JWKS, {
          issuer,
          audience,
          algorithms: ["RS256", "PS256"],
        });

        const clientId =
          (payload.azp as string | undefined) ??
          (payload.sub as string | undefined);

        if (!clientId) {
          console.error(
            "Token verification failed: missing sub and azp claims",
          );
          throw new InvalidTokenError("Token verification failed");
        }

        const scopes: string[] =
          typeof payload.scope === "string"
            ? payload.scope.split(" ").filter(Boolean)
            : [];

        return {
          token,
          clientId,
          scopes,
          expiresAt: payload.exp,
        };
      } catch (err) {
        if (err instanceof InvalidTokenError) throw err;
        console.error("Token verification failed:", err);
        throw new InvalidTokenError("Token verification failed");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Resolve collection path and create shared context
  const collectionPath = path.resolve(requireEnv("MDBASE_TASKNOTES_PATH"));
  const ctx = await createServerContext(collectionPath);

  // 2. Read config
  const port = parseInt(process.env["PORT"] ?? "3000", 10);
  const oauthAudience = requireEnv("OAUTH_AUDIENCE");

  let issuerUrl: URL;
  let serverUrl: URL;
  try {
    issuerUrl = new URL(requireEnv("OAUTH_ISSUER_URL"));
  } catch {
    fatal(
      `OAUTH_ISSUER_URL is not a valid URL: ${process.env["OAUTH_ISSUER_URL"]}`,
    );
  }
  try {
    serverUrl = new URL(requireEnv("SERVER_URL"));
  } catch {
    fatal(`SERVER_URL is not a valid URL: ${process.env["SERVER_URL"]}`);
  }

  // Validate OAUTH_ISSUER_URL uses HTTPS (except localhost)
  if (
    issuerUrl.protocol !== "https:" &&
    issuerUrl.hostname !== "localhost" &&
    issuerUrl.hostname !== "127.0.0.1"
  ) {
    fatal("OAUTH_ISSUER_URL must use HTTPS (except for localhost)");
  }

  const allowedOrigins = requireEnv("ALLOWED_ORIGINS")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  // 3. Fetch OAuth metadata
  console.log(`Fetching OAuth metadata from ${issuerUrl}...`);
  const oauthMetadata = await fetchOAuthMetadata(issuerUrl);
  console.log(`OAuth metadata fetched. Issuer: ${oauthMetadata.issuer}`);

  // Validate issuer matches configured value
  const expectedIssuer = issuerUrl.toString().replace(/\/$/, "");
  const actualIssuer = oauthMetadata.issuer.replace(/\/$/, "");
  if (expectedIssuer !== actualIssuer) {
    fatal(
      `Issuer mismatch: expected ${expectedIssuer}, got ${actualIssuer}`,
    );
  }

  // 4. Extract jwks_uri
  const jwksUriRaw = (oauthMetadata as Record<string, unknown>)["jwks_uri"];
  if (typeof jwksUriRaw !== "string") {
    fatal("OAuth metadata does not contain a valid jwks_uri string");
  }
  const jwksUri = new URL(jwksUriRaw);

  // 5. Create token verifier
  const verifier = createTokenVerifier(
    oauthMetadata.issuer,
    oauthAudience,
    jwksUri,
  );

  // 6. Build resource metadata URL and auth middleware
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(serverUrl);
  const authMiddleware = requireBearerAuth({
    verifier,
    requiredScopes: [],
    resourceMetadataUrl,
  });

  // 7. Express app setup
  const app = express();
  app.set("trust proxy", "loopback");

  app.use(express.json());

  app.use(
    cors({
      origin: allowedOrigins,
      exposedHeaders: ["Mcp-Session-Id"],
    }),
  );

  // 8. Mount auth metadata router (unauthenticated)
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: serverUrl,
    }),
  );

  // 9. Session management
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const sessionOwners: Record<string, string> = {};
  const allowedHosts = [serverUrl.host];

  function getSessionId(req: express.Request): string | undefined {
    const raw = req.headers["mcp-session-id"];
    return Array.isArray(raw) ? raw[0] : raw;
  }

  // 10. POST /mcp (authenticated)
  app.post("/mcp", authMiddleware, async (req, res) => {
    const auth = req.auth as AuthInfo | undefined;
    if (!auth?.clientId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const sessionId = getSessionId(req);

    if (sessionId && transports[sessionId]) {
      if (sessionOwners[sessionId] !== auth.clientId) {
        res
          .status(403)
          .json({ error: "Session belongs to a different client" });
        return;
      }
      await transports[sessionId]!.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const server = createServer(ctx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
          sessionOwners[sid] = auth.clientId;
          console.log(`Session ${sid} created for client ${auth.clientId}`);
        },
        onsessionclosed: (sid) => {
          delete transports[sid];
          delete sessionOwners[sid];
          void server.close().catch(console.error);
          console.log(`Session ${sid} closed`);
        },
        enableDnsRebindingProtection: true,
        allowedHosts,
        allowedOrigins,
      });

      await server.connect(transport);

      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      error:
        "Bad request: missing Mcp-Session-Id header or not an initialize request",
    });
  });

  // 11. GET /mcp (authenticated) — SSE stream
  app.get("/mcp", authMiddleware, async (req, res) => {
    const auth = req.auth as AuthInfo | undefined;
    if (!auth?.clientId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const sessionId = getSessionId(req);

    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }

    if (sessionOwners[sessionId] !== auth.clientId) {
      res.status(403).json({ error: "Session belongs to a different client" });
      return;
    }

    await transports[sessionId]!.handleRequest(req, res);
  });

  // 12. DELETE /mcp (authenticated) — session termination
  app.delete("/mcp", authMiddleware, async (req, res) => {
    const auth = req.auth as AuthInfo | undefined;
    if (!auth?.clientId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const sessionId = getSessionId(req);

    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }

    if (sessionOwners[sessionId] !== auth.clientId) {
      res.status(403).json({ error: "Session belongs to a different client" });
      return;
    }

    await transports[sessionId]!.handleRequest(req, res);
  });

  // 13. Error handler (prevent stack trace leakage)
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("Unhandled error:", err);
      res.status(500).json({ error: "Internal server error" });
    },
  );

  // 14. Start listening
  const httpServer = app.listen(port, () => {
    console.log(`MCP HTTP server listening on port ${port}`);
    console.log(`Server URL: ${serverUrl}`);
    console.log(`Collection path: ${collectionPath}`);
    console.log(`Protected resource metadata: ${resourceMetadataUrl}`);
  });

  // 15. Graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    console.log(`\n${signal} received, shutting down...`);
    httpServer.close();
    await Promise.allSettled(
      Object.entries(transports).map(async ([sid, transport]) => {
        console.log(`Closing session ${sid}`);
        await transport.close();
      }),
    );
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT").catch(console.error));
  process.on("SIGTERM", () => void shutdown("SIGTERM").catch(console.error));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
