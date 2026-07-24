# Codex in Binned

This case study is a Binned-native port of OpenAI Codex. The behavior reference
is the official Codex repository at commit
`56395bddaf26eb2829387ca6a417bf9128e5b239`.

The current vertical slice runs a Responses API turn, handles any number of
function calls, requests approval, returns function-call outputs, strips
citations from assistant text, extracts streamed plan-mode output, normalizes
conversation history, rolls back user turns, compacts history within an
approximate token budget, merges official configuration layers, renders model
context, and selects durable rollout records. It also registers model-visible
and deferred tools, validates dispatch payloads, selects sandbox approval
requirements, preserves denied-read policy, and assesses apply-patch targets. It
compiles through the latest local gpufuck backend. Model, tool, and approval
operations are resumable suspending effects: Duck retains the continuation and
agent loop while the host completes external I/O. Managed-network requests use
source-owned per-environment caches, attribution, pending-request deduplication,
deferred denial outcomes, decider-only approval contexts, exact policy-denial
messages, and typed execpolicy amendments. Terminal begin, output-delta,
interaction, and end records are also selected in source, including UTF-8-safe
payload bounds and exactly-once lifecycle guards. MCP visibility, connector
allowlists, deferred exposure, and annotation-driven approval policy are
source-defined as well. Skill frontmatter and optional `agents/openai.yaml`
policy are parsed in Duck from immutable snapshots. Duck also owns product
gating, hidden-path and traversal limits, explicit `$name` selection, scope
ordering, context budgets, description truncation, omission reports, and the
model-visible skill catalog. Injected user-context classification and
hook-prompt recovery are source-defined too, so runtime context stays hidden
while hook prompts remain visible as typed items.

The wire protocol is source-defined. `duck:prelude/json` provides the recursive
JSON parser, Unicode escape handling, and encoder, while the focused
`duck:prelude/json/values` module provides construction and object queries to
larger gpufuck programs without linking the parser. The focused
`duck:prelude/json/string` module escapes JSON strings without linking recursive
JSON values. `duck:prelude/numeric/parse` similarly keeps named decimal parse
results out of scalar-only numeric programs while remaining compatible with the
gpufuck host interface. `duck:prelude/base64` validates canonical standard
Base64, reports exact failure evidence, and computes decoded length without
allocating decoded bytes. The text prelude's curried `append_text` keeps
host-returned text composable without constructing an anonymous product at the
effect boundary. `protocol.duck` maps Responses API JSON to typed `ModelEvent`
values and serializes user messages and function-call outputs. `app_server.duck`
owns JSONL message envelopes, initialization gating, client capabilities, exact
notification opt-outs, and the initialize response. Initialized requests become
typed route plans before `app_server_routes.duck` performs known-method
decoding; this keeps the recursive wire codec and the complete method surface
independently compilable through gpufuck. `app_server_methods.duck` decodes
`thread/list`, `thread/read`, `thread/start`, `thread/resume`, `thread/fork`,
`thread/archive`, `thread/unarchive`, `thread/delete`, `thread/unsubscribe`,
`thread/compact/start`, `thread/metadata/update`, `thread/settings/update`,
`thread/turns/list`, `thread/items/list`, `thread/name/set`,
`thread/increment_elicitation`, `thread/decrement_elicitation`,
`thread/goal/set`, `thread/goal/get`, `thread/goal/clear`, `turn/start`,
`turn/steer`, and `turn/interrupt` into typed source values and rejects
malformed known-method parameters with the protocol's invalid-params error. List
limits parse across the complete U32 range and clamp to 1–100 with the official
defaults and sort directions. Goal budgets parse across the complete I64 range.
`app_server_threads.duck` materializes stored rollout summaries into the exact
V2 `Thread`, `ThreadListResponse`, and `ThreadReadResponse` JSON shapes,
including RFC3339 timestamps, session-source and Git metadata, cursors, and
experimental-field gating. Separate list and read fixtures keep those complete
response paths within gpufuck's per-program device bounds. Thread start, resume,
and fork use typed source plans for history mode, loaded-thread rejoin, path
consistency, fork boundaries, turn hydration, and goal-continuation constraints.
Duck also materializes their common V2 response fields, experimental pagination
fields, archive/unarchive and compact responses, unsubscribe statuses, and
thread lifecycle notification bodies. Git metadata updates use the prelude's
three-state `FieldPatch` category to preserve omitted fields, clear explicit
nulls, trim replacements, reject empty values, and materialize the updated
thread. `app_server_turn_lifecycle.duck` tracks submitted, active, interrupted,
completed, and failed turns, including startup interrupts and exact active-turn
validation. `app_server_turns.duck` materializes the V2 Turn response and
notification shape with item views, errors, and timing metadata. Turn input
covers text, remote and local image/audio, skills, and mentions. Optional turn
policy overrides remain preserved in the source JSON value while their owning
configuration domains are ported. Thread settings updates preserve those policy
values, distinguish an omitted service tier from an explicit clear, reject
permissions/sandbox-policy conflicts, classify no-op updates, retarget and
deduplicate default workspace roots after cwd changes, and queue typed
overrides. Permission-profile loading remains a narrow configuration boundary;
Duck rejects missing, unexpected, or disallowed resolutions and applies explicit
request policy over profile defaults. Duck also materializes the response and
updated settings notification. Thread names use the prelude's Unicode whitespace
normalization and reject empty normalized names. Out-of-band elicitation
counters pause timeout accounting above zero, reject underflow and overflow, and
materialize their response and name-update notification bodies in Duck. Thread
goals preserve the official six-state lifecycle, reject ephemeral threads and
disabled goal support, normalize Unicode whitespace, enforce the 4,000-character
objective and positive-budget bounds, and distinguish create, partial update,
missing-goal, and clear plans. Goal responses and updated or cleared
notification bodies are materialized in Duck. No JSON parsing, event-tag
dispatch, tool-output serialization, app-server handshake policy, or
known-method parameter decoding lives in TypeScript.

Thread deletion accepts a non-empty source subtree, rejects live ephemeral
roots, tolerates a missing root only when persisted descendants remain, and
plans storage removal plus notifications from leaves back to the root. This
keeps descendant ordering out of the storage host boundary.

Global prompt history uses the official append-only JSONL shape. Duck encodes
entries, applies disabled-persistence policy, trims over-limit files toward the
80% soft cap while retaining the newest row, parses identity-validated offsets,
and returns bounded newest-first batches with malformed rows preserved. The host
owns file identity checks, advisory locking, owner-only permissions, and the
single append or rewrite syscall.

Responses stream retry policy is source-defined. Duck selects bounded retries,
honors server-requested delays, computes typed exponential backoff from
host-supplied jitter, suppresses the first release-mode websocket notice, and
chooses HTTPS fallback before terminal failure. Sleeping, notification delivery,
randomness, and switching the live transport remain host mechanics.

Responses request metadata is source-defined as a typed snapshot. Duck owns
turn, prewarm, compaction, memory, and legacy-template identity rules; filters
all core-reserved client keys; orders extra metadata, workspaces, and remote
URLs canonically; derives subagent headers and metadata kinds; and materializes
the ASCII-only JSON payload plus client-metadata and compatibility-header
projections. Workspace discovery and Git enrichment remain host mechanics.

Shared rollout-budget accounting is source-defined. Duck applies independent
sampling and non-cached-prefill weights, keeps one budget across a root thread
and its subagents, makes exhaustion sticky, and tracks threshold reminders per
thread and context-window ID. Compaction and rollback rearm delivery without
refunding usage; history insertion and token-usage collection remain boundary
operations.

Auto-compaction window state is source-defined as well. Duck owns window ID
lineage, pending-window request consumption, exactly-once reminder and fallback
delivery, and server-observed input-token precedence over estimates. UUID
generation remains a host mechanic; the next ID is supplied to the source
transition.

Context-window token status is source-defined from session usage and configured
limits. Duck handles total versus body-after-prefix accounting, minimum
auto-compact/full-window remaining tokens, fallback-buffer saturation, and hard
limit detection. When token-budget support is enabled, Duck exposes the
direct-model-only `new_context` tool and direct `get_context_remaining` tool,
owns their exact schemas and text/code-mode outputs, and records one consumable
new-window request in the existing window state.

