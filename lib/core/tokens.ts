import * as tokenizer from "@anthropic-ai/tokenizer"

const count =
    tokenizer.countTokens ??
    (tokenizer as unknown as { default?: typeof tokenizer }).default?.countTokens

/** Estimate only: providers account for cached input and framing differently. */
export function countTokens(text: string): number {
    if (!text) return 0
    try {
        if (count) return count(text)
    } catch {}
    return Math.round(text.length / 4)
}
