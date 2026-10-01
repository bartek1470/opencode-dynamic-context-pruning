import { defineConfig } from "tsup"

export default defineConfig({
    entry: ["index.ts", "lib/v2/rpc.ts"],
    format: ["esm"],
    splitting: true,
    dts: false,
    clean: true,
    sourcemap: true,
    noExternal: ["jsonc-parser"], // Bundle this to fix its broken ESM imports
})