Interactive user input is source-defined from tool registration through response
serialization. Duck owns the experimental gate, direct-model-only exposure, Plan
and optional Default mode availability, root-thread precedence, JSON argument
decoding, required non-empty options, `isOther` normalization, 60,000–240,000 ms
auto-resolution bounds, cancellation text, and the exact answer JSON shape. The
host receives only a typed normalized prompt tagged with its call and turn IDs,
waits for the user, and returns a typed answer or cancellation.

Additional permission requests are source-defined from feature and environment
gating through grant application. Duck selects the primary or named environment
before full argument decoding, resolves relative paths against its native cwd,
normalizes and deduplicates filesystem entries, rejects empty requests, and
intersects every response with the requested profile. It also owns approval
policy, turn-versus-session scope, strict-auto-review constraints, exact
response JSON, and cancellation text. Native-path conversion, physical symlink
canonicalization, prompting, and storage of the resulting typed grant action are
host mechanics.

Deferred environment waiting is source-defined. Duck owns feature-gated tool
registration, exact environment ID decoding, ready-before-starting precedence,
unknown-environment rejection, startup-failure guidance, and the ready JSON
result. The host only suspends on a source-selected starting environment and
reports whether startup completed.

Plan updates are source-defined from unconditional direct registration through
typed event publication. Duck owns the exact schema and description, payload and
Plan-mode rejection precedence, strict unknown and duplicate field checks,
status decoding, item ordering, and text/code-mode completion. Like upstream,
the one-in-progress rule is descriptive rather than runtime-enforced. The host
only publishes the typed plan event.

Plugin-install candidate listing is source-defined. Duck owns feature,
candidate, and presentation gating; exact registration metadata; deterministic
name-then-ID ordering; Unicode-safe 240-character description truncation; and
the complete plugin/connector metadata response. The follow-up installation
request remains a separate suspending capability so listing never requires a
host round trip. Its direct registration, both list-tool and recommended-plugin
argument schemas, strict decoding, action and TUI policy, candidate selection,
elicitation metadata, completion verification, persistent-disable intent,
connector selection, telemetry facts, and exact output are source-defined.

The experimental integration-test synchronization tool is source-defined as
well. Duck owns model-support gating, exact parallel-call metadata, nullable
timing and barrier decoding, full U64 bounds, the default 1000 ms timeout,
positive barrier validation, operation ordering, short-circuiting, and exact
errors and output. Sleep timers and the shared barrier registry remain host
mechanics. Canonical U64 decimal parsing is reusable through the numeric prelude
because runtime `U64` is currently a packed storage type rather than an
arithmetic scalar.

Local image viewing is source-defined from conditional tool registration through
typed output. Duck owns exact schemas, image-modality rejection precedence,
nullable argument decoding, primary and named environment selection, relative
path resolution, detail validation, original-resolution capability downgrade,
error shaping, and successful lifecycle ordering. The host performs sandboxed
metadata and file reads, converts bytes to the upstream-compatible data URL, and
records the source-selected view lifecycle event.

MCP resource access is source-defined for resource listing, template listing,
and reads. Duck owns argument decoding, cursor policy, orchestrator-server
visibility, deterministic all-server ordering, server attribution, response JSON
shaping, output bounds, and lifecycle events. The host only invokes the selected
typed MCP operation and returns raw resource or result JSON.

Runtime tool-source planning is source-defined from one typed turn snapshot and
the already-resolved contributed runtimes. Duck owns guardian-reviewer
isolation, environment and shell selection, the hidden legacy shell fallback,
MCP-resource gating, core utility order, plugin presentation, V1 and V2
collaboration exposure, agent-job gating, and the final configured-runtime,
extension-runtime, and dynamic-runtime order. This is the upstream
`add_tool_sources` stage. Its finalizer then applies configured
direct-model-only namespace overrides and appends `tool_search` only when an
eligible searchable runtime remains deferred. Hosted web-search planning is
source-defined as the following bounded stage: Responses Lite suppresses hosted
tools, an available standalone `web.run` suppresses the hosted equivalent,
provider capability and a non-disabled mode are required, and Cached, Indexed,
and Live preserve their exact external/indexed access flags. Duck also preserves
configured domain filters, approximate user location, context size, and the
text-versus-text-and-image tool type. The following code-mode metadata stage is
source-defined too: Duck filters hidden, direct-model-only, and configured
excluded namespaces; preserves every remaining nested runtime; separates direct
and deferred prompt definitions; records direct namespace descriptions; applies
the exact namespace-aware order; and plans the leading `exec` and `wait`
executors. Duck also parses raw `exec` input, including the optional indented
first-line pragma, exact supported-field policy, nullable limits, JavaScript
safe-integer bounds, and unchanged subsequent source text. The following wait
stage owns the exact model-visible spec, full U64 argument decoding, defaults,
wait-versus-terminate routing, and live-cell closure policy. Unknown argument
fields remain compatible with upstream's non-strict schema while duplicate known
fields fail before host dispatch. The following bounded Duck stages parse
code-mode schemas, render their exact TypeScript types, classify ordinary and
MCP output types, and materialize the final `exec tool declaration`
descriptions. Only the V8-backed executor remains capability-backed. The
model-visible spec stage is source-defined as well: the first runtime for a tool
name wins before exposure filtering, CodeModeOnly hides nested direct tools
while preserving direct-model-only and `exec`/`wait` specs, code-mode
description-augmentation selection skips excluded namespaces and
direct-model-only specs, and hosted specs retain their following position. Duck
merges repeated namespace specs at their first position, upgrades blank
descriptions, supplies the upstream default description, stably sorts local
functions, and removes namespace specs when the provider lacks namespace-tool
support.

Agent-job tool exposure is source-defined, including the SpawnCsv feature gate,
collaboration availability, and worker-only result reporter. Duck owns the exact
tool schemas, spawn argument decoding, local-environment and path policy,
concurrency and runtime bounds, CSV parsing, stable item IDs, worker prompts,
scheduler transitions, report validation, stop-on-accepted policy, and result
JSON. State storage, agent processes, and cancellation remain typed host
capabilities.

V2 collaboration tools are source-defined from registration through typed host
requests and client output. Duck owns feature and direct-model-only gating,
optional namespaces, the six-tool order and schemas, strict argument decoding,
canonical task paths, spawn depth and capacity, `fork_turns` normalization,
metadata-sensitive spawn output schemas, wait bounds, agent-status JSON, and the
distinction between queued messages and turn-triggering follow-up tasks. Spawn
model selection consumes a host-supplied catalog and applies requested values,
configured defaults, or parent inheritance in that order. Duck filters the
catalog to visible V2 models, bounds unknown-model alternatives to five,
validates reasoning effort against the effective model, and emits the upstream
default-role/V2 telemetry facts only after a successful spawn. The source
planner also rejects root follow-up tasks and root or self interruption before
host I/O. The host only supplies model facts and performs spawn, message
delivery, interruption, mailbox waiting, agent-tree listing, telemetry, and
delivery of source-ordered lifecycle facts selected by those plans.

Turn profiling is a pure source state machine over typed monotonic timestamps.
It separates pre-sampling time, sampling, between-request overhead, blocking
tool work, and post-sampling time; counts requests and retries; rejects
overlapping phases; and freezes one idempotent completed profile. Reading the
monotonic clock and delivering telemetry remain host mechanics.

Turn milestone timing uses the same typed clock values. Duck decides which
response signals establish time-to-first-token, records first-token and
first-agent-message durations once per turn, resets both milestones on restart,
and derives terminal duration. The event adapter supplies typed signals instead
of embedding event-name policy in the host.

Current-time reminders are source-defined over host-supplied Unix seconds. Duck
selects system or external providers, consumes user/tool boundaries, enforces
the configured interval and delivery mode, refreshes on context-window changes,
and renders the exact UTC developer message. The same source policy exposes
`clock.curr_time` whenever reminders are enabled and conditionally exposes
`clock.sleep`, validates its 1–43,200,000 ms duration, and renders exact elapsed
and interruption output. The current-time tool also projects the official
`{"current_time":"… UTC"}` code-mode result. Clock reads, elapsed measurement,
input cancellation, and suspension remain host capabilities.

Permission-profile telemetry is source-defined. Duck decides when managed file
system or network policy requires a platform sandbox and derives the official
`none`, `external`, `windows_elevated`, `danger-full-access`, `read-only`, and
`workspace-write` tags. Platform sandbox discovery is supplied as a host fact.

