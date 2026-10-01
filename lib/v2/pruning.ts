import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { PluginConfig } from "../config"
import { createJsonToolSignature } from "../core/tool-signature"
import { countTokens } from "../core/tokens"
import {
    getFilePathsFromParameters,
    isFilePathProtected,
    isToolNameProtected,
} from "../protected-patterns"
import { isRecord, type Transcript } from "./contracts"

export const REMOVED_OUTPUT =
    "[Output removed to save context - information superseded or no longer needed]"
export const REMOVED_INPUT = "[input removed due to failed tool call]"

interface PartRef {
    message: number
    part: number
    value: Record<string, unknown>
}

interface Candidate {
    key: string
    name: string
    input: Record<string, unknown>
    turn: number
    status: "completed" | "error"
    call: PartRef
    result: PartRef
    text?: string
}

export interface PruneResult {
    messages: unknown[]
    changes: { key: string; reason: "duplicate" | "error"; tokens: number }[]
    candidates: number
}

// These calls carry protected interaction/state or mixed nested-tool provenance.
// Their V2 pruning requires a dedicated adapter, not a guessed alias for V1.
const OPAQUE_TOOLS = [
    "execute",
    "compress",
    "subagent",
    "task",
    "skill",
    "question",
    "edit",
    "write",
    "patch",
    "apply_patch",
    "multiedit",
]

function opaque(value: Record<string, unknown>): boolean {
    return (
        value.native !== undefined ||
        value.providerMetadata !== undefined ||
        value.providerExecuted === true
    )
}

function collect(messages: unknown[]) {
    const calls = new Map<string, PartRef[]>()
    const results = new Map<string, PartRef[]>()
    const messageCounts = new Map<string, number>()
    for (const message of messages) {
        if (isRecord(message) && typeof message.id === "string") {
            messageCounts.set(message.id, (messageCounts.get(message.id) ?? 0) + 1)
        }
    }
    messages.forEach((message, mi) => {
        if (!isRecord(message) || !Array.isArray(message.content)) return
        message.content.forEach((part, pi) => {
            if (!isRecord(part) || typeof part.id !== "string") return
            const index =
                part.type === "tool-call"
                    ? calls
                    : part.type === "tool-result"
                      ? results
                      : undefined
            if (!index) return
            const refs = index.get(part.id) ?? []
            refs.push({ message: mi, part: pi, value: part })
            index.set(part.id, refs)
        })
    })
    return { calls, results, messageCounts }
}

function candidates(messages: unknown[], transcript: Transcript) {
    const index = collect(messages)
    const rawMessageCounts = new Map<string, number>()
    const rawToolCounts = new Map<string, number>()
    for (const message of transcript) {
        rawMessageCounts.set(message.id, (rawMessageCounts.get(message.id) ?? 0) + 1)
        if (message.type === "assistant") {
            for (const part of message.content) {
                if (part.type === "tool")
                    rawToolCounts.set(part.id, (rawToolCounts.get(part.id) ?? 0) + 1)
            }
        }
    }
    let turn = 0
    const found: Candidate[] = []
    for (const message of transcript) {
        if (message.type === "compaction") {
            // Never use pre-checkpoint candidates, including on failed/in-flight
            // compactions. Conservatively losing savings is preferable to guessing.
            found.length = 0
            turn = 0
            continue
        }
        if (message.type !== "assistant") continue
        turn++
        if (rawMessageCounts.get(message.id) !== 1 || index.messageCounts.get(message.id) !== 1)
            continue
        for (const tool of message.content) {
            if (tool.type !== "tool" || rawToolCounts.get(tool.id) !== 1) continue
            if (tool.executed || tool.providerState || tool.providerResultState) continue
            if (tool.state.status !== "completed" && tool.state.status !== "error") continue
            const calls = index.calls.get(tool.id)
            const results = index.results.get(tool.id)
            if (calls?.length !== 1 || results?.length !== 1) continue
            const call = calls[0]!
            const result = results[0]!
            const callMessage = messages[call.message]
            const resultMessage = messages[result.message]
            if (!isRecord(callMessage) || !isRecord(resultMessage)) continue
            if (
                callMessage.id !== message.id ||
                callMessage.role !== "assistant" ||
                resultMessage.role !== "tool"
            )
                continue
            if (
                result.message <= call.message ||
                opaque(callMessage) ||
                opaque(resultMessage) ||
                opaque(call.value) ||
                opaque(result.value)
            )
                continue
            if (call.value.name !== tool.name || result.value.name !== tool.name) continue
            if (call.value.namespace !== undefined || result.value.namespace !== undefined) continue
            if (
                !isRecord(call.value.input) ||
                !isDeepStrictEqual(call.value.input, tool.state.input)
            )
                continue
            if (!isRecord(result.value.result)) continue
            let text: string | undefined
            if (tool.state.status === "completed") {
                // Only plain, single-text results. Media/structured/opaque outputs
                // are preserved. Earlier plugins' edits are not overwritten.
                if (tool.state.content.length !== 1 || tool.state.content[0]?.type !== "text")
                    continue
                text = tool.state.content[0].text
                if (result.value.result.type !== "text" || result.value.result.value !== text)
                    continue
            } else {
                if (
                    result.value.result.type !== "error" ||
                    !isDeepStrictEqual(result.value.result.value, {
                        error: tool.state.error,
                        content: tool.state.content ?? [],
                    })
                )
                    continue
            }
            found.push({
                key: JSON.stringify([message.id, tool.id]),
                name: tool.name,
                input: call.value.input,
                turn,
                status: tool.state.status,
                call,
                result,
                text,
            })
        }
    }
    // An earlier plugin can move whole call/result pairs. Transcript order then
    // cannot establish request recency, even though each individual pair matches.
    for (let i = 1; i < found.length; i++) {
        const before = found[i - 1]!.call
        const after = found[i]!.call
        if (
            after.message < before.message ||
            (after.message === before.message && after.part <= before.part)
        ) {
            return { found: [], turn }
        }
    }
    return { found, turn }
}

