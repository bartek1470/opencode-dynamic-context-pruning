// Preserve the V1 deduplication signature (including null/undefined top-level
// normalization) while sharing it with the independently mapped V2 adapter.
export function createToolSignature(tool: string, parameters?: unknown): string {
    if (!parameters) return tool
    if (typeof parameters !== "object" || Array.isArray(parameters)) {
        return `${tool}::${JSON.stringify(sortObjectKeys(parameters))}`
    }
    const normalized = Object.fromEntries(
        Object.entries(parameters).filter(([, value]) => value !== undefined && value !== null),
    )
    return `${tool}::${JSON.stringify(sortObjectKeys(normalized))}`
}

function sortObjectKeys(value: unknown): unknown {
    if (typeof value !== "object" || value === null) return value
    if (Array.isArray(value)) return value.map(sortObjectKeys)
    return Object.fromEntries(
        Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, entry]) => [key, sortObjectKeys(entry)]),
    )
}

/** V2 JSON inputs: null is a meaningful value, not an omitted parameter. */
export function createJsonToolSignature(tool: string, input: unknown): string {
    return `${tool}::${JSON.stringify(sortObjectKeys(input))}`
}