Top-level CLI routing is source-defined for the interactive default and the
official command surface, including `e`, `a`, and `cloud-tasks` aliases. Each
recognized command retains its remaining argv for its owning option parser;
unrecognized positional input remains an interactive prompt. Completion shell
selection, the default Bash shell, feature list/enable/disable commands, and the
argument-free update command are parsed into typed source plans. Login planning
preserves the official status, browser, device-code, API-key stdin, access-token
stdin, conflicting-credential, and deprecated direct-key behavior; logout
accepts no command arguments. Credential reads, browser/device authorization,
storage, and revocation remain host boundaries.

Non-interactive planning covers fresh exec sessions, session resume, and code
review through both `exec review` and the top-level `review` command. Duck owns
shared model, image, sandbox, workspace, output, persistence, configuration
isolation, color, and JSON options; resume positional interpretation; review
target exclusivity; and commit-title requirements. The removed `--full-auto`
compatibility trap is intentionally not retained. Stdin prompt composition,
schema and output-file reads or writes, repository inspection, and agent
execution remain host boundaries.

CLI execution is staged to respect gpufuck's per-program device bound.
`cli_head.duck` classifies the command and preserves its remaining argv; the
host selects the corresponding source planner, such as `plan_exec_command` or
`plan_review_command`, without interpreting any option. The selected Duck
planner produces the final typed plan. This keeps routing policy and argument
semantics in source while avoiding one monolithic compiler program.

MCP command planning covers list/get JSON output, stdio additions with parsed
`KEY=VALUE` environments, streamable-HTTP additions with bearer-token and OAuth
metadata, removal, comma-delimited login scopes, and logout. Configuration-file
mutation, server discovery, OAuth transport, and credential deletion remain host
boundaries.

Plugin command planning resolves stable `plugin@marketplace` selectors, checks
explicit marketplace conflicts, and covers add, list, available-list, and remove
operations. Marketplace planning covers source registration with refs and
ordered sparse paths, listing, targeted or complete upgrades, and removal.
Marketplace fetches, cache mutation, and plugin installation remain host
boundaries.

Cloud-task command planning covers interactive browsing, task submission with
required environments and bounded best-of-N attempts, status lookup, paginated
listing, and attempt-specific diff or apply operations. Query input, remote task
transport, rendering, and local patch application remain host boundaries.

Server command planning covers strict MCP-server startup, local or remotely
registered exec-server startup, and the internal stdio-to-Unix-socket relay.
Duck enforces listen/remote conflicts and remote registration requirements;
socket resolution, transport startup, registration, and byte relay remain host
boundaries.

App-server CLI planning covers stdio, Unix-socket, websocket, and disabled
transports; capability-token and signed-bearer websocket authentication; daemon
lifecycle and remote-control bootstrap; socket proxying; and TypeScript plus
public/internal JSON Schema generation. Duck owns option compatibility, token
source exclusivity, digest shape, auth defaults, normalized claims, clock-skew
bounds, and generation requirements. Address and path resolution, secret-file
reads, cryptographic verification, daemon operations, relay I/O, and artifact
writes remain host boundaries.

Desktop-app planning selects the workspace and optional installer override,
while remote-control planning distinguishes foreground, daemon start/stop, and
pairing operations with machine-readable output. Workspace canonicalization, app
installation, daemon lifecycle, and pairing I/O remain host boundaries.

Utility planning covers doctor report modes, legacy task apply with ordered raw
configuration overrides, and responses-proxy startup with official defaults and
validated TCP port bounds. Diagnostic collection and rendering, TOML override
interpretation, task retrieval and patch application, listener startup,
credential reads, forwarding, and exchange dumps remain host boundaries.

Debug planning covers bundled/live model catalog selection, app-server V2 test
messages, optional prompt input with ordered image expansion, trace reduction,
and memory reset. Model loading, app-server process execution, context
materialization, trace filesystem access, and memory deletion remain host
boundaries.

Execpolicy CLI planning preserves repeatable rule-file order, compact or pretty
JSON selection, host-executable resolution, and every trailing command token,
including hyphen-prefixed arguments. Rule-file reads, policy parsing,
host-executable discovery, matching, and JSON rendering remain capability and
execpolicy-engine boundaries.

Approval-cache command canonicalization is source-defined. Duck unwraps one
statically literal Bash, Zsh, or POSIX shell command, preserves complex scripts
behind stable shell-mode keys, normalizes PowerShell wrappers behind an exact
script key, and leaves unrecognized argv unchanged. The parser deliberately
falls back for substitutions, redirections, command sequences, assignments, and
malformed quoting instead of broadening an approval.

Original image-detail policy is source-defined. Duck preserves `auto`, `low`,
and `high`, permits `original` only for models advertising support, omits an
unsupported request detail, and downgrades unsupported output images to `high`
without changing text, audio, encrypted content, or item ordering.

Audio preparation is source-defined as bounded stages. Duck parses data URLs,
requires a case-insensitive `base64` parameter, accepts the official wav, mp3,
m4a, webm, and ogg MIME aliases, canonicalizes their media types, rejects
noncanonical Base64 and inputs over the 50 MiB decoded limit, and rewrites audio
in message, function-output, and custom-output content. Rejected inputs use the
official processing, unsupported-format, and size placeholders while preserving
all non-audio content and response order.

Image preparation is source-defined around a narrow decoding boundary. Duck
preserves non-data local URLs, rejects remote HTTP URLs and unsupported `low`
detail without host work, and emits only processable data URLs with the official
high/auto 2,048-dimension and 2,500-patch limits or original-detail 6,000 and
10,000 limits. It applies host processing outcomes to message, function-output,
and custom-output content with the four official placeholders while retaining
detail, metadata, unrelated content, and response order. The host owns image
decoding, resizing, and data-URL encoding.

Sandbox CLI planning preserves permission and configuration profiles, explicit
sandbox-state JSON, readable roots, network disablement, managed configuration,
macOS Unix-socket and denial-log options, and the exact trailing command. Duck
owns option aliases, ordering, and compatibility requirements. Profile and path
resolution, sandbox-state decoding, platform availability, and sandboxed process
execution remain host boundaries.

Legacy `thread/turns/list` pagination is source-defined as explicit stages:
`app_server_thread_turn_cursor.duck` owns the JSON cursor codec,
`app_server_thread_item_views.duck` owns `notLoaded`, first-user/final-agent
summary, and full projections, `app_server_thread_turn_pagination.duck` owns
ascending/descending anchor paging, and `app_server_thread_turn_pages.duck`
composes them. It emits official next and backwards cursors and rejects missing
anchors deterministically. Paginated-history routing rejects `itemsView: full`
with the official instruction to use `thread/items/list`; stored item paging
remains a thread-store boundary.

Apply-patch handling is source-defined from the freeform tool registration
through patch parsing and mutation planning. Duck owns the grammar contract,
optional environment selection, add/delete/update decoding, move targets,
writable-root safety projection, line matching, and immutable file updates. The
host only snapshots requested files and applies Duck-selected writes or deletes;
filesystem I/O does not participate in patch interpretation.

Turn diff accumulation is source-defined over the exact committed delta from
that boundary. Duck retains the first observed content, current content,
revision identity, move ancestry, invalidation state, and environment-qualified
paths without rereading the workspace. It projects deterministic added, deleted,
updated, and moved changes, including add/delete cycles, overwritten
destinations, pure renames, and multiple environments. Git blob hashing,
display-root rendering, unified-diff generation, caching, and timeout fallback
remain host concerns.

App-server account requests use an explicit staged decoder. The root source
router identifies the `account/*` subsystem, Duck classifies all five login
modes, and focused source stages decode API-key, ChatGPT, device-code, external
token, and Amazon Bedrock payloads without exceeding gpufuck's per-program
bound. Cancel, logout, account read, rate-limit read and reset, token usage,
workspace messages, and add-credit nudges are also typed in Duck. Credential
storage, OAuth/device authorization, refreshes, and backend account calls remain
host capabilities.

The host boundary is intentionally narrow:

- `Input.prompt` supplies the initial prompt.
- `Model.start`, `Model.next`, and `Model.submit` transport raw Responses JSON.
- `Tool.run` executes a source-selected tool.
- `Approval.request` asks about a consequential call.
- `Events` presents typed lifecycle events.
- `RolloutStore.snapshot_length` and `RolloutStore.snapshot_file` enumerate
  typed rollout files without serializing file bodies into another JSON layer.
- `RolloutStore.append` and `RolloutStore.flush` perform durable writes selected
  by source policy.
