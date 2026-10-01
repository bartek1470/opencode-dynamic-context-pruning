import type { Plugin } from "@opencode/plugin"
import type { Plugin as TuiPlugin } from "@opencode/plugin/tui"
import type { ServerContext, CliContext } from "../../lib/v2/contracts"

// Compile-time checks against the pinned published SDK: structural ports must
// accept real host contexts, not just the simplified test doubles.
type Accepts<Port, Host extends Port> = Host
export type CheckedServerContext = Accepts<ServerContext, Plugin.Context>
export type CheckedCliContext = Accepts<CliContext, TuiPlugin.Context>
