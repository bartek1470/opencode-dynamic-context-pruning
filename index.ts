import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import type { ServerContext } from "./lib/v2/contracts"

// Keep both SDK/runtime graphs behind their host's callback. In particular, importing
// this facade on V2 must not evaluate V1's tool() helper or its self-updater.
export default {
    id: "opencode-dcp",
    server: (async (...args) => {
        const { default: server } = await import("./lib/server-v1")
        return server(...args)
    }) satisfies V1Plugin,
    async setup(context: ServerContext) {
        const { setup } = await import("./lib/v2/server")
        return setup(context)
    },
}
