import { registerCommands } from "./commands"
import { loadConfig } from "./data"
import { openPanelModal } from "./modals"
import type { TuiApi } from "./types"

export async function setupV1Tui(api: TuiApi) {
    const config = loadConfig(api)
    if (!config.enabled || !config.commands.enabled) return

    registerCommands(api, [
        {
            title: "DCP",
            name: "dcp.panel",
            description: "Open DCP panel",
            slashName: "dcp",
            run: () => openPanelModal(api, config),
        },
    ])
}
