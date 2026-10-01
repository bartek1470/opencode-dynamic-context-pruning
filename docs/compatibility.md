# DCP behavior and OpenCode compatibility

This package has separate V1 and V2 server/UI adapters. **V2 support is restricted,
not feature parity with V1.** Missing host capabilities never imply permission to
run compression without approval.

## Versions and verification

- **V1 target: OpenCode 1.18.29 or newer.** Earlier hosts that require a function
  export are outside the compatibility contract. The default export now contains
  `server` (V1) and `setup` (V2), loaded independently.
- The V2 adapter's structural contracts are typechecked against the published
  `@opencode/plugin` / `@opencode/client` **2.0.19** API. This identifies the API
  baseline, not an assertion that every newer host is compatible.
- Server builds and local fake-host regression tests cover both adapters. The V1
  test suite is retained. Live V1/V2 host loading, terminal rendering, remote
  connections and the oldest host version have **not** been verified in this
  migration. Version checking was intentionally skipped at the user's request.
- `./tui` is source TSX with lazy host-specific callbacks. **Bun/OpenTUI source
  loading is the UI target; Node-only precompiled TUI loading is not supported.**
  The V2 UI uses host-owned alerts/toasts rather than importing V1's renderer.
  Actual host loading must still verify source transformation and lazy imports.

Do not interpret successful package installation, typechecking or server
registration as proof of full host/terminal compatibility.

## Behavior matrix

| Capability                          | V1 adapter                                   | V2 adapter                                                                                                                                      |
| ----------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic deduplication             | Existing strategies retained                 | Older, safely mapped plain-text direct-tool results replaced; latest result retained                                                            |
| Error purging                       | Existing old-input purging retained          | Eligible old string inputs replaced; original error result retained                                                                             |
| Compression (range/message)         | Existing model-supplied summary tool         | **Unavailable**, regardless of DCP `allow`/`ask`/`deny` setting                                                                                 |
| Manual compression trigger          | Existing `/dcp compress` and `/dcp-compress` | Explains unavailable capability; no trigger or model prompt admitted                                                                            |
| Sweep, decompression, recompression | Existing handlers                            | **Unavailable**; commands report the limitation without mutating state                                                                          |
| Manual mode                         | Existing session setting/trigger behavior    | `/dcp manual [on\|off]` controls whether automatic strategies run according to `manualMode.automaticStrategies`; it does not enable compression |
| Context report                      | Existing detailed report                     | Counts current durable context records; not complete history or exact provider token usage                                                      |
| Statistics                          | Existing compression/pruning report          | Pruning edits and estimated savings; not provider billing or compression statistics                                                             |
| UI                                  | Existing DCP panel/dialogs                   | Host-owned status/help alerts with RPC commands and toasts; no compression-management panel                                                     |
| Notifications configured as `chat`  | Ignored/no-reply transcript notices          | **UI-only fallback**: toast plus stored latest report; nothing inserted into model context                                                      |
| Notifications configured as `toast` | Existing transport                           | Session/location-scoped RPC toasts; status retains latest report                                                                                |
| Auxiliary model calls               | Existing internal-agent behavior             | No DCP transform on title, compaction or transient generate requests                                                                            |
| Completion artifact cleanup         | Existing `experimental.text.complete` hook   | Not implemented; no equivalent public hook verified, no new compression artifacts injected                                                      |
| Config/custom prompts               | Existing DCP files and prompt overrides      | DCP config layers retained; compression-specific settings/custom prompts accepted but inactive                                                  |
| Auth                                | Existing secure-client interceptor           | Uses supplied host context/client; no private V1 interceptor                                                                                    |
| Plugin updating                     | Existing V1 self-updater                     | `autoUpdate` accepted but has no effect; use OpenCode's plugin-update command                                                                   |
| Persistence                         | Existing JSON files retained                 | Host-provided plugin storage, versioned/project/location/session keys; UI accesses server state through RPC                                     |

### Permission limitation

The inspected V2 custom-tool runtime uses `options.permission` for visibility;
this does **not** automatically request and await approval for custom execution.
The adapter has no verified public blocking authorization path. Consequently it:

- Does not register `compress`, advertise compression instructions or inject
  compression nudges.
- Does not execute compression even when `compress.permission` is `allow`.
  A plugin default alone cannot establish effective host authorization.
- Returns an unavailable-capability explanation from compression-related commands
  and RPC. There is no tool/command/RPC bypass and no artificial approval prompt.
- Leaves automatic strategies and inspection independent of compression
  authorization. These follow strategy, manual-mode, protection and ancestry
  configuration, just as automatic pruning is separate from the V1 tool gate.

