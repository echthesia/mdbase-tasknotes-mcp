import { defineConfig } from "tsup";
import path from "node:path";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  splitting: false,
  noExternal: ["tasknotes-nlp-core", "rrule"],
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias || {}),
      rrule: path.resolve("src/lib/shims/rrule.ts"),
    };
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});