function protectedTool(candidate: Candidate, config: PluginConfig, patterns: string[]) {
    if (isToolNameProtected(candidate.name, [...OPAQUE_TOOLS, ...patterns])) return true
    const paths = getFilePathsFromParameters(candidate.name, candidate.input)
    for (const key of ["path", "file_path"]) {
        if (typeof candidate.input[key] === "string") paths.push(candidate.input[key])
    }
    // A familiar field name does not prove a custom tool touches only that file.
    // The inspected V2 read adapter has exactly path/offset/limit. Other schemas
    // need their own complete path extractor before pruning with file protection.
    if (
        config.protectedFilePatterns.length &&
        (candidate.name !== "read" ||
            typeof candidate.input.path !== "string" ||
            Object.keys(candidate.input).some(
                (key) => !["path", "offset", "limit"].includes(key),
            ) ||
            ["offset", "limit"].some(
                (key) =>
                    candidate.input[key] !== undefined && typeof candidate.input[key] !== "number",
            ))
    )
        return true
    return isFilePathProtected(paths, config.protectedFilePatterns)
}

/** Pure, conservative write-back. Never removes messages, calls, results or IDs. */
export function pruneRequest(
    messages: unknown[],
    transcript: Transcript,
    config: PluginConfig,
    manualMode: boolean,
): PruneResult {
    const output: PruneResult = { messages, changes: [], candidates: 0 }
    if (!config.enabled || (manualMode && !config.manualMode.automaticStrategies)) return output
    // Native checkpoints and provider replay state require protocol-specific
    // handling. Preserve the entire request rather than invalidate a checkpoint.
    if (
        messages.some(
            (m) =>
                isRecord(m) &&
                (opaque(m) ||
                    (Array.isArray(m.content) &&
                        m.content.some((p) => isRecord(p) && p.type === "compaction"))),
        )
    )
        return output
    const { found, turn } = candidates(messages, transcript)
    output.candidates = found.length
    const replacements = new Map<PartRef, Record<string, unknown>>()
    const replace = (
        candidate: Candidate,
        ref: PartRef,
        value: Record<string, unknown>,
        reason: "duplicate" | "error",
    ) => {
        const before = JSON.stringify(ref.value)
        const after = JSON.stringify(value)
        const tokens = countTokens(before) - countTokens(after)
        if (tokens <= 0) return
        replacements.set(ref, value)
        output.changes.push({
            key: createHash("sha256")
                .update(candidate.key)
                .update(reason)
                .update(before)
                .digest("hex"),
            reason,
            tokens,
        })
    }
    const oldEnough = (item: Candidate) =>
        !config.turnProtection.enabled ||
        turn - item.turn >= Math.max(1, config.turnProtection.turns)
    if (config.strategies.deduplication.enabled) {
        const latest = new Set<string>()
        for (const item of [...found].reverse()) {
            if (
                item.status !== "completed" ||
                protectedTool(item, config, config.strategies.deduplication.protectedTools)
            )
                continue
            const signature = createJsonToolSignature(item.name, item.input)
            if (latest.has(signature) && oldEnough(item)) {
                replace(
                    item,
                    item.result,
                    { ...item.result.value, result: { type: "text", value: REMOVED_OUTPUT } },
                    "duplicate",
                )
            }
            latest.add(signature)
        }
    }
    if (config.strategies.purgeErrors.enabled) {
        for (const item of found) {
            if (
                item.status !== "error" ||
                !oldEnough(item) ||
                turn - item.turn < Math.max(1, config.strategies.purgeErrors.turns)
            )
                continue
            if (protectedTool(item, config, config.strategies.purgeErrors.protectedTools)) continue
            const input = Object.fromEntries(
                Object.entries(item.input).map(([key, value]) => [
                    key,
                    typeof value === "string" ? REMOVED_INPUT : value,
                ]),
            )
            replace(item, item.call, { ...item.call.value, input }, "error")
        }
    }
    if (!replacements.size) return output
    const edits = new Map<number, Map<number, Record<string, unknown>>>()
    for (const [ref, value] of replacements) {
        const parts = edits.get(ref.message) ?? new Map()
        parts.set(ref.part, value)
        edits.set(ref.message, parts)
    }
    output.messages = messages.map((message, i) => {
        const parts = edits.get(i)
        if (!parts || !isRecord(message) || !Array.isArray(message.content)) return message
        return { ...message, content: message.content.map((part, j) => parts.get(j) ?? part) }
    })
    return output
}