There is no permission-disabling workaround. An upgrade alone does not enable
compression until this adapter implements and tests the relevant public API.
Reduced support is intentional; full permission/compression parity is future work.

## Safe pruning and its limits

V2 request messages and durable history are not interchangeable arrays. The
adapter maps unique assistant message IDs and call/result IDs, checks tool names,
input equality, result equality, ordering and durable provenance, then replaces
only eligible payloads in the outgoing request. **No positional fallback** is used.
The original history, protocol IDs, call/result pairing and unrelated parts stay
intact. A storage/read/mapping failure leaves the request unchanged.

Conservative exclusions can reduce savings compared with V1:

- Code Mode `execute` output, nested calls, provider-executed calls, opaque/native
  provider state, media/structured results and ambiguous/missing identities are
  not pruned. A native checkpoint or message-level provider replay state makes the
  whole request pass through unchanged.
- Interaction and mutation tools (`question`, `edit`, `write`, `patch`), skills,
  subagents and compression results are protected by the V2 adapter.
- Configured protected-tool globs, protected-file patterns and turn protection
  still apply. With file protection configured, only the inspected single-path
  `read(path, offset?, limit?)` shape has a verified extractor. Other tools or
  extra/nested parameters are conservatively protected, even if one familiar
  path field looks unprotected.
- Error purging preserves the error and non-string inputs. Replacements are made
  only when the token estimate is smaller than the original representation.
- Child sessions are skipped unless `experimental.allowSubAgents` is enabled.
  Session ancestry, not agent mode alone, determines the default exclusion.
- Compaction records clear pre-boundary candidates; missing pre-compaction
  history is never reconstructed or restored by guessed offsets.
- Already transformed results from earlier plugins are not overwritten.

Turn age in V2 counts assistant steps in the currently available durable context,
not synthetic user-role messages. Statistics deduplicate the most recent 2,048
edit fingerprints; very old replayed edits can be counted again after eviction.
Savings are tokenizer estimates of payload differences, not provider accounting.

## Commands and UI

V2 supports `/dcp status`, `help`, `context`, `stats`, and `manual [on|off]`.
The CLI palette/bare `/dcp` opens a status alert; arguments route to server RPC.
`/dcp-compress`, `compress`, `sweep`, `decompress`, and `recompress` report that
their capability is unavailable. Inspection never admits a prompt or triggers a
model call. Files/mentions attached to an inspection command are not forwarded
into a new model request.

`commands.enabled:false` disables registered server commands and RPC mutations;
read-only status remains accessible. `enabled:false` also disables the pruning
hook. The generic CLI status entry can still report that DCP is disabled.

The CLI only shows notification events for the current location and active
session. With no session it asks you to open one; with a missing/disconnected
server plugin it reports the connection failure. RPC notifications are live-only:
missed toasts are not replayed. Opening status retrieves the retained report and
warnings; there is no automatic toast replay on reconnect.

`pruneNotification:off` suppresses prune toasts; `minimal`/`detailed` control their
content. The latest status report remains readable. Notifications never create
synthetic/user input, wake model execution or add conversation turns.

## State and rollback

V1 keeps its original state files and config keys. V2 state uses a separate `v2`
schema namespace in server-owned plugin storage. Each state update is serialized
per session within an adapter instance. Remote UI reads/toggles that state through
RPC instead of creating a local shadow file. Multiple adapter instances writing
the same key concurrently have not been integration-tested.

Invalid/unknown V2 state schemas are rejected, not silently reset. V2 stores
bounded edit fingerprints and the latest report, not a second copy of the full
transcript. No V1 prune map, compressed block, or message identity is automatically
imported into V2. Cross-host history/state migration is outside this release.

To roll back, pin a known-good V1 package version. Its existing state files have
not been converted or overwritten by the V2 adapter. The V1 self-updater should
not be enabled when intentionally keeping a pinned legacy version.

## Verification and remaining work

- `npm test`: retained V1 regressions plus conservative V2 pruning, RPC/server
  state, CLI routing and cleanup tests in `tests/v2-*.test.ts`.
- `npm run typecheck`: normal package declarations.
- `npm ci --prefix tests/v2-contracts --omit=optional` then
  `npm run typecheck:v2`: isolated published V2 SDK contract checks. The separate
  install avoids resolving V2 renderer peers against V1's OpenTUI 0.4.x graph.
- `npm run check:package`: build, manifest/tarball inventory and lazy entrypoint
  artifact validation.

Still unverified: exact V1 1.18.29 loading, live terminal/renderer behavior on both
hosts, remote service routing, provider-wire behavior and real host reloads.
Future capabilities must update this document, runtime status and regression
tests together. Do not promote an unavailable or unverified feature to supported
based solely on an SDK version bump.
