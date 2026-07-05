import esbuild from "esbuild";
import { readFile } from "fs/promises";

const production = process.argv.includes("production");
const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));

const options = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2020",
  outfile: "index.js",
  sourcemap: !production ? "inline" : false,
  minify: production,
  define: {
    "process.env.NODE_ENV": production ? '"production"' : '"development"',
  },
  legalComments: "none",
  logLevel: "info",
  // siyuan types come from @types/siyuan via `siyuan` package; require is unused at runtime
  external: [],
};

if (production) {
  await esbuild.build(options);
} else {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[esbuild] watching...");
}
