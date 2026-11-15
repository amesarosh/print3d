// Bundles the main process, preload script and renderer into dist/.
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
const common = { bundle: true, sourcemap: true, logLevel: "info" };

await Promise.all([
  // Main process: ESM, node_modules stay external (the SDK spawns its own binary).
  build({ ...common, entryPoints: ["src/main/main.ts"], outfile: "dist/main.mjs",
    platform: "node", format: "esm", packages: "external" }),
  // Preload runs sandboxed, so it must be a single CommonJS file.
  build({ ...common, entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs",
    platform: "node", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/renderer/index.tsx"], outfile: "dist/renderer.js",
    platform: "browser", format: "iife", jsx: "automatic", minify: true,
    loader: { ".woff2": "file", ".woff": "file" }, assetNames: "fonts/[name]-[hash]" }),
  copyFile("src/renderer/index.html", "dist/index.html"),
  copyFile("build/icon.png", "dist/icon.png"),
]);
