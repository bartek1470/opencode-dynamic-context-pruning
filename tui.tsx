/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { CliContext } from "./lib/v2/contracts"

const tui: TuiPluginModule["tui"] = async (api) => {
    const { setupV1Tui } = await import("./lib/tui/setup")
    return setupV1Tui(api)
}

export default {
    id: "opencode-dcp",
    tui,
    async setup(context: CliContext) {
        const { setupCli } = await import("./lib/v2/cli")
        return setupCli(context)
    },
}
