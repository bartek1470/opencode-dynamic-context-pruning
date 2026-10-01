const sessionInput = {
    type: "object",
    properties: { sessionID: { type: "string", minLength: 1 } },
    required: ["sessionID"],
    additionalProperties: false,
} as const

const reportOutput = {
    type: "object",
    properties: {
        host: { const: "v2" },
        sessionID: { type: "string" },
        enabled: { type: "boolean" },
        commandsEnabled: { type: "boolean" },
        manualMode: { type: "boolean" },
        compression: { const: "unavailable" },
        reason: { type: "string" },
        totalPruned: { type: "integer", minimum: 0 },
        estimatedTokensSaved: { type: "integer", minimum: 0 },
        message: { type: "string" },
        warnings: { type: "array", items: { type: "string" }, maxItems: 20 },
    },
    required: [
        "host",
        "sessionID",
        "enabled",
        "commandsEnabled",
        "manualMode",
        "compression",
        "reason",
        "totalPruned",
        "estimatedTokensSaved",
        "message",
        "warnings",
    ],
    additionalProperties: false,
} as const

// Plain portable JSON Schema definitions are accepted by both V2 RPC hosts.
// Keeping this module SDK-free also makes it safe to publish as ./rpc.
export const DcpRpc = {
    id: "opencode-dcp",
    methods: {
        status: { input: sessionInput, output: reportOutput },
        command: {
            input: {
                ...sessionInput,
                properties: {
                    ...sessionInput.properties,
                    arguments: { type: "string", maxLength: 4096 },
                },
                required: ["sessionID", "arguments"],
            },
            output: reportOutput,
        },
    },
    events: {
        notify: {
            schema: {
                type: "object",
                properties: {
                    sessionID: { type: "string" },
                    title: { type: "string" },
                    message: { type: "string" },
                    variant: { enum: ["info", "warning", "error", "success"] },
                },
                required: ["sessionID", "title", "message", "variant"],
                additionalProperties: false,
            },
        },
    },
} as const
