import assert from "node:assert/strict"
import test from "node:test"
import { setupCli } from "../lib/v2/cli"
import type { CliContext, Report } from "../lib/v2/contracts"

function host() {
    let route = { type: "session", sessionID: "ses_test" }
    let listener!: (event: { location: { directory: string }; data: unknown }) => void
    let render!: () => null
    let run!: (input?: string) => Promise<void>
    let disposed = 0
    let broken = false
    const calls: unknown[] = []
    const toasts: unknown[] = []
    const dialogs: unknown[] = []
    const response: Report = {
        host: "v2",
        sessionID: "ses_test",
        enabled: true,
        commandsEnabled: true,
        manualMode: false,
        compression: "unavailable",
        reason: "No approval API",
        totalPruned: 0,
        estimatedTokensSaved: 0,
        message: "Status report",
        warnings: ["Warning"],
    }
    const context: CliContext = {
        data: { location: { default: () => ({ directory: "/project" }) } },
        client: {
            rpc: () => ({
                async status(input, options) {
                    calls.push({ input, options })
                    if (broken) throw new Error("Disconnected")
                    return response
                },
                async command(input, options) {
                    calls.push({ input, options })
                    return response
                },
                events: {
                    on(_name, callback) {
                        listener = callback
                        return () => {
                            disposed++
                        }
                    },
                },
            }),
        },
        ui: {
            router: { current: () => route },
            toast: {
                show: (input) => {
                    toasts.push(input)
                },
            },
            dialog: {
                async alert(input) {
                    dialogs.push(input)
                },
            },
            slot(input) {
                render = input.render
                return () => {
                    disposed++
                }
            },
        },
        keymap: {
            layer(callback) {
                run = callback().commands[0]!.run
            },
        },
    }
    return {
        context,
        calls,
        toasts,
        dialogs,
        mount: () => render(),
        run: (input?: string) => run(input),
        notify: (directory: string, sessionID: string) =>
            listener({
                location: { directory },
                data: {
                    sessionID,
                    title: "DCP",
                    message: "Pruned output",
                    variant: "info",
                },
            }),
        home: () => {
            route = { type: "home", sessionID: "" }
        },
        disconnect: () => {
            broken = true
        },
        get disposed() {
            return disposed
        },
    }
}

test("V2 CLI registers commands in the host slot and routes arguments via RPC", async () => {
    const ui = host()
    const stop = setupCli(ui.context)
    assert.deepEqual(ui.calls, [])
    ui.mount()
    await ui.run()
    await ui.run(" manual on ")
    assert.deepEqual(ui.calls, [
        { input: { sessionID: "ses_test" }, options: { location: { directory: "/project" } } },
        {
            input: { sessionID: "ses_test", arguments: "manual on" },
            options: { location: { directory: "/project" } },
        },
    ])
    assert.equal(ui.dialogs.length, 2)
    assert.match(JSON.stringify(ui.dialogs[0]), /No approval API/)
    stop()
    assert.equal(ui.disposed, 2)
})

test("V2 CLI ignores notifications from other sessions/locations and cleans up", () => {
    const ui = host()
    const stop = setupCli(ui.context)
    ui.notify("/elsewhere", "ses_test")
    ui.notify("/project", "ses_other")
    assert.equal(ui.toasts.length, 0)
    ui.notify("/project", "ses_test")
    assert.equal(ui.toasts.length, 1)
    stop()
    ui.notify("/project", "ses_test")
    assert.equal(ui.toasts.length, 1)
})

test("V2 CLI handles missing session and disconnected plugin without admitting prompts", async () => {
    const ui = host()
    const stop = setupCli(ui.context)
    ui.mount()
    ui.disconnect()
    await ui.run()
    assert.match(JSON.stringify(ui.toasts[0]), /Disconnected/)
    ui.home()
    await ui.run()
    assert.match(JSON.stringify(ui.toasts[1]), /Open a session/)
    assert.equal(ui.calls.length, 1)
    stop()
})
