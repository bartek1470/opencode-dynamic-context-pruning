// Exercises the actual unpacked facade under isolated config with fake host
// contexts. This is artifact validation, not a live OpenCode loader test.
import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"

const packageDirectory = process.argv[2]
const { default: definition } = await import(
    pathToFileURL(`${packageDirectory}/dist/index.js`).href
)
assert.equal(definition.id, "opencode-dcp")
const hooks = await definition.server({ directory: packageDirectory, client: {} }, {})
assert.equal(typeof hooks["experimental.chat.messages.transform"], "function")
assert.equal(typeof hooks["experimental.text.complete"], "function")
assert.equal(typeof hooks.config, "function")
assert.equal(typeof hooks.tool.compress.execute, "function")

let registrations = 0,
    disposed = 0
const registration = () => {
    registrations++
    return {
        async dispose() {
            disposed++
        },
    }
}
const cleanup = await definition.setup({
    location: { directory: packageDirectory, project: { id: "test_project" } },
    storage: { async get() {}, async set() {}, async remove() {} },
    session: {
        async get() {
            throw new Error("not called during setup")
        },
        async context() {
            return []
        },
        async hook(name) {
            assert.equal(name, "context")
            return registration()
        },
    },
    rpc: {
        async register(def, handlers) {
            assert.equal(def.id, "opencode-dcp")
            assert.equal(typeof handlers.status, "function")
            return { ...registration(), events: { async emit() {} } }
        },
    },
    command: {
        async transform(callback) {
            const names = []
            callback({ add: (command) => names.push(command.name) })
            assert.deepEqual(names, ["dcp", "dcp-compress"])
            return registration()
        },
    },
})
assert.equal(typeof cleanup, "function")
await cleanup()
assert.equal(registrations, 3)
assert.equal(disposed, registrations)

// The source TUI facade's V2 callback must work without importing its V1 JSX graph.
const { default: tui } = await import(pathToFileURL(`${packageDirectory}/tui.tsx`).href)
assert.equal(typeof tui.tui, "function")
assert.equal(typeof tui.setup, "function")
let stopped = 0
const unmount = await tui.setup({
    client: {
        rpc: () => ({
            events: {
                on: () => () => {
                    stopped++
                },
            },
        }),
    },
    ui: {
        slot: () => () => {
            stopped++
        },
    },
})
unmount()
assert.equal(stopped, 2)
console.log("unpacked dual server and V2 source-TUI smoke checks passed (fake hosts)")
