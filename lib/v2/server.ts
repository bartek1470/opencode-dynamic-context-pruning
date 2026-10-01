import { getConfig, type PluginConfig } from "../config"
import { Logger } from "../logger"
import { DcpRpc } from "./rpc"
import { pruneRequest } from "./pruning"
import {
    isRecord,
    type Notice,
    type Report,
    type RpcRegistration,
    type ServerContext,
    type StoredState,
} from "./contracts"

export const COMPRESSION_UNAVAILABLE =
    "Compression is unavailable on this V2 adapter: no supported blocking host-authorization path has been verified. DCP does not treat ask or unknown policy as allow. Automatic strategies and inspection remain independent."
const HELP =
    "DCP V2 (restricted): /dcp status | help | context | stats | manual [on|off]. Range/message compression, sweep, decompress and recompress are unavailable; they never bypass permission checks. Notifications are UI-only. See docs/compatibility.md."
const MAX_SEEN = 2048

export function storageKey(ctx: ServerContext, sessionID: string): string {
    return `v2/state/1/${encodeURIComponent(ctx.location.project.id)}/${encodeURIComponent(ctx.location.workspaceID ?? "")}/${encodeURIComponent(ctx.location.directory)}/${encodeURIComponent(sessionID)}`
}

export function decodeState(value: unknown, manualMode: boolean): StoredState {
    if (value === undefined)
        return {
            version: 1,
            manualMode,
            totalPruned: 0,
            estimatedTokensSaved: 0,
            seen: [],
            lastReport: "No pruning recorded yet.",
        }
    if (
        !isRecord(value) ||
        value.version !== 1 ||
        typeof value.manualMode !== "boolean" ||
        typeof value.totalPruned !== "number" ||
        !Number.isSafeInteger(value.totalPruned) ||
        value.totalPruned < 0 ||
        typeof value.estimatedTokensSaved !== "number" ||
        !Number.isSafeInteger(value.estimatedTokensSaved) ||
        value.estimatedTokensSaved < 0 ||
        typeof value.lastReport !== "string" ||
        value.lastReport.length > 8192 ||
        !Array.isArray(value.seen) ||
        value.seen.length > MAX_SEEN ||
        !value.seen.every((key) => typeof key === "string" && /^[a-f0-9]{64}$/.test(key))
    ) {
        throw new Error(
            "DCP V2 state is invalid or uses an unsupported schema; leaving context unchanged.",
        )
    }
    return {
        version: 1,
        manualMode: value.manualMode,
        totalPruned: value.totalPruned,
        estimatedTokensSaved: value.estimatedTokensSaved,
        seen: [...value.seen],
        lastReport: value.lastReport,
    }
}

/** Serializes state writes without keeping a permanent map of session objects. */
export function createSerialQueue() {
    const pending = new Map<string, Promise<unknown>>()
    const enqueue = <T>(key: string, run: () => Promise<T>): Promise<T> => {
        const result = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(run)
        pending.set(key, result)
        void result
            .finally(() => {
                if (pending.get(key) === result) pending.delete(key)
            })
            .catch(() => {})
        return result
    }
    return Object.assign(enqueue, {
        async drain() {
            while (pending.size) await Promise.allSettled([...pending.values()])
        },
    })
}

function parseInput(input: unknown): { sessionID: string; arguments?: string } {
    if (
        !isRecord(input) ||
        typeof input.sessionID !== "string" ||
        !/^ses_[a-zA-Z0-9_-]+$/.test(input.sessionID)
    ) {
        throw new Error("DCP requires a valid sessionID.")
    }
    if (
        input.arguments !== undefined &&
        (typeof input.arguments !== "string" || input.arguments.length > 4096)
    ) {
        throw new Error("DCP command arguments must be a string of at most 4096 characters.")
    }
    return { sessionID: input.sessionID, arguments: input.arguments as string | undefined }
}

