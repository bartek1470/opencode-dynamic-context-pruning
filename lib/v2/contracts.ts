import type { SessionApi, SessionMessageInfo } from "@opencode/client"
import type { DcpRpc } from "./rpc"

// Deliberately narrow structural host ports. No runtime SDK imports, renderer
// imports, or private OpenCode services cross the dual-host facade.
export interface Registration {
    dispose(): Promise<void>
}

export interface Location {
    directory: string
    workspaceID?: string
}

export interface ContextRequest {
    readonly sessionID: string
    readonly agent: string
    messages: unknown[]
}

export type Notice = {
    sessionID: string
    title: string
    message: string
    variant: "info" | "warning" | "error" | "success"
}

export interface RpcRegistration extends Registration {
    events: { emit(name: "notify", data: Notice): Promise<void> }
}

export interface CommandInvocation {
    sessionID: string
    prompt: { text: string }
    delivery: "steer" | "queue"
}

export interface ServerContext {
    readonly location: Location & { project: { id: string } }
    readonly session: Pick<SessionApi, "get" | "context"> & {
        hook(
            name: "context",
            callback: (event: ContextRequest) => Promise<void>,
        ): Promise<Registration>
    }
    readonly command: {
        transform(
            callback: (editor: {
                add(command: {
                    name: string
                    description: string
                    execute(input: CommandInvocation): Promise<void>
                }): void
            }) => void,
        ): Promise<Registration>
    }
    readonly storage: {
        get(key: string): Promise<unknown>
        set(key: string, value: StoredState): Promise<void>
        remove(key: string): Promise<void>
    }
    readonly rpc: {
        register(
            definition: typeof DcpRpc,
            handlers: {
                status(input: unknown): Promise<Report>
                command(input: unknown): Promise<Report>
            },
        ): Promise<RpcRegistration>
    }
}

export type StoredState = {
    version: 1
    manualMode: boolean
    totalPruned: number
    estimatedTokensSaved: number
    seen: string[]
    lastReport: string
}

export interface Report {
    host: "v2"
    sessionID: string
    enabled: boolean
    commandsEnabled: boolean
    manualMode: boolean
    compression: "unavailable"
    reason: string
    totalPruned: number
    estimatedTokensSaved: number
    message: string
    warnings: string[]
}

export interface RpcClient {
    status(input: { sessionID: string }, options?: { location: Location }): Promise<unknown>
    command(
        input: { sessionID: string; arguments: string },
        options?: { location: Location },
    ): Promise<unknown>
    events: {
        on(
            name: "notify",
            callback: (event: { location: Location; data: unknown }) => void,
        ): () => void
    }
}

export interface CliContext {
    readonly location?: Location
    readonly data: { location: { default(): Location } }
    readonly client: { rpc(definition: typeof DcpRpc): RpcClient }
    readonly ui: {
        router: { current(): { type: string; sessionID?: string } }
        toast: {
            show(input: { title?: string; message: string; variant?: Notice["variant"] }): void
        }
        dialog: { alert(input: { title: string; message: string }): Promise<void> }
        slot(input: { append: "app"; render(): null }): () => void
    }
    readonly keymap: {
        layer(
            callback: () => {
                mode: "global"
                commands: {
                    id: string
                    title: string
                    palette: true
                    slash: { name: string; arguments: true }
                    run(input?: string): Promise<void>
                }[]
            },
        ): void
    }
}

export type Transcript = readonly SessionMessageInfo[]

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
