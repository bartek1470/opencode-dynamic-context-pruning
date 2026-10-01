import type { PluginConfig } from "../lib/config"
import type { SessionMessageInfo } from "@opencode/client"
import type {
    ContextRequest,
    Notice,
    Report,
    ServerContext,
    StoredState,
} from "../lib/v2/contracts"

export function config(): PluginConfig {
    // No global/project config is read or created by these fixtures.
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        pruneNotification: "off" as const,
        pruneNotificationType: "chat" as const,
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [] as string[],
        compress: {
            mode: "range" as const,
            permission: "allow" as "allow" | "ask" | "deny",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 100000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft" as const,
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] as string[] },
            purgeErrors: { enabled: true, turns: 1, protectedTools: [] as string[] },
        },
    } satisfies PluginConfig
}

export function fixture(
    options: { error?: boolean; name?: string; input?: Record<string, unknown> } = {},
) {
    const name = options.name ?? "read"
    const input = options.input ?? { filePath: "/src/file.ts" }
    const text = "Obsolete detailed tool output containing documentation and explanations. ".repeat(
        60,
    )
    const error = { type: "tool.error", message: "failed" }
    const transcript: SessionMessageInfo[] = [1, 2].map((number) => ({
        id: `msg_${number}`,
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: number },
        content: [
            {
                type: "tool",
                id: `call_${number}`,
                name,
                time: { created: number, completed: number },
                state:
                    options.error && number === 1
                        ? { status: "error", input, error, content: [] }
                        : { status: "completed", input, content: [{ type: "text", text }] },
            },
        ],
    })) as SessionMessageInfo[]
    const messages = [1, 2].flatMap((number) => [
        {
            id: `msg_${number}`,
            role: "assistant",
            content: [{ type: "tool-call", id: `call_${number}`, name, input }],
        },
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: `call_${number}`,
                    name,
                    result:
                        options.error && number === 1
                            ? { type: "error", value: { error, content: [] } }
                            : { type: "text", value: text },
                },
            ],
        },
    ])
    return { transcript, messages, text }
}

export function fakeHost() {
    const data = fixture()
    const storage = new Map<string, StoredState>()
    const notices: Notice[] = []
    const commands: {
        name: string
        execute(input: {
            sessionID: string
            prompt: { text: string }
            delivery: "steer" | "queue"
        }): Promise<void>
    }[] = []
    let hook: ((event: ContextRequest) => Promise<void>) | undefined
    let handlers:
        | { status(input: unknown): Promise<Report>; command(input: unknown): Promise<Report> }
        | undefined
    let disposed = 0
    let failWrite = false
    let child = false
    let directory = "/project"
    const context = {
        location: { directory: "/project", project: { id: "project" } },
        session: {
            async get({ sessionID }: { sessionID: string }) {
                return {
                    id: sessionID,
                    projectID: "project",
                    location: { directory },
                    parentID: child ? "ses_parent" : undefined,
                }
            },
            async context() {
                return data.transcript
            },
            async hook(_name: "context", callback: (event: ContextRequest) => Promise<void>) {
                hook = callback
                return {
                    async dispose() {
                        disposed++
                    },
                }
            },
        },
        storage: {
            async get(key: string) {
                return structuredClone(storage.get(key))
            },
            async set(key: string, value: StoredState) {
                if (failWrite) throw new Error("write failed")
                storage.set(key, structuredClone(value))
            },
            async remove(key: string) {
                storage.delete(key)
            },
        },
        command: {
            async transform(
                callback: (editor: { add(command: (typeof commands)[number]): void }) => void,
            ) {
                callback({
                    add: (command) => {
                        commands.push(command)
                    },
                })
                return {
                    async dispose() {
                        disposed++
                    },
                }
            },
        },
        rpc: {
            async register(_definition: unknown, input: NonNullable<typeof handlers>) {
                handlers = input
                return {
                    async dispose() {
                        disposed++
                    },
                    events: {
                        async emit(_name: "notify", notice: Notice) {
                            notices.push(notice)
                        },
                    },
                }
            },
        },
    } as unknown as ServerContext
    return {
        context,
        data,
        storage,
        notices,
        commands,
        get disposed() {
            return disposed
        },
        get rpc() {
            if (!handlers) throw new Error("RPC not registered")
            return handlers
        },
        async request(sessionID = "ses_test") {
            const event: ContextRequest = {
                sessionID,
                agent: "build",
                messages: structuredClone(data.messages),
            }
            await hook?.(event)
            return event
        },
        failWrite() {
            failWrite = true
        },
        child() {
            child = true
        },
        move() {
            directory = "/elsewhere"
        },
    }
}