export async function setup(ctx: ServerContext, override?: PluginConfig) {
    const warnings: string[] = []
    const warn = (title: string, message: string) => {
        const text = `${title}: ${message}`.slice(0, 2048)
        if (!warnings.includes(text)) warnings.push(text)
        if (warnings.length > 20) warnings.shift()
    }
    const config =
        override ?? getConfig({ directory: ctx.location.directory, createDefault: false, warn })
    const logger = new Logger(config.debug)
    const serial = createSerialQueue()
    let stopped = false
    let rpc: RpcRegistration | undefined
    const registrations: { dispose(): Promise<void> }[] = []

    const checkSession = async (sessionID: string) => {
        if (stopped) throw new Error("DCP has been unloaded.")
        const session = await ctx.session.get({ sessionID })
        // Released clients expose directory-only locations, while hosts may add
        // workspace identity. Check the runtime value without assuming it exists.
        const location: unknown = session.location
        const workspaceID = isRecord(location) ? location.workspaceID : undefined
        if (
            session.location.directory !== ctx.location.directory ||
            workspaceID !== ctx.location.workspaceID ||
            session.projectID !== ctx.location.project.id
        ) {
            throw new Error("DCP session belongs to a different location.")
        }
        return session
    }
    const readState = async (sessionID: string) =>
        decodeState(await ctx.storage.get(storageKey(ctx, sessionID)), config.manualMode.enabled)
    const report = (sessionID: string, state: StoredState, message = state.lastReport): Report => ({
        host: "v2",
        sessionID,
        enabled: config.enabled,
        commandsEnabled: config.commands.enabled,
        manualMode: state.manualMode,
        compression: "unavailable",
        reason: COMPRESSION_UNAVAILABLE,
        totalPruned: state.totalPruned,
        estimatedTokensSaved: state.estimatedTokensSaved,
        message,
        warnings: [...warnings],
    })
    const notify = async (notice: Notice) => {
        if (stopped) return
        try {
            await rpc?.events.emit("notify", notice)
        } catch {
            logger.warn("DCP UI notification unavailable; inspect /dcp status")
        }
    }
    const status = async (input: unknown) => {
        const { sessionID } = parseInput(input)
        return serial(sessionID, async () => {
            await checkSession(sessionID)
            return report(sessionID, await readState(sessionID))
        })
    }
    const command = async (input: unknown) => {
        const { sessionID, arguments: args = "" } = parseInput(input)
        return serial(sessionID, async () => {
            const session = await checkSession(sessionID)
            const state = await readState(sessionID)
            if (!config.enabled || !config.commands.enabled)
                return report(sessionID, state, "DCP commands are disabled by configuration.")
            const [name = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean)
            let message: string
            let changed = false
            switch (name.toLowerCase()) {
                case "manual": {
                    if (
                        rest.length > 1 ||
                        (rest[0] !== undefined && rest[0] !== "on" && rest[0] !== "off")
                    ) {
                        message = "Usage: /dcp manual [on|off]"
                        break
                    }
                    if (session.parentID && !config.experimental.allowSubAgents) {
                        message = "DCP is disabled for child sessions by allowSubAgents:false."
                        break
                    }
                    state.manualMode =
                        rest[0] === "on" ? true : rest[0] === "off" ? false : !state.manualMode
                    changed = true
                    message = `Manual mode ${state.manualMode ? "on" : "off"}. Automatic strategies ${state.manualMode && !config.manualMode.automaticStrategies ? "paused" : "enabled according to configuration"}. Compression remains unavailable.`
                    break
                }
                case "context": {
                    const messages = await ctx.session.context({ sessionID })
                    message = `Current durable context: ${messages.length} records (${messages.filter((m) => m.type === "user").length} user, ${messages.filter((m) => m.type === "assistant").length} assistant). This is not a full-history read or an exact model token count.`
                    break
                }
                case "stats":
                    message = `Recorded pruning edits: ${state.totalPruned}; estimated tokens saved: ${state.estimatedTokensSaved}. Estimates are not provider billing; duplicate accounting is bounded to the most recent ${MAX_SEEN} edits.`
                    break
                case "compress":
                case "recompress":
                case "decompress":
                case "sweep":
                    message = `${name} is unavailable in the restricted V2 adapter. ${COMPRESSION_UNAVAILABLE}`
                    break
                case "help":
                    message = HELP
                    break
                case "status":
                    message = `${state.lastReport}\n${HELP}`
                    break
                default:
                    message = `Unknown DCP command: ${name}. ${HELP}`
            }
            if (changed) {
                await checkSession(sessionID)
                if (stopped) throw new Error("DCP has been unloaded.")
                state.lastReport = message
                await ctx.storage.set(storageKey(ctx, sessionID), state)
            }
            return report(sessionID, state, message)
        })
    }

    const cleanup = async () => {
        stopped = true
        // A write already handed to the host cannot be canceled. Finish it before
        // returning from unload so a replacement instance cannot lose its state.
        await serial.drain()
        await Promise.allSettled(registrations.map((registration) => registration.dispose()))
    }
    try {
        rpc = await ctx.rpc.register(DcpRpc, { status, command })
        registrations.push(rpc)
        if (config.enabled) {
            registrations.push(
                await ctx.session.hook("context", async (event) => {
                    await serial(event.sessionID, async () => {
                        if (stopped) return
                        try {
                            const session = await checkSession(event.sessionID)
                            if (session.parentID && !config.experimental.allowSubAgents) return
                            const state = await readState(event.sessionID)
                            const transcript = await ctx.session.context({
                                sessionID: event.sessionID,
                            })
                            const result = pruneRequest(
                                event.messages,
                                transcript,
                                config,
                                state.manualMode,
                            )
                            if (!result.changes.length) return
                            const seen = new Set(state.seen)
                            const added = result.changes.filter((change) => !seen.has(change.key))
                            for (const change of added) seen.add(change.key)
                            state.seen = [...seen].slice(-MAX_SEEN)
                            state.totalPruned += added.length
                            state.estimatedTokensSaved += added.reduce(
                                (sum, change) => sum + change.tokens,
                                0,
                            )
                            const tokens = result.changes.reduce(
                                (sum, change) => sum + change.tokens,
                                0,
                            )
                            state.lastReport = `Pruned ${result.changes.length} mapped tool parts in the latest request (approximately ${tokens} tokens). Original history was not changed.`
                            await checkSession(event.sessionID)
                            if (stopped) return
                            // Persist first: a storage failure leaves the outgoing request intact.
                            await ctx.storage.set(storageKey(ctx, event.sessionID), state)
                            if (stopped) return
                            event.messages = result.messages
                            if (added.length && config.pruneNotification !== "off") {
                                await notify({
                                    sessionID: event.sessionID,
                                    title: "DCP",
                                    variant: "info",
                                    message:
                                        config.pruneNotification === "minimal"
                                            ? `DCP: ${result.changes.length} tool parts pruned.`
                                            : state.lastReport,
                                })
                            }
                        } catch (error) {
                            warn(
                                "DCP context unchanged",
                                error instanceof Error ? error.message : "Host operation failed",
                            )
                            logger.warn("DCP context pass-through; see status warnings")
                        }
                    })
                }),
            )
            if (config.commands.enabled)
                registrations.push(
                    await ctx.command.transform((editor) => {
                        for (const name of ["dcp", "dcp-compress"])
                            editor.add({
                                name,
                                description:
                                    name === "dcp"
                                        ? "DCP status, context, stats and manual mode (V2 restricted)"
                                        : "Explain V2 compression availability",
                                async execute(input) {
                                    const response = await command({
                                        sessionID: input.sessionID,
                                        arguments:
                                            name === "dcp-compress"
                                                ? "compress"
                                                : input.prompt.text,
                                    })
                                    // Inspection never admits a prompt, drops attachments into a new
                                    // prompt, wakes the model, or manufactures a permission request.
                                    await notify({
                                        sessionID: input.sessionID,
                                        title: "DCP",
                                        message: response.message,
                                        variant: "info",
                                    })
                                    logger.info(response.message)
                                },
                            })
                    }),
                )
        }
        logger.info("DCP V2 initialized in restricted mode", { compression: "unavailable" })
        return cleanup
    } catch (error) {
        await cleanup()
        throw error
    }
}
