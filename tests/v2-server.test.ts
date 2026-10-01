import assert from "node:assert/strict"
import test from "node:test"
import { setup, storageKey, decodeState, createSerialQueue } from "../lib/v2/server"
import { config, fakeHost } from "./v2-fixtures"

test("V2 registers RPC, context and owned commands without any compression tool or model input", async () => {
    const host = fakeHost()
    const cleanup = await setup(host.context, config())
    assert.deepEqual(
        host.commands.map((c) => c.name),
        ["dcp", "dcp-compress"],
    )
    const status = await host.rpc.status({ sessionID: "ses_test" })
    assert.equal(status.compression, "unavailable")
    assert.match(status.reason, /authorization/)
    for (const permission of ["allow", "ask", "deny"] as const) {
        const cfg = config()
        cfg.compress.permission = permission
        const other = fakeHost()
        const stop = await setup(other.context, cfg)
        for (const name of ["compress", "decompress", "recompress", "sweep"]) {
            assert.match(
                (await other.rpc.command({ sessionID: "ses_test", arguments: name })).message,
                /unavailable/,
            )
        }
        assert.equal(other.storage.size, 0)
        await stop()
    }
    await host.commands[1]!.execute({
        sessionID: "ses_test",
        prompt: { text: "focus" },
        delivery: "queue",
    })
    assert.match(host.notices[0]!.message, /unavailable/)
    await cleanup()
    assert.equal(host.disposed, 3)
    await assert.rejects(host.rpc.status({ sessionID: "ses_test" }), /unloaded/)
})

test("V2 state and statistics are server-owned, isolated, and deduplicated on fresh request retries", async () => {
    const host = fakeHost()
    const cfg = config()
    cfg.pruneNotification = "detailed"
    const cleanup = await setup(host.context, cfg)
    const first = await host.request()
    assert.notDeepEqual(first.messages, host.data.messages)
    const firstState = await host.rpc.status({ sessionID: "ses_test" })
    assert.equal(firstState.totalPruned, 1)
    await host.request()
    assert.equal((await host.rpc.status({ sessionID: "ses_test" })).totalPruned, 1)
    assert.equal(host.notices.length, 1)
    assert.equal((await host.rpc.status({ sessionID: "ses_other" })).totalPruned, 0)
    assert.equal(host.storage.size, 1)
    assert.equal(host.storage.has(storageKey(host.context, "ses_test")), true)
    await cleanup()
})

test("V2 manual mode mutations serialize and persist across adapter restart", async () => {
    const host = fakeHost()
    const cfg = config()
    cfg.manualMode.automaticStrategies = false
    let stop = await setup(host.context, cfg)
    await Promise.all(
        [1, 2].map(() => host.rpc.command({ sessionID: "ses_test", arguments: "manual" })),
    )
    assert.equal((await host.rpc.status({ sessionID: "ses_test" })).manualMode, false)
    await host.rpc.command({ sessionID: "ses_test", arguments: "manual on" })
    assert.deepEqual((await host.request()).messages, host.data.messages)
    await stop()
    stop = await setup(host.context, cfg)
    assert.equal((await host.rpc.status({ sessionID: "ses_test" })).manualMode, true)
    await host.rpc.command({ sessionID: "ses_test", arguments: "manual off" })
    assert.notDeepEqual((await host.request()).messages, host.data.messages)
    await stop()
})

test("V2 excludes child sessions, wrong locations and storage failures conservatively", async () => {
    for (const failure of ["child", "move", "failWrite"] as const) {
        const host = fakeHost()
        const stop = await setup(host.context, config())
        host[failure]()
        assert.deepEqual((await host.request()).messages, host.data.messages, failure)
        assert.equal(host.storage.size, 0)
        if (failure === "move")
            await assert.rejects(host.rpc.status({ sessionID: "ses_test" }), /different location/)
        await stop()
    }
})

test("V2 disabled configuration leaves status readable but prevents commands and pruning", async () => {
    const host = fakeHost()
    const cfg = config()
    cfg.enabled = false
    const stop = await setup(host.context, cfg)
    assert.equal(host.commands.length, 0)
    assert.deepEqual((await host.request()).messages, host.data.messages)
    assert.match(
        (await host.rpc.command({ sessionID: "ses_test", arguments: "manual" })).message,
        /disabled/,
    )
    assert.equal(host.storage.size, 0)
    await stop()
})

test("V2 rejects invalid state and malformed RPC input instead of silently resetting mode", async () => {
    assert.throws(() => decodeState({}, false), /invalid/)
    const host = fakeHost()
    const stop = await setup(host.context, config())
    for (const input of [{}, { sessionID: "../other" }, { sessionID: "ses_test", arguments: 1 }]) {
        await assert.rejects(host.rpc.command(input))
    }
    assert.equal(host.storage.size, 0)
    await stop()
})

test("V2 enforces runtime workspace identity even when released client types omit it", async () => {
    const host = fakeHost()
    host.context.location.workspaceID = "workspace_a"
    const get = host.context.session.get
    host.context.session.get = async (...args) => {
        const session = await get(...args)
        Object.assign(session.location, { workspaceID: "workspace_b" })
        return session
    }
    const stop = await setup(host.context, config())
    await assert.rejects(
        host.rpc.command({ sessionID: "ses_test", arguments: "manual on" }),
        /different location/,
    )
    assert.equal(host.storage.size, 0)
    await stop()
})

test("V2 unload drains an already-started write before allowing adapter replacement", async () => {
    const host = fakeHost()
    const write = host.context.storage.set
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => {
        entered = resolve
    })
    const waiting = new Promise<void>((resolve) => {
        release = resolve
    })
    host.context.storage.set = async (...args) => {
        entered()
        await waiting
        await write(...args)
    }
    const stop = await setup(host.context, config())
    const old = host.rpc.command({ sessionID: "ses_test", arguments: "manual on" })
    await started
    let cleaned = false
    const cleaning = stop().then(() => {
        cleaned = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(cleaned, false)
    release()
    await old
    await cleaning
    host.context.storage.set = write
    const replacementStop = await setup(host.context, config())
    await host.rpc.command({ sessionID: "ses_test", arguments: "manual off" })
    assert.equal((await host.rpc.status({ sessionID: "ses_test" })).manualMode, false)
    await replacementStop()
})

test("serial queue recovers after rejected work and does not block another session", async () => {
    const serial = createSerialQueue()
    let finish!: () => void
    const waiting = serial(
        "a",
        () =>
            new Promise<void>((resolve) => {
                finish = resolve
            }),
    )
    assert.equal(await serial("b", async () => "independent"), "independent")
    finish()
    await waiting
    await assert.rejects(
        serial("a", async () => {
            throw new Error("failed")
        }),
    )
    assert.equal(await serial("a", async () => "recovered"), "recovered")
})
