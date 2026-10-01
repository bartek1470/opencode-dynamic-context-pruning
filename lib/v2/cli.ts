import { isRecord, type CliContext, type Notice } from "./contracts"
import { DcpRpc } from "./rpc"

function formatReport(input: unknown): string {
    if (
        !isRecord(input) ||
        input.host !== "v2" ||
        typeof input.message !== "string" ||
        typeof input.reason !== "string"
    ) {
        throw new Error("DCP server returned an invalid report.")
    }
    const warnings = Array.isArray(input.warnings)
        ? input.warnings.filter((item): item is string => typeof item === "string")
        : []
    return [
        `DCP ${input.enabled ? "enabled" : "disabled"}; manual mode ${input.manualMode ? "on" : "off"}.`,
        input.message,
        input.reason,
        ...warnings,
    ].join("\n\n")
}

export function setupCli(context: CliContext) {
    const client = context.client.rpc(DcpRpc)
    const location = () => context.location ?? context.data.location.default()
    let stopped = false
    const run = async (args?: string) => {
        const route = context.ui.router.current()
        if (route.type !== "session" || !route.sessionID) {
            context.ui.toast.show({
                title: "DCP",
                message: "Open a session first.",
                variant: "info",
            })
            return
        }
        try {
            const options = { location: location() }
            const result = args?.trim()
                ? await client.command(
                      { sessionID: route.sessionID, arguments: args.trim() },
                      options,
                  )
                : await client.status({ sessionID: route.sessionID }, options)
            if (!stopped)
                await context.ui.dialog.alert({ title: "DCP · V2", message: formatReport(result) })
        } catch (error) {
            if (!stopped)
                context.ui.toast.show({
                    title: "DCP unavailable",
                    variant: "warning",
                    message:
                        error instanceof Error
                            ? error.message
                            : "Check that the DCP server plugin is loaded and connected.",
                })
        }
    }
    const unsubscribe = client.events.on("notify", (event) => {
        if (stopped) return
        const current = location()
        if (
            event.location.directory !== current.directory ||
            event.location.workspaceID !== current.workspaceID
        )
            return
        const data = event.data
        if (
            !isRecord(data) ||
            typeof data.message !== "string" ||
            typeof data.title !== "string" ||
            typeof data.sessionID !== "string"
        )
            return
        const route = context.ui.router.current()
        if (route.type !== "session" || route.sessionID !== data.sessionID) return
        const variant: Notice["variant"] =
            data.variant === "warning" || data.variant === "error" || data.variant === "success"
                ? data.variant
                : "info"
        context.ui.toast.show({ title: data.title, message: data.message, variant })
    })
    // Host-owned alert dialogs avoid importing either generation's renderer.
    // Keymaps must be mounted in a Solid owner, not directly in plugin setup.
    let unmount: () => void
    try {
        unmount = context.ui.slot({
            append: "app",
            render() {
                context.keymap.layer(() => ({
                    mode: "global",
                    commands: [
                        {
                            id: "dcp.panel",
                            title: "DCP",
                            palette: true,
                            slash: { name: "dcp", arguments: true },
                            run,
                        },
                    ],
                }))
                return null
            },
        })
    } catch (error) {
        unsubscribe()
        throw error
    }
    return () => {
        stopped = true
        unsubscribe()
        unmount()
    }
}