- `MessageHistoryStore` exposes an opaque file identity and snapshot, then
  performs source-planned append or rewrite operations under the host lock.
- `ProcessHost.start`, `ProcessHost.write`, and `ProcessHost.terminate` perform
  process mechanics from source-built launch records and return typed snapshots.
- `CodeModeSession.execute`, `wait`, and `terminate` perform V8 cell mechanics
  from source-parsed JavaScript and typed cell-control actions. Duck retains
  argument defaults, output limits, and terminal lifecycle policy.
- `NetworkApprovalHost.request` presents a source-built network prompt and
  returns only the user's decision; Duck retains the active-call and cache
  state.
- `ExecEvents` receives typed lifecycle records after Duck decides whether each
  begin, delta, interaction, or end event should be emitted.
- `HookCommandHost.run` executes a source-normalized command with exact JSON
  stdin, cwd, and timeout, and returns only its process result.
- `AgentHost.spawn`, `send`, `interrupt`, `wait`, and `close` perform agent
  registry mechanics after Duck validates paths, inputs, depth, capacity,
  timeout, wait failure, and residency policy.
- `CurrentTimeHost.current_time` reads Unix seconds and `CurrentTimeHost.sleep`
  performs a cancellable suspension after Duck validates its duration. The host
  returns only interruption and elapsed-time facts.
- `RequestUserInputHost.request` presents a source-decoded and normalized prompt
  with its call and turn IDs, then returns only a typed answer or cancellation.
- `RequestPermissionsHost.request` presents a normalized permission profile with
  its call, turn, environment, cwd, reason, and start time, then returns only a
  typed subset grant or cancellation.
- `WaitForEnvironmentHost.wait` suspends for one source-selected starting
  environment and returns only ready or failed-to-start status.
- `UpdatePlanHost.publish` receives one source-decoded typed plan and publishes
  the corresponding event.
- `RequestPluginInstallHost.request` presents one source-selected candidate and
  reason, then returns only elicitation and post-install verification facts.
- `TestSyncHost.sleep` and `TestSyncHost.barrier` perform timer and shared
  rendezvous mechanics from source-validated U64 decimal durations.

`codex.ts` adapts those capabilities to gpufuck's typed Wasm host values. Text
generation, slicing, append, comparison, UTF-8 conversion, and JSON processing
stay in Wasm; only explicit external capabilities cross the host boundary.

## Source modules

- `codex.duck` owns the turn state machine and policy.
- `cli_types.duck`, `cli_head.duck`, `cli_options.duck`, `cli_auth.duck`,
  `cli_mcp.duck`, `cli_plugin.duck`, `cli_cloud.duck`, `cli_server.duck`,
  `cli_app.duck`, `cli_app_server_runtime.duck`, `cli_app_server_tools.duck`,
  `cli_app_server.duck`, `cli_utility.duck`, `cli_debug.duck`,
  `cli_execpolicy.duck`, `cli_exec.duck`, `cli_sandbox.duck`,
  `cli_sessions.duck`, and `cli.duck` own top-level command and alias routing
  plus typed completion, feature-management, authentication, MCP,
  plugin/marketplace, cloud-task, server-launch, app-server,
  desktop/remote-control, doctor, task-apply, responses-proxy, exec/review,
  execpolicy, sandbox, session-management, and update plans.
- `protocol.duck` owns the Responses JSON codec.
- `app_server_types.duck`, `app_server.duck`, `app_server_routes.duck`,
  `app_server_wire_responses.duck`, `app_server_methods.duck`,
  `app_server_thread_methods.duck`, `app_server_thread_control_methods.duck`,
  `app_server_thread_controls.duck`, `app_server_thread_control_routes.duck`,
  `app_server_goal_methods.duck`, `app_server_goal_types.duck`,
  `app_server_goals.duck`, `app_server_goal_responses.duck`,
  `app_server_thread_delete_types.duck`, `app_server_thread_delete.duck`,
  `app_server_thread_delete_responses.duck`,
  `app_server_thread_lifecycle_types.duck`, `app_server_thread_lifecycle.duck`,
  `app_server_thread_response_types.duck`, `app_server_thread_responses.duck`,
  `app_server_threads.duck`, `app_server_thread_metadata.duck`,
  `app_server_thread_settings_types.duck`, `app_server_thread_settings.duck`,
  `app_server_thread_settings_responses.duck`, `app_server_turn_types.duck`,
  `app_server_thread_pages.duck`, `app_server_thread_page_responses.duck`,
  `app_server_thread_item_views.duck`, `app_server_thread_turn_cursor.duck`,
  `app_server_thread_turn_pagination.duck`, `app_server_thread_turn_pages.duck`,
  `app_server_turn_lifecycle.duck`, and `app_server_turns.duck` own request IDs,
  JSON-RPC-style envelopes, initialization state, capability validation,
  notification opt-out, response encoding, typed thread/turn method parameters,
  stored-thread response materialization, loaded-thread lifecycle transitions,
  active-turn transitions, terminal outcomes, and dispatch planning. The raw
  JSONL transport remains a host boundary.
- `app_server_account_types.duck` and `app_server_account_methods.duck` own
  staged account routing, login-kind classification, focused login payload
  decoding, and the remaining typed account request surface.
- `apply_patch_types.duck`, `apply_patch_registration.duck`,
  `apply_patch_boundary.duck`, `apply_patch_parser.duck`,
  `apply_patch_policy.duck`, `apply_patch_update.duck`, and
  `apply_patch_execution.duck` own tool exposure, environment selection, patch
  syntax, target projection, pure content updates, and mutation sequencing.
  `apply_patch_host.duck` declares only file snapshots and mutations.
- `turn_diff_types.duck`, `turn_diff.duck`, and `turn_diff_projection.duck` own
  exact-delta accumulation, content revisions, move ancestry, invalidation, and
  deterministic net-change projection. Host rendering can consume those typed
  changes without reinterpreting file history.
- `citation_parser.duck` owns incremental citation filtering.
- `proposed_plan_types.duck` and `proposed_plan.duck` own line-delimited
  `<proposed_plan>` recognition, incremental visible-text filtering, ordered
  plan segments, end-of-stream closure, one-shot stripping, and last-block
  extraction. `assistant_text_types.duck` and `assistant_text.duck` compose that
  parser after citation removal in plan mode while leaving plan markup visible
  in normal assistant text and expose the exact empty-chunk predicate.
- `history_types.duck` defines the source conversation model.
- `history.duck` owns call/output pairing, modality normalization, rollback, and
  token estimation.
- `compaction_types.duck` and `compaction_tags.duck` own the shared trigger,
  reason, implementation, phase, and canonical tag vocabulary.
- `compaction.duck` owns source-defined history selection and truncation.
- `compact_model_fallback_types.duck` and `compact_model_fallback.duck` own
  current-model retry eligibility and the exact fallback counter and warning
  projection. Telemetry delivery remains a host boundary.
- `instruction_types.duck` and `instruction_discovery.duck` own hierarchical
  project-instruction discovery, candidate precedence, byte budgets, and
  model-visible rendering over an immutable filesystem snapshot.
- `config_types.duck` and `config.duck` own recursive JSON configuration merges,
  disabled layers, project ordering, and the official layer precedence.
- `context_types.duck`, `context.duck`, and `context_fragments.duck` own the
  model-visible environment, permission, instruction, budget, and internal
  context fragments.
- `contextual_user_message_types.duck`, `contextual_user_fragment.duck`,
  `hook_prompt.duck`, and `contextual_user_message.duck` own injected-context
  recognition, hook-prompt XML recovery, and mixed-message visibility policy.
- `rollout_types.duck` and `rollout.duck` own durable-record and memory-record
  selection for legacy and paginated histories.
- `rollout_budget_types.duck` and `rollout_budget.duck` own one-shot
  configuration, weighted shared usage, sticky exhaustion, per-thread reminder
  thresholds, delivery acknowledgement, and rearming.
- `rollout_scan.duck` reconstructs the minimum model context from newest-first
  rollout records.
- `rollout_storage_types.duck` and `rollout_storage.duck` own JSONL metadata
  extraction, malformed-line tolerance, path construction, ID lookup, filters,
  search, ordering, pagination, and scan limits over raw host file snapshots.
- `rollout_storage_host.duck` declares indexed file reads plus append and flush;
  `rollout_storage_adapter_fixture.duck` streams those typed files through Duck.
