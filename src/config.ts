import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface CLIConfig {
  collectionPath: string | null;
}

const CONFIG_FILE = path.join(
  os.homedir(),
  ".config",
  "mdbase-tasknotes",
  "config.json",
);

/**
 * Resolve collection path from CLI args, env, config file, or cwd.
 */
export function resolveCollectionPath(args: string[]): string {
  // 1. CLI argument: --collection-path <path>
  const flagIndex = args.indexOf("--collection-path");
  if (flagIndex !== -1 && args[flagIndex + 1]) {
    return path.resolve(args[flagIndex + 1]);
  }

  // 2. Environment variable
  const envPath = process.env.MDBASE_TASKNOTES_PATH;
  if (envPath) {
    return path.resolve(envPath);
  }

  // 3. Config file
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const config: CLIConfig = JSON.parse(raw);
    if (config.collectionPath) {
      return path.resolve(config.collectionPath);
    }
  } catch {
    // No config file or invalid JSON
  }

  // 4. Current working directory
  return process.cwd();
}
