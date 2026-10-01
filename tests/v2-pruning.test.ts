import assert from "node:assert/strict"
import test from "node:test"
import type { SessionMessageInfo } from "@opencode/client"
import { pruneRequest, REMOVED_INPUT, REMOVED_OUTPUT } from "../lib/v2/pruning"
import { config, fixture } from "./v2-fixtures"

test("V2 deduplication maps ID-less results without removing protocol parts or mutating history", () => {
    const data = fixture()
    const before = structuredClone(data)
    const result = pruneRequest(data.messages, data.transcript, config(), false)
    assert.equal(result.changes.length, 1)
    assert.equal(result.changes[0]?.reason, "duplicate")
    assert.equal(result.messages.length, data.messages.length)
    assert.equal(
        (result.messages[1] as (typeof data.messages)[number]).content[0]?.result?.value,
        REMOVED_OUTPUT,
    )
    assert.equal(
        (result.messages[3] as (typeof data.messages)[number]).content[0]?.result?.value,
        data.text,
    )
    assert.deepEqual(data, before)
    assert.equal(pruneRequest(result.messages, data.transcript, config(), false).changes.length, 0)
})

test("V2 error purging removes only old string inputs and preserves the exact error result", () => {
    const data = fixture({
        error: true,
        input: {
            filePath: "/src/file.ts",
            payload: "lengthy failed input ".repeat(100),
            numeric: 42,
        },
    })
    const result = pruneRequest(data.messages, data.transcript, config(), false)
    assert.equal(result.changes.length, 1)
    assert.equal(result.changes[0]?.reason, "error")
    const part = (result.messages[0] as (typeof data.messages)[number]).content[0]
    assert.deepEqual(part?.input, { filePath: REMOVED_INPUT, payload: REMOVED_INPUT, numeric: 42 })
    assert.strictEqual(result.messages[1], data.messages[1])
})

test("V2 manual mode, disabled strategies and turn protection suppress edits", () => {
    const data = fixture()
    const cfg = config()
    cfg.manualMode.automaticStrategies = false
    assert.equal(pruneRequest(data.messages, data.transcript, cfg, true).changes.length, 0)
    cfg.turnProtection = { enabled: true, turns: 2 }
    assert.equal(pruneRequest(data.messages, data.transcript, cfg, false).changes.length, 0)
    cfg.turnProtection.enabled = false
    cfg.strategies.deduplication.enabled = false
    assert.equal(pruneRequest(data.messages, data.transcript, cfg, false).changes.length, 0)
})

test("V2 protects tool globs, file globs, and unknown path shapes", () => {
    const cfg = config()
    cfg.strategies.deduplication.protectedTools = ["r*"]
    const data = fixture()
    assert.equal(pruneRequest(data.messages, data.transcript, cfg, false).changes.length, 0)
    cfg.strategies.deduplication.protectedTools = []
    cfg.protectedFilePatterns = ["/src/**"]
    assert.equal(pruneRequest(data.messages, data.transcript, cfg, false).changes.length, 0)
    const custom = fixture({ input: { script: "read a protected file" } })
    assert.equal(pruneRequest(custom.messages, custom.transcript, cfg, false).changes.length, 0)
})

test("V2 preserves Code Mode, subagent, interaction, and edit/write outputs", () => {
    for (const name of [
        "execute",
        "subagent",
        "task",
        "skill",
        "question",
        "edit",
        "write",
        "patch",
        "compress",
    ]) {
        const data = fixture({ name })
        assert.equal(
            pruneRequest(data.messages, data.transcript, config(), false).changes.length,
            0,
            name,
        )
    }
})

test("V2 file protection rejects mixed paths and unverified tool schemas", () => {
    const cfg = config()
    cfg.protectedFilePatterns = ["/secret/**"]
    for (const name of ["read_many", "read"]) {
        const data = fixture({
            name,
            input: { path: "/public/readme.txt", paths: ["/secret/credentials.txt"] },
        })
        assert.equal(pruneRequest(data.messages, data.transcript, cfg, false).changes.length, 0)
    }
    const safe = fixture({ input: { path: "/public/readme.txt", limit: 10 } })
    assert.equal(pruneRequest(safe.messages, safe.transcript, cfg, false).changes.length, 1)
})