- `message_history_types.duck`, `message_history_entry.duck`,
  `message_history_storage.duck`, and `message_history_batch.duck` own global
  prompt-history JSONL encoding, persistence, soft-cap trimming, lookup, and
  bounded continuation. `message_history_host.duck` owns only filesystem
  identity, locking, permissions, and writes.
- `responses_retry_types.duck` and `responses_retry.duck` own stream retry
  counts, requested-delay precedence, reconnect visibility, and HTTPS fallback.
  Typed exponential backoff is reusable through `duck:prelude/abstractions`.
- `auto_compact_window_types.duck` and `auto_compact_window.duck` own scoped
  compaction-window state, ID lineage, one-shot notifications, pending-window
  requests, and observed-versus-estimated prefill facts. The reusable `Once`
  gate and saturating I64 addition live in the prelude.
- `context_window_status_types.duck`, `context_window_status.duck`,
  `token_budget_tool_types.duck`, `token_budget_tool_registration.duck`, and
  `token_budget_tools.duck` own scoped token accounting, buffered limit
  detection, token-budget tool exposure and schemas, remaining-token output, and
  new-window request handling.
- `request_user_input_types.duck`, `request_user_input_availability.duck`,
  `request_user_input_description.duck`, `request_user_input_registration.duck`,
  `request_user_input_json.duck`, `request_user_input_policy.duck`,
  `request_user_input_call.duck`, `request_user_input_output.duck`, and
  `request_user_input_execution.duck` own the complete interactive-tool policy,
  wire decoding, normalization, response encoding, and cancellation result.
  `request_user_input_host.duck` declares the narrow suspending prompt boundary.
- `request_permissions_types.duck`, `request_permissions_registration.duck`,
  `request_permissions_environment.duck`, `request_permissions_json.duck`,
  `request_permissions_policy.duck`, `request_permissions_call.duck`,
  `request_permissions_output.duck`, and `request_permissions_execution.duck`
  own the permission tool's exposure, environment precedence, wire decoding,
  request normalization, response intersection, grant action, exact output, and
  cancellation result. `request_permissions_host.duck` declares the narrow
  suspending prompt boundary.
- `wait_for_environment_types.duck`, `wait_for_environment_registration.duck`,
  `wait_for_environment_json.duck`, `wait_for_environment_policy.duck`, and
  `wait_for_environment_call.duck` own deferred-executor exposure, argument
  decoding, environment-state precedence, exact output, and failure policy.
  `wait_for_environment_host.duck` declares the suspending startup boundary.
- `update_plan_types.duck`, `update_plan_registration.duck`,
  `update_plan_value.duck`, `update_plan_json.duck`, `update_plan_policy.duck`,
  and `update_plan_call.duck` own exact tool metadata, strict typed-value and
  document decoding, payload/mode precedence, event planning, and completion.
  `update_plan_host.duck` declares the typed event-publication boundary.
  `json_parse_stage.duck`, `update_plan_decode_stage.duck`, and
  `update_plan_stage_composition_fixture.duck` run raw parsing and typed
  decoding as independently bounded programs while the coordinator keeps result
  matching and update-plan policy in Duck.
- `plugin_install_types.duck`, `list_plugin_install_registration.duck`, and
  `list_plugin_install.duck` own discoverable plugin/connector candidate values,
  list-presentation exposure, exact metadata, sorting, truncation, and output.
  Registration definitions and specs use separate bounded gpufuck fixtures.
  `request_plugin_install_registration.duck`,
  `request_plugin_install_value.duck`, `request_plugin_install_json.duck`,
  `request_plugin_install_policy.duck`, `request_plugin_install_call.duck`, and
  `request_plugin_install_execution.duck` own exact request exposure, both
  upstream presentation schemas, strict decoding, candidate policy, typed
  elicitation planning, and completion. `request_plugin_install_host.duck`
  declares the narrow suspending capability. Definition gating, both schema
  presentations, and accepted and declined completion use separate bounded
  gpufuck fixtures.
- `test_sync_registration.duck`, `test_sync_types.duck`, `test_sync_value.duck`,
  `test_sync_json.duck`, `test_sync_policy.duck`, `test_sync_call.duck`, and
  `test_sync_execution.duck` own the internal synchronization tool's exact
  metadata, decoding, validation, ordering, and completion.
  `test_sync_host.duck` declares only timer and barrier mechanics. Registration
  definitions and specs use separate bounded gpufuck fixtures.
- `view_image_types.duck`, `view_image_registration.duck`,
  `view_image_value.duck`, `view_image_json.duck`, `view_image_policy.duck`,
  `view_image_call.duck`, `view_image_output.duck`, and
  `view_image_execution.duck` own the local image tool's exact exposure,
  schemas, decoding, environment and detail policy, errors, lifecycle order, and
  structured output. `view_image_host.duck` declares only sandboxed image
  loading and lifecycle delivery.
- `tool_search_types.duck`, `tool_search_value.duck`, `tool_search_name.duck`,
  `tool_search_sources.duck`, `tool_search_spec.duck`,
  `tool_search_registration.duck`, `tool_search_policy_types.duck`,
  `tool_search_policy.duck`, `tool_search_rank_math.duck`,
  `tool_search_rank.duck`, `tool_search_output.duck`, and
  `tool_search_call.duck` own deferred-tool normalization, source discovery
  metadata, BM25 ranking, namespace coalescing, payload policy, and the
  completed client response. Search runs entirely in Duck, uses the prelude's
  reusable ASCII word tokenizer, and keeps source, ranked-result, and output
  lists as explicit domain values at runtime.
- `mcp_resource_types.duck`, `mcp_resource_registration.duck`,
  `mcp_resource_value.duck`, `mcp_resource_json.duck`,
  `mcp_resource_policy.duck`, `mcp_resource_call.duck`,
  `mcp_resource_output.duck`, and `mcp_resource_execution.duck` own MCP resource
  exposure, decoding, access policy, ordering, attribution, output bounds, and
  lifecycle events. `mcp_resource_host.duck` declares only the typed transport.
- The focused `agent_job_*_types.duck` modules, `agent_job_registration.duck`,
  `agent_job_spawn_json.duck`, `agent_job_spawn_policy.duck`,
  `agent_job_spawn_call.duck`, `agent_job_csv.duck`, `agent_job_prepare.duck`,
  `agent_job_runner_action.duck`, `agent_job_runner_transition.duck`,
  `agent_job_spawn_execution.duck`, the `agent_job_csv_*_output.duck` stages,
  `agent_job_result.duck`, `agent_job_export_execution.duck`,
  `agent_job_report_call.duck`, and `agent_job_report_execution.duck` own
  job-tool exposure, worker gating, spawn decoding and bounds, CSV semantics,
  item preparation, saturation-aware concurrency scheduling, report validation,
  cancellation policy, augmented CSV rendering, and exact result JSON.
  `agent_job_host.duck`, `agent_job_spawn_host.duck`, and
  `agent_job_export_host.duck` declare only persistence, worker mechanics,
  cancellation, and the final file write. The required, text-option, schema, and
  numeric JSON decoders are separate gpufuck stages because linking four
  complete recursive parser specializations exceeds the backend's 65,536-node
  per-program bound; the TypeScript entry point calls those stages in order.
- `turn_profile_types.duck` and `turn_profile.duck` own phase transitions,
  monotonic duration accounting, request and retry counts, and idempotent turn
  profile completion. Typed monotonic instants and duration arithmetic are
  reusable through `duck:prelude/abstractions`.
- `turn_timing_types.duck` and `turn_timing.duck` own first-output signal
  classification, first-token and first-agent-message milestones, restart
  resets, and terminal duration calculation.
- `current_time_types.duck`, `current_time.duck`, `current_time_format.duck`,
  `current_time_tool_registration.duck`, `sleep_tool_policy.duck`, and
  `current_time_tool_output.duck` own provider selection, boundary-sensitive
  cadence, context-window refresh, clock-tool exposure, sleep validation, and
  exact UTC and elapsed-time rendering. `current_time_code_mode.duck` owns the
  structured code-mode projection. `current_time_host.duck` declares the narrow
  clock-mechanics boundary; `current_time_tools.duck` is the combined source
  facade.
- `sandbox_tags_types.duck` and `sandbox_tags.duck` own platform-sandbox
  requirement policy plus sandbox and legacy permission-profile telemetry tags.
