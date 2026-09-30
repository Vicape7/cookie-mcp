// The library is meant to run inside edge runtimes too (Cloudflare Workers, Vercel Edge), where a
// bundler resolves dependencies under the `workerd` / `worker` / `browser` conditions instead of
// `node`. Those pick different builds of some deps (Anchor's has no default export and no `Wallet`),
// so a change that is fine under Node can still break every edge consumer. Bundle the barrel and each
// subpath the way such a consumer would, with Node built-ins left to the runtime (`nodejs_compat`).
import { builtinModules } from "node:module";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import { SUBPATHS } from "../tsup.config";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, unknown>;
};

const NOT_SUBPATHS = new Set([".", "./server", "./package.json"]);

describe("package exports", () => {
  it("lists exactly the subpaths tsup builds", () => {
    const libExports = Object.fromEntries(
      Object.entries(pkg.exports).filter(([key]) => !NOT_SUBPATHS.has(key)),
    );
    const expected = Object.fromEntries(
      Object.keys(SUBPATHS).map((name) => [
        `./${name}`,
        { types: `./dist/lib/${name}.d.ts`, import: `./dist/lib/${name}.js` },
      ]),
    );
    expect(libExports).toEqual(expected);
  });
});

describe("edge-runtime bundle", () => {
  const entries: [string, string][] = [
    [".", "src/index.ts"],
    ...Object.entries(SUBPATHS).map(([name, src]): [string, string] => [`./${name}`, src]),
  ];

  it.each(entries)(
    "%s bundles under workerd conditions",
    async (_name, src) => {
      const result = await build({
        entryPoints: [src],
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        conditions: ["workerd", "worker", "browser"],
        external: ["node:*", ...builtinModules],
        logLevel: "silent",
      });
      expect(result.errors).toEqual([]);
    },
    60_000,
  );
});