test("V2 never guesses mismatched, duplicate, missing or reordered identities", () => {
    for (const change of [
        (data: ReturnType<typeof fixture>) => {
            data.messages[0]!.id = "msg_unknown"
        },
        (data: ReturnType<typeof fixture>) => {
            data.messages[1]!.content[0]!.id = "call_unknown"
        },
        (data: ReturnType<typeof fixture>) => {
            data.messages[0]!.content[0]!.name = "other"
        },
        (data: ReturnType<typeof fixture>) => {
            data.messages.push(structuredClone(data.messages[1]!))
        },
        (data: ReturnType<typeof fixture>) => {
            data.messages.push(structuredClone(data.messages[0]!))
        },
        (data: ReturnType<typeof fixture>) => {
            data.transcript.push(structuredClone(data.transcript[0]!))
        },
        (data: ReturnType<typeof fixture>) => {
            data.messages.reverse()
        },
        (data: ReturnType<typeof fixture>) => {
            data.messages = [...data.messages.slice(2), ...data.messages.slice(0, 2)]
        },
        (data: ReturnType<typeof fixture>) => {
            data.messages[0]!.content[0]!.input = { other: "earlier plugin edit" }
        },
        (data: ReturnType<typeof fixture>) => {
            data.messages[1]!.content[0]!.result!.value = "earlier plugin result edit"
        },
    ]) {
        const data = fixture()
        change(data)
        const before = structuredClone(data.messages)
        assert.equal(
            pruneRequest(data.messages, data.transcript, config(), false).changes.length,
            0,
        )
        assert.deepEqual(data.messages, before)
    }
})

test("V2 treats JSON null as distinct from an omitted parameter", () => {
    const data = fixture()
    data.messages[0]!.content[0]!.input = { filePath: "/src/file.ts", scope: null }
    const message = data.transcript[0]!
    if (
        message.type === "assistant" &&
        message.content[0]?.type === "tool" &&
        message.content[0].state.status !== "streaming"
    ) {
        message.content[0].state.input = { filePath: "/src/file.ts", scope: null }
    }
    assert.equal(pruneRequest(data.messages, data.transcript, config(), false).changes.length, 0)
})

test("V2 leaves opaque checkpoint, media and provider-executed content intact", () => {
    for (const field of ["native", "providerMetadata"]) {
        const data = fixture()
        Object.assign(data.messages[0]!, { [field]: { test: "opaque" } })
        assert.equal(
            pruneRequest(data.messages, data.transcript, config(), false).changes.length,
            0,
        )
    }
    const checkpoint = fixture()
    checkpoint.messages.push({ role: "assistant", content: [{ type: "compaction" } as never] })
    assert.equal(
        pruneRequest(checkpoint.messages, checkpoint.transcript, config(), false).changes.length,
        0,
    )
    const hosted = fixture()
    Object.assign(hosted.messages[0]!.content[0]!, { providerExecuted: true })
    assert.equal(
        pruneRequest(hosted.messages, hosted.transcript, config(), false).changes.length,
        0,
    )
    const media = fixture()
    const assistant = media.transcript[0]!
    if (
        assistant.type === "assistant" &&
        assistant.content[0]?.type === "tool" &&
        assistant.content[0].state.status === "completed"
    ) {
        assistant.content[0].state.content.push({
            type: "file",
            uri: "file:///image.png",
            mime: "image/png",
        })
    }
    assert.equal(pruneRequest(media.messages, media.transcript, config(), false).changes.length, 0)
})

test("V2 does not resurrect pre-compaction candidates and preserves signed reasoning", () => {
    const data = fixture()
    data.transcript.splice(1, 0, { id: "msg_checkpoint", type: "compaction" } as SessionMessageInfo)
    assert.equal(pruneRequest(data.messages, data.transcript, config(), false).changes.length, 0)
    const signed = fixture()
    const reasoning = {
        type: "reasoning",
        text: "thought",
        encrypted: "opaque",
        providerMetadata: { signature: "sig" },
    }
    signed.messages[0]!.content.unshift(reasoning as never)
    const result = pruneRequest(signed.messages, signed.transcript, config(), false)
    assert.strictEqual(
        (result.messages[0] as (typeof signed.messages)[number]).content[0],
        reasoning,
    )
})