- `tool_types.duck` defines tool names, exposure, payload, output-schema,
  runtime, approval, sandbox, and patch-safety values. Tool output schemas use
  domain constructors instead of the generic text option shared by unrelated
  approval and patch fields.
- `tool_registry.duck` owns duplicate-safe registration, model-visible and
  deferred selection, payload compatibility, dispatch planning, and runtime
  metadata. Runtime definitions remain separate from model-visible specs.
- `tool_source_types.duck` and `tool_source_plan.duck` own the typed turn facts
  and exact upstream runtime-source order. `tool_source_finalization.duck` owns
  direct-model-only namespace overrides and deferred-search executor insertion;
  its immutable searchable-name snapshot is the bounded projection of upstream
  handlers' optional search metadata. Both stages use nominal recursive runtime
  lists so gpufuck never has to transfer the generic prelude `List` shape across
  this boundary.
- `hosted_tool_types.duck` and `hosted_tool_availability.duck` own the Responses
  Lite, standalone `web.run`, namespace, provider, and disabled-mode gates for
  hosted search. `hosted_web_search_spec.duck` owns the closed mode/content-type
  plan, exact external and indexed access projections, and immutable search
  configuration. Availability and spec construction are separate Duck programs
  because gpufuck keeps imported aliases nominal and bounds each linked
  functional expression to 65,536 nodes.
- `code_mode_executor_plan.duck` owns effective-mode gating, `exec`/`wait`
  prepending metadata, hidden and direct-model-only omission, excluded-namespace
  policy, deferred-guidance selection, nested-runtime retention, namespace
  description upgrades, stable prompt ordering, and the upstream namespace to
  JavaScript-name conversion. It consumes a bounded immutable runtime-spec
  projection; schema rendering is a separate Duck stage and V8 execution remains
  outside this pure stage.
- `code_mode_exec_source.duck` owns non-empty raw-source validation and the
  optional first-line `// @exec:` directive. It preserves unannotated input and
  the exact post-pragma JavaScript, rejects unsupported fields before value
  decoding, accepts nullable limits, and enforces the `2^53 - 1` JavaScript
  safe-integer ceiling before the V8 capability receives a typed source plan.
- `code_mode_execute_types.duck`, `code_mode_execute.duck`, and
  `code_mode_execute_execution.duck` own the live `exec` handler. They require
  the plain custom `exec` payload, preserve complete enabled-tool definitions,
  start timing and tracing after source parsing, open the per-cell dispatch gate
  before awaiting output, record initial and terminal responses, close only
  terminal cells, and wait for active elicitations before returning a typed
  response boundary. `code_mode_execute_host.duck` contains only runtime, clock,
  trace, gate, and elicitation effects. Response rendering remains the following
  Duck stage so the live coordinator stays below gpufuck's per-program bound.
- `code_mode_wait_spec.duck`, `code_mode_wait_json.duck`, `code_mode_wait.duck`,
  and `code_mode_wait_lifecycle.duck` own the exact non-strict `wait`
  declaration, required cell identity, full U64 yield and output limits, the
  10,000 ms default, nullable output bounds, wait-versus-terminate routing, and
  live/missing-cell lifecycle decisions. The V8 session receives only a typed
  wait or termination action; only live terminal responses close a
  source-tracked cell.
- `code_mode_runtime_response_types.duck` and `code_mode_response_adapter.duck`
  own the typed V8 response boundary, default missing image detail to `High`,
  and replace unsupported `Original` detail with `High`.
  `code_mode_output_limit.duck` resolves the wait parser's full-range U64 limit,
  defaults it to 10,000 tokens, and saturates only values beyond Duck's I64
  arithmetic range. `code_mode_text_output_truncation.duck` preserves individual
  text items below the token budget and otherwise emits the exact warning,
  Rust-style line count, and middle-truncated combined output.
  `code_mode_mixed_output_truncation.duck` spends the text budget in order,
  preserves image and encrypted items, drops audio, and appends the omitted-text
  marker. `code_mode_output_truncation.duck` selects those policies, while
  `code_mode_runtime_response.duck` appends script errors before truncation and
  prepends the exact status and one-decimal wall-time header afterward.
- `code_mode_nested_tool_types.duck` and `code_mode_nested_tool.duck` own the
  nested V8 callback boundary. They reject `exec` self-invocation, require JSON
  objects for function tools and strings for freeform tools, preserve cell and
  runtime invocation identity, serialize function arguments, and leave UUID
  creation plus router dispatch to `code_mode_nested_tool_host.duck`.
  `code_mode_result.duck` owns the default post-dispatch projection: plain text
  bodies remain JSON strings, content arrays join nonblank text and media URLs,
  encrypted content is omitted, tool-search arrays remain arrays, and MCP
  results and explicit JSON tool outputs remain structured JSON.
- `code_mode_dispatch_types.duck` and `code_mode_dispatch.duck` own the broker
  policy between V8 cells and the ordinary tool router. They select exact
  cancellation, unavailable-channel, and stopped-dispatch errors; wait on
  per-cell readiness before routing; preserve delivered operation failures;
  close cancelled gates; suppress blank notifications; and build the exact
  `exec` notification injected into the active turn.
  `code_mode_dispatch_host.duck` leaves async queue delivery, readiness
  watching, task spawning, and turn injection at the host boundary.
- `code_mode_schema_parse.duck`, `code_mode_identifier.duck`,
  `code_mode_schema_decode.duck`, and `code_mode_schema_renderer.duck` own
  schema document parsing with evidence-bearing errors, JavaScript identifier
  normalization, the bounded recursive schema plan, and exact TypeScript
  rendering. The renderer preserves JSON Schema union and intersection order,
  sorts object properties, quotes invalid property names, emits trimmed property
  comments, and applies the upstream array and additional-property defaults.
- `code_mode_output_type.duck` recognizes the upstream MCP result shape and
  selects `CallToolResult`, its structured generic, or the ordinary rendered
  output type. `code_mode_description.duck` then materializes function and
  freeform declarations while leaving `exec` unchanged. Parsing, rendering,
  output classification, and scalar description assembly are separate programs
  so each stays below gpufuck's 65,536-expression bound.
- `model_visible_spec_plan.duck` owns first-name runtime deduplication, direct
  exposure and CodeModeOnly filtering, request-description augmentation
  selection, following hosted-spec insertion, and namespace merging, description
  finalization, local-function sorting, and provider-capability filtering. Its
  explicit description states preserve the original text until the later
  code-mode stages materialize declarations. Two focused fixtures keep runtime
  selection and namespace materialization independently observable within
  gpufuck's per-program bound. The mutable dispatch registry remains the
  separate concern of `tool_registry.duck`.
- `tool_policy.duck` owns default execution approval, escalation and denied-read
  preservation, sandbox-denial retry planning, writable-root checks, move-target
  checks, and apply-patch safety.
- `original_image_detail_types.duck` and `original_image_detail.duck` own model
  support checks, request-detail normalization, and immutable multimodal output
  sanitization.
- `audio_types.duck`, `audio_data_url.duck`, `audio_format.duck`,
  `audio_payload.duck`, `audio_preparation_types.duck`, and
  `audio_preparation.duck` own staged data-URL parsing, MIME classification,
  strict payload validation, canonical URL construction, and ordered response
  rewriting. Flat evidence structs keep managed text ownership explicit at
  backend boundaries.
- `image_preparation_types.duck`, `image_preparation_plan.duck`,
  `image_preparation_requests.duck`, and `image_preparation.duck` own image URL
  policy, detail-dependent resize budgets, ordered host requests, exact failure
  placeholders, and response rewriting. `HistoryContent` retains image detail so
  request preparation does not discard model-visible policy.
- `exec_types.duck` and `exec.duck` own shell recognition, argv derivation,
  login-shell restrictions, yield and output-token bounds, process state, and
  bounded head-tail output with omission accounting.
- `command_canonicalization.duck` owns conservative shell-wrapper recognition,
  literal command recovery, and stable approval-cache command keys.
- `exec_store.duck` owns deterministic test IDs, lookup/removal, active-session
  ordering, and the official 64-process pruning preference: protect the eight
  newest, then evict the oldest exited eligible process before a live one.
- `exec_host.duck` declares the typed process-mechanics boundary;
  `exec_adapter_fixture.duck` drives a start/poll transcript without moving
  process policy into TypeScript.
- `network_types.duck` and `network_approval.duck` own protocol-scoped host
  keys, call attribution, approval eligibility, pending prompt deduplication,
  session allow/deny caches, late blocked-request outcomes, cancellation, and
  deferred finish behavior. `network_approval_host.duck` is the narrow prompt
  boundary.
- `network_policy_types.duck`, `network_policy_context_types.duck`,
  `network_policy_context.duck`, `network_policy_message_types.duck`,
  `network_policy_message.duck`, `network_policy_amendment_types.duck`, and
  `network_policy_amendment.duck` own the shared approval-context vocabulary,
  decider-payload projection, exact blocked request explanations, protocol
  mapping, and allow/deny execpolicy amendment text. The three focused stages
  stay below gpufuck's per-program bound.
- `exec_events.duck` owns terminal lifecycle state, 8 KiB UTF-8-safe output
  chunks, the 10,000-delta bound, interaction visibility, completion status, and
  begin/end deduplication. `exec_events_host.duck` only delivers those typed
  records.
- `mcp_types.duck` and `mcp.duck` own model visibility, Codex-app connector
  filtering, direct/deferred exposure, annotation-driven approval, and prompt
  decision normalization.
- `skill_types.duck`, `skill_metadata.duck`, and `skills.duck` own the skill
  catalog model, YAML scalar frontmatter and policy parsing, bounded snapshot
  discovery, product restrictions, implicit-invocation policy, and explicit
  selection. `skill_render.duck` owns deterministic scope/name/path ordering,
  default context budgets, description bounds, omission reports, and catalog
  rendering.
- `plugin_types.duck` and `plugins.duck` own stable plugin ID validation,
  active/error filtering, prompt-safe descriptions, capability summaries,
  first-wins MCP/app projection, deduplicated skill and hook resources,
  `plugin://` mention selection, and explicit model instructions.
- `hook_types.duck`, `hooks.duck`, and `hook_policy.duck` own all eleven hook
  events, exact and regex matchers, alias-aware selection, thread/turn scope,
  stable keys, timeout normalization, trust gating, conservative permission
  folding, and sequential legacy abort policy.
- `hook_output_types.duck` and `hook_output.duck` interpret command JSON for
  pre-tool, permission-request, post-tool, session/subagent start, user-prompt,
  compact, and stop hooks. Input rewrites, context, reserved-field rejection,
  and required denial or continuation reasons stay in Duck.
- `hook_input_types.duck` and `hook_input.duck` serialize the exact command
  input records for all eleven events, including nullable transcript paths,
  optional subagent identity, tool payloads, compaction triggers, and stop-loop
  state.
- `hook_command.duck` classifies raw process completion and applies each event's
  exit-code, stdout, context, blocking, stopping, feedback, input-update, and
  permission policy. Its streaming aggregate preserves completion order while
  giving stop precedence over block and deny precedence over allow.
  `hook_host.duck`, `hook_adapter_fixture.duck`, and `hook.test.ts` keep process
  mechanics at the typed capability boundary.
- `agent_types.duck`, `agent_capacity.duck`, `agent_input_policy.duck`,
  `agent_path.duck`, `agents.duck`, `agent_wait.duck`, and
  `agent_residency.duck` own status transitions, V2 execution capacity, spawn
  depth, collaboration input validation, path resolution, bounded waits, failure
  folding, and protected LRU residency. `agent_tool_types.duck`,
  `agent_tool_registration.duck`, the focused `agent_tool_*_json.duck` decoders,
  `agent_tool_spawn_call.duck`, and `agent_tool_control_call.duck` add the six
  V2 model-visible collaboration tools, configurable namespace and
  direct-model-only exposure, typed spawn and control plans, canonical targets,
  case-insensitive trimmed fork modes, root and self target policy, and exact
  result schemas. `agent_tool_spawn_execution.duck`,
  `agent_tool_control_execution.duck`, and `agent_tool_host.duck` keep all six
  mechanics behind typed capabilities. `agent_spawn_override_types.duck`,
  `agent_spawn_override_model.duck`, `agent_spawn_override_effort.duck`, and
  `agent_spawn_override.duck` select the effective V2 model and reasoning effort
  from immutable host facts. `agent_spawn_override_stage.duck` retains that
  policy across the live host boundary. The coordinators emit call-ID-bearing
  started, interacted, interrupted, and wait lifecycle facts in source-defined
  order, plus successful-spawn telemetry. `agent_status_json.duck` and the
  focused `agent_tool_*_output.duck` modules materialize exact spawn, interrupt,
  wait, and list responses without coupling scalar control operations to the
  recursive agent-list type. They use the focused JSON-string prelude so status
  output does not pull recursive `Json` into the bounded programs. Their
  retained `agent_tool_*_output_stage.duck` programs return those responses to
  the suspending execution coordinators; successful message and follow-up calls
  return the upstream empty text. The bounded decoder, spawn, control, and
  output stages avoid linking the complete collaboration surface into one
  gpufuck program. The legacy `agent_host.duck` boundary remains exercised by
  `agent_adapter_fixture.duck` and `agent.test.ts`.
- `session_prefix.duck` owns exact subagent-notification JSON, final inter-agent
  message envelopes, bounded error payloads, and subagent context lines.
- `host.duck` declares the minimal effect interface.
- `json_fixture.duck`, `json_codec_fixture.duck`, `protocol_fixture.duck`,
  `app_server_fixture.duck`, `app_server_methods_fixture.duck`, and
  `app_server_turn_methods_fixture.duck` are gpufuck regression workloads. The
  app-server thread and turn fixtures check list/read and lifecycle response
  shapes, experimental-field behavior, start/resume/fork decode-to-plan paths,
  running-thread consistency, unsubscribe classification, active-turn
  validation, steering preconditions, startup interruption, terminal outcomes,
  and V2 Turn materialization.
- `citation_parser_stream_fixture.duck`, `proposed_plan_fixture.duck`,
  `proposed_plan_edge_fixture.duck`,
  `proposed_plan_ascii_whitespace_fixture.duck`, `assistant_text_fixture.duck`,
  `history_fixture.duck`, `compaction_fixture.duck`, `truncation_fixture.duck`,
  `instruction_discovery_fixture.duck`, `config_fixture.duck`,
  `context_fixture.duck`, `contextual_user_fragment_fixture.duck`,
  `hook_prompt_fixture.duck`, `contextual_user_message_fixture.duck`,
  `rollout_fixture.duck`, `rollout_scan_fixture.duck`,
  `rollout_storage_fixture.duck`, `rollout_storage_metadata_fixture.duck`, and
  `rollout_storage_adapter_fixture.duck` verify the larger source policies and
  live storage boundary through gpufuck. The contextual-user fixtures verify
  injected-fragment recognition, XML round trips, and mixed hook-message
  recovery. The plan-stream fixtures verify split tag prefixes, line-only
  recognition, malformed and unterminated blocks, Unicode and CRLF whitespace,
  ordered segments, last-block extraction, normal mode passthrough, and citation
  removal inside plan text. The message-history fixtures verify exact JSONL
  escaping, disabled persistence, soft-cap trimming, identity mismatch,
  malformed rows, newest-first ordering, and continuation offsets. The
  compaction-tag and model-fallback fixtures verify canonical telemetry
  vocabulary, retry eligibility, and success/failure projections.
  `tool_registry_fixture.duck`, `tool_dispatch_fixture.duck`,
  `tool_metadata_fixture.duck`, `tool_policy_fixture.duck`, and
  `tool_patch_policy_fixture.duck` verify the source-defined tool and safety
  decisions. The command-canonicalization fixtures verify literal recovery and
  conservative approval-key fallback. The original-image-detail fixtures verify
  supported and unsupported request normalization plus item-preserving output
  sanitization. The audio fixtures verify every supported MIME alias, strict
  Base64 rejection, canonical URL output, all three omission messages, message,
  function-output, custom-output, and non-audio preservation, plus missing,
  extra, and invalid preparation status failures. The image-preparation fixtures
  verify URL classification, every detail budget, host-request ordering, all
  four omission messages, metadata and non-image preservation, and missing,
  extra, invalid-status, and empty-success failures. The turn-diff fixtures
  verify accumulation, deletion, add and move overwrites, committed mutation
  order, delete/re-add cycles, chained move pairing, pure rename suppression,
  invalidation, and environment-qualified ordering. The rollout-budget fixtures
  verify weighted non-cached usage, one-shot configuration, persistent
  exhaustion, per-thread thresholds, context-window restatement, and explicit
  rearming. The context-window and token-budget-tool fixtures verify total and
  body-after-prefix accounting, full-window precedence, saturated fallback
  buffers, exact tool metadata and schemas, remaining-token output, and one-shot
  new-window requests. The request-user-input fixtures verify registration, mode
  and root-thread precedence, option validation, auto-resolution clamping, exact
  output, and cancellation. `request_user_input.test.ts` verifies the live
  normalized prompt and answer boundary through gpufuck. The request-permissions
  fixtures verify environment and registration gates, relative path resolution,
  deduplication, approval policy, subset intersection, scope constraints, exact
  output, and cancellation. `request_permissions.test.ts` verifies the live
  typed grant boundary through gpufuck. The wait-for-environment fixtures verify
  feature gating, exact metadata, ready-before-starting selection, rejection and
  startup failure text, and output JSON. `wait_for_environment.test.ts` verifies
  the live suspension boundary through gpufuck. The update-plan fixtures verify
  exact registration metadata, payload and mode precedence, strict fields,
  status and order preservation, upstream-compatible multiple-active behavior,
  and completion output. `update_plan.test.ts` verifies the live typed event
  boundary through gpufuck. The plugin-install-list fixtures verify registration
  gates, exact metadata, stable name/ID ordering, complete candidate projection,
  and description truncation. The request-plugin-install registration fixture
  verifies both model-facing presentation schemas; its value, policy, execution,
  and live adapter fixtures verify strict aliases, action and client policy,
  typed elicitation, completion, and exact output. The test-sync fixtures verify
  full-range durations, defaults, validation, exact registration, operation
  ordering, timeout short-circuiting, and the live typed host boundary. The
  view-image fixtures verify conditional schemas, modality-first rejection,
  nullable and duplicate fields, environment and path selection, original detail
  downgrade, exact output, errors, and successful lifecycle ordering;
  `view_image.test.ts` verifies the live typed image boundary through gpufuck.
  The five tool-search fixtures run the complete registration-to-client-output
  route through gpufuck and verify source metadata deduplication, exact
  registration, deferred normalization, fixed-point BM25 ordering, stable ties,
  namespace coalescing, argument errors, and completed client output. The
  MCP-resource fixtures verify exact registrations, cursor and visibility
  policy, deterministic server ordering, response JSON, and output bounds;
  `mcp_resource.test.ts` verifies success, failure, and lifecycle order through
  the live typed transport. Agent-job fixtures verify exact schemas, worker-only
  exposure, CSV quoting and row validation, stable item preparation, scheduler
  transitions, thread-limit deferral, spawn argument policy, augmented output
  CSV, exact result JSON, report validation, and accepted-stop behavior;
  `agent_job_spawn.test.ts`, `agent_job_export.test.ts`, and
  `agent_job_report.test.ts` verify the live typed worker, file-write, and
  result persistence boundaries. The current-time fixtures verify provider
  availability, interval and backward clock behavior, boundary consumption,
  new-window refresh, tool exposure, sleep bounds, and exact UTC and
  elapsed-time text. `current_time.test.ts` verifies the live clock host
  boundary through gpufuck. `exec_command_fixture.duck`,
  `exec_output_fixture.duck`, `exec_store_fixture.duck`, the terminal-event
  fixtures, and `exec.test.ts` verify source process planning, buffering, state,
  session pruning, sandbox retry, lifecycle delivery, and the live host
  adapters. The bounded network approval fixtures verify case-insensitive host
  matching, protocol-, port-, and environment-scoped keys, pending ownership,
  session allow/deny caches, active-call ordering, ambiguous attribution, and
  deferred outcomes; `network_approval.test.ts` covers the live prompt boundary.
  The network-policy fixtures verify decider/source precedence, protocol and
  host requirements, every known denial reason plus fallback, and allow/deny
  execpolicy projection. The session-prefix fixtures verify status JSON,
  final-answer envelopes, inactive-status suppression, context labels, and the
  1,000-token manual-review threshold. The MCP fixtures verify exposure and
  approval policy. The skill fixtures verify metadata parsing, document
  construction, discovery, selection, ordering, budgeted rendering, and
  UTF-8-safe description bounds. The plugin fixtures verify active-package
  projection, deduplication, mentions, instructions, stable identifier
  validation, selector resolution, and typed plugin and marketplace CLI plans.
  The cloud CLI fixtures verify bounded task submission, pagination, lookup,
  diff, apply, and alias routing. The server CLI fixtures verify startup
  constraints and root routing. The application CLI fixtures verify desktop
  defaults, installer overrides, remote-control modes, and root routing. The
  app-server CLI fixtures verify transport selection, websocket auth, daemon
  operations, protocol generation, and root routing. The utility CLI fixtures
  verify doctor modes, ordered config overrides, proxy bounds/defaults, and the
  `a` alias. The debug CLI fixtures verify model mode, prompt/image expansion,
  app-server messages, trace output, memory reset, and root routing. The
  execpolicy CLI fixtures verify repeated rules, trailing hyphenated command
  tokens, required inputs, and root routing. The sandbox CLI fixtures verify
  profile and state constraints, repeated roots, exact trailing command
  preservation, and root routing. The exec CLI fixtures verify fresh and resumed
  sessions, review targets and conflicts, shared/output options, removed
  compatibility flags, aliases, and root routing. The hook fixtures verify
  matching, selection, trust, normalization, exact input, JSON output,
  command-result policy, and streaming result aggregation through the latest
  gpufuck backend. The tool-source fixtures verify guardian isolation, unified
  and legacy shell selection, all core utility gates, MCP order, V1 deferred
  exposure, V2 namespaces and direct-model-only exposure, agent-job tools, and
  contributed runtime ordering. They also verify that namespace overrides run
  before searchable-deferred discovery, preserve hidden exposure, and append the
  direct `tool_search` runtime only when eligible. The hosted-tool fixtures
  verify Responses Lite and provider gates, standalone `web.run` replacement,
  namespace dependence, disabled search, Cached/Indexed/Live access flags,
  text-and-image selection, and complete configured-option preservation. The
  code-mode fixtures verify plain and namespaced JavaScript names, separator
  handling, `exec`/`wait` ordering, exposure and namespace exclusions, nested
  runtime retention, enabled and deferred prompt sets, namespace ordering and
  description upgrades, direct-mode absence, and deferred-guidance gating. The
  collaboration fixtures verify V2 and feature gating, namespace and exposure
  policy, the official six-tool order, schemas, canonical task paths, depth and
  capacity errors, message and follow-up distinction, normalized fork modes,
  root/self target rejections, interrupt targets, wait bounds, list prefixes,
  agent-status encoding, metadata-sensitive spawn schemas and output,
  requested/default/inherited spawn overrides, bounded model errors, unsupported
  reasoning-effort errors, and exact interrupt, wait, and list output;
  `agent.test.ts` verifies the legacy live typed mechanics boundary, while
  `agent_tool_spawn.test.ts` and `agent_tool_control.test.ts` verify all six V2
  host operations, retained policy and output stages, pre-spawn rejection,
  successful-spawn telemetry, final client text, and lifecycle ordering. The 17
  agent-job fixtures verify exact registration, typed argument decoding,
  local-environment and concurrency policy, CSV preparation, runner transitions,
  result aggregation, CSV output, and report validation; the live agent fixtures
  verify the typed host boundaries through the same backend.

## Port order

The project is being ported by moving pure policy and reusable data structures
first, then capability-backed systems. Conversation normalization, rollback,
token estimation, local compaction, project-instruction discovery, configuration
layering, context rendering, rollout persistence policy, reverse model-context
scanning, rollout storage discovery, and app-server initialization are
implemented. The remaining order is:

1. Remaining capability-backed runtime systems and user-interface policy.
2. Differential fixtures against the official implementation.

Codex-specific request and event names stay in this case study. Collections,
JSON, traversal, async, state, and resource abstractions belong in the prelude
and must remain useful without Codex.

## Known compiler boundaries

Every executable fixture uses `DuckCompiler` and the gpufuck target. There is no
second backend or differential native-Core suite.

A few large compositions remain split into smaller source stages because a
single gpufuck functional surface is currently limited to 65,536 expressions.
This affects the complete recursive JSON tool decoders, the all-in-one
collaboration tool registry, and some code-mode response compositions. The
stages are still Duck programs; TypeScript only coordinates their typed host
boundaries.

Image decoding and resizing remain host operations. Audio and image policy,
payload construction, response shaping, and all other case-study behavior stay
in Duck source.
