import type { Source as SourceNode } from "../frontend/ast.ts";
import { Source } from "../frontend/source.ts";
import { source_import_expressions } from "../frontend/import_diagnostic.ts";
import { format_syntax } from "../fmt/format.ts";
import { analysis_diagnostics, type LspDiagnostic } from "./diagnostics.ts";
import {
  document_content_hash,
  DocumentStore,
  DocumentStoreError,
  type TextDocumentChange,
} from "./documents.ts";
import { encode_message, MessageDecoder } from "./framing.ts";
import { document_binding_index } from "./binding_index.ts";
import {
  completions,
  type LspCompletionItem,
  resolve_completion_item,
} from "./completion.ts";
import {
  code_actions,
  type LspCodeAction,
  resolve_code_action,
} from "./code_actions.ts";
import {
  definition_location,
  document_highlights,
  import_definition_location,
  prepare_rename,
  reference_locations,
  rename_symbol,
  type_definition_location,
  workspace_symbols,
  type WorkspaceIndexEntry,
} from "./navigation.ts";
import { hover as hover_at, signature_help } from "./hover.ts";
import {
  default_inlay_hint_config,
  inlay_hints,
  type InlayHintCategory,
  type InlayHintConfig,
  type LspInlayHint,
  resolve_inlay_hint,
} from "./inlay_hints.ts";
import {
  semantic_token_modifiers,
  semantic_token_types,
  semantic_tokens,
  semantic_tokens_delta,
  type SemanticTokens,
} from "./semantic_tokens.ts";
import {
  type LspPosition,
  type LspRange,
  position_from_offset,
  type PositionEncoding,
  PositionIndex,
} from "./position.ts";
import {
  type ExecuteCommandRequest,
  expand_comptime,
  powertools_code_lenses,
  route_execute_command,
  route_for_uri,
  type Stage,
  view_stage,
} from "./powertools.ts";
import { document_symbols } from "./symbols.ts";
import {
  workspace_definition_location,
  workspace_reference_locations,
  workspace_rename_symbol,
  WorkspaceModel,
} from "./workspace.ts";

type RpcMessage = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  // deno-lint-ignore no-explicit-any
  params?: any;
};

export type ServerState = {
  cancelled_requests: Set<number | string | null>;
  dependencies: Map<string, Set<string>>;
  diagnostics_depth: number;
  reverse_dependencies: Map<string, Set<string>>;
  documents: DocumentStore;
  exited: boolean;
  format_broken_buffers: boolean;
  initialized: boolean;
  last_reanalysis_fanout: number;
  max_reanalysis_fanout: number;
  pending_diagnostics: Map<string, PendingDiagnostics>;
  semantic_token_results: Map<string, Map<string, SemanticTokens>>;
  shutdown_requested: boolean;
  inlay_hint_config: InlayHintConfig;
  workspace: WorkspaceModel;
  workspace_analysis_results: Map<string, WorkspaceAnalysisResult>;
  workspace_roots: string[];
  debounce_ms: number;
  now: () => number;
};

export type ServerOptions = {
  debounce_ms?: number;
  now?: () => number;
};

type PendingDiagnostics = {
  uri: string;
  version: number | undefined;
  due_at: number;
};

type WorkspaceAnalysisResult = {
  content_hash: string;
  analysis: ReturnType<typeof Source.analyze>;
};

type NavigationRequest = {
  uri: string;
  document: NonNullable<ReturnType<DocumentStore["get"]>>;
  index: ReturnType<typeof document_binding_index>;
  offset: number;
};

const lsp_source_import_meta = {
  mode: { atom: "test" },
} as const;

export function create_state(options?: ServerOptions): ServerState {
  let debounce_ms = 75;
  let now = (): number => Date.now();

  if (options?.debounce_ms !== undefined) {
    if (!Number.isFinite(options.debounce_ms) || options.debounce_ms < 0) {
      throw new Error("LSP diagnostic debounce must be non-negative");
    }

    debounce_ms = options.debounce_ms;
  }

  if (options?.now !== undefined) {
    now = options.now;
  }

  return {
    cancelled_requests: new Set(),
    dependencies: new Map(),
    diagnostics_depth: 64,
    reverse_dependencies: new Map(),
    documents: new DocumentStore(),
    exited: false,
    format_broken_buffers: false,
    initialized: false,
    last_reanalysis_fanout: 0,
    max_reanalysis_fanout: 128,
    pending_diagnostics: new Map(),
    semantic_token_results: new Map(),
    shutdown_requested: false,
    inlay_hint_config: default_inlay_hint_config(),
    workspace: new WorkspaceModel([]),
    workspace_analysis_results: new Map(),
    workspace_roots: [],
    debounce_ms,
    now,
  };
}

// Handle one message and return the messages to send back. The transport is
// kept outside so the protocol logic stays testable.
export function handle_message(
  state: ServerState,
  message: RpcMessage,
): unknown[] {
  const method = message.method;

  if (method === undefined) {
    return [];
  }

  if (message.id !== undefined) {
    return handle_request(state, message);
  }

  return handle_notification(state, message);
}

function handle_request(state: ServerState, message: RpcMessage): unknown[] {
  if (state.cancelled_requests.delete(request_id(message))) {
    return [cancelled_response(message)];
  }

  if (state.shutdown_requested && message.method !== "shutdown") {
    return [{
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32600, message: "Server has shut down" },
    }];
  }

  if (message.method === "initialize") {
    const progress_token = initialization_progress_token(message.params);
    const replies: unknown[] = [];

    if (progress_token !== undefined) {
      replies.push(progress_message(progress_token, {
        kind: "begin",
        title: "Loading Duck workspace",
        percentage: 0,
      }));
    }

    if (!state.initialized) {
      state.documents = new DocumentStore(
        select_position_encoding(message.params),
      );
      state.dependencies.clear();
      state.reverse_dependencies.clear();
      state.semantic_token_results.clear();
      state.workspace_analysis_results.clear();
      state.workspace = new WorkspaceModel(
        workspace_roots_from_params(message.params),
      );
      state.workspace_roots = [...state.workspace.roots];
      apply_workspace_config(
        state,
        initialization_workspace_settings(message.params),
      );
      apply_inlay_hint_config(
        state.inlay_hint_config,
        initialization_inlay_hint_settings(message.params),
      );
      state.workspace.load(
        state.documents.open_documents(),
        (event) => {
          if (progress_token === undefined || event.total === 0) {
            return;
          }

          replies.push(progress_message(progress_token, {
            kind: "report",
            message: event.uri,
            percentage: Math.floor(event.loaded * 100 / event.total),
          }));
        },
      );
      state.initialized = true;
    }

    if (progress_token !== undefined) {
      replies.push(progress_message(progress_token, {
        kind: "end",
        message: "Duck workspace loaded",
      }));
    }

    replies.push(respond(message, {
      capabilities: {
        positionEncoding: state.documents.position_encoding,
        textDocumentSync: {
          openClose: true,
          change: 2,
          willSave: true,
          save: { includeText: true },
        },
        documentFormattingProvider: true,
        documentSymbolProvider: true,
        definitionProvider: true,
        typeDefinitionProvider: true,
        referencesProvider: true,
        documentHighlightProvider: true,
        workspaceSymbolProvider: true,
        renameProvider: { prepareProvider: true },
        codeActionProvider: {
          resolveProvider: true,
          codeActionKinds: [
            "quickfix",
            "refactor.rewrite",
            "refactor.extract",
            "refactor.inline",
            "source.fixAll",
          ],
        },
        completionProvider: {
          resolveProvider: true,
          triggerCharacters: completion_trigger_characters(),
        },
        hoverProvider: true,
        signatureHelpProvider: {
          triggerCharacters: ["(", ",", " "],
          retriggerCharacters: [",", " "],
        },
        inlayHintProvider: { resolveProvider: true },
        codeLensProvider: { resolveProvider: false },
        executeCommandProvider: {
          commands: [
            "duck.viewStage",
            "duck.expandComptime",
            "duck.runExample",
          ],
        },
        semanticTokensProvider: {
          legend: {
            tokenTypes: [...semantic_token_types],
            tokenModifiers: [...semantic_token_modifiers],
          },
          range: true,
          full: { delta: true },
        },
      },
      experimental: {
        duck: {
          expandComptime: true,
          viewStage: ["ic", "expr", "mod", "wat"],
        },
      },
      serverInfo: { name: "duck-lsp", version: "0.1.0" },
    }));
    return replies;
  }

  if (message.method === "shutdown") {
    state.shutdown_requested = true;
    return [respond(message, null)];
  }

  if (message.method === "textDocument/formatting") {
    const uri = uri_from_text_document(message.params);

    if (uri === undefined) {
      return [respond(message, null)];
    }

    const document = state.documents.get(uri);

    if (document === undefined) {
      return [respond(message, null)];
    }

    // Refuse to format documents that do not parse; a formatter that runs
    // on broken input can only make the breakage harder to see.
    const parsed = parsed_document(state, uri);

    if (parsed.diagnostics.length > 0 && !state.format_broken_buffers) {
      return [respond(message, null)];
    }

    const formatted = state.documents.compute(
      uri,
      "format",
      (_text) => format_syntax(parsed.syntax),
    );

    if (formatted === document.text) {
      return [respond(message, [])];
    }

    return [respond(message, [{
      range: {
        start: { line: 0, character: 0 },
        end: position_from_offset(
          document.text,
          document.text.length,
          state.documents.position_encoding,
        ),
      },
      newText: formatted,
    }])];
  }

  if (message.method === "textDocument/documentSymbol") {
    const uri = uri_from_text_document(message.params);

    if (uri === undefined || state.documents.get(uri) === undefined) {
      return [respond(message, [])];
    }

    const parsed = parsed_document(state, uri);
    return [respond(
      message,
      state.documents.compute(
        uri,
        "document_symbols",
        (_text) =>
          document_symbols(
            parsed.source,
            parsed.syntax,
            state.documents.position_encoding,
          ),
      ),
    )];
  }

  if (message.method === "textDocument/definition") {
    const request = navigation_request(state, message.params);

    if (request === undefined) {
      return [respond(message, null)];
    }

    const parsed = parsed_document(state, request.uri);
    const imported = import_definition_location(
      parsed.source,
      request.index,
      request.uri,
      request.offset,
    );

    if (imported !== undefined) {
      return [respond(message, imported)];
    }

    const location = definition_location(
      request.index,
      request.document.text,
      request.uri,
      request.offset,
      state.documents.position_encoding,
    );

    if (location === undefined) {
      const workspace_location = workspace_definition_location(
        workspace_analysis_entries(state),
        request.uri,
        request.offset,
        state.documents.position_encoding,
      );
      return [respond(message, workspace_location)];
    }

    return [respond(message, location)];
  }

  if (message.method === "textDocument/typeDefinition") {
    const request = navigation_request(state, message.params);

    if (request === undefined) {
      return [respond(message, null)];
    }

    const location = type_definition_location(
      request.index,
      request.document.text,
      request.uri,
      request.offset,
      state.documents.position_encoding,
    );

    if (location === undefined) {
      const workspace_location = workspace_definition_location(
        workspace_analysis_entries(state),
        request.uri,
        request.offset,
        state.documents.position_encoding,
      );
      return [respond(message, workspace_location)];
    }

    return [respond(message, location)];
  }

  if (message.method === "textDocument/references") {
    const request = navigation_request(state, message.params);

    if (request === undefined) {
      return [respond(message, [])];
    }

    const include_declaration = references_include_declaration(message.params);
    const workspace_locations = workspace_reference_locations(
      workspace_analysis_entries(state),
      request.uri,
      request.offset,
      include_declaration,
      state.documents.position_encoding,
    );

    if (workspace_locations.length > 0) {
      return [respond(message, workspace_locations)];
    }

    return [respond(
      message,
      reference_locations(
        request.index,
        request.document.text,
        request.uri,
        request.offset,
        include_declaration,
        state.documents.position_encoding,
      ),
    )];
  }

  if (message.method === "textDocument/documentHighlight") {
    const request = navigation_request(state, message.params);

    if (request === undefined) {
      return [respond(message, [])];
    }

    return [respond(
      message,
      document_highlights(
        request.index,
        request.document.text,
        request.offset,
        state.documents.position_encoding,
      ),
    )];
  }

  if (message.method === "textDocument/prepareRename") {
    const request = navigation_request(state, message.params);

    if (request === undefined) {
      return [respond(message, null)];
    }

    const preparation = prepare_rename(
      request.index,
      request.document.text,
      request.offset,
      state.documents.position_encoding,
    );

    if (preparation === undefined) {
      const location = workspace_definition_location(
        workspace_analysis_entries(state),
        request.uri,
        request.offset,
        state.documents.position_encoding,
      );

      if (location === undefined) {
        return [respond(message, null)];
      }

      const occurrence = request.index.occurrence_at(request.offset);

      if (occurrence === undefined) {
        return [respond(message, null)];
      }

      const positions = new PositionIndex(
        request.document.text,
        state.documents.position_encoding,
      );
      return [respond(message, {
        range: {
          start: positions.position_from_offset(occurrence.span.start),
          end: positions.position_from_offset(occurrence.span.end),
        },
        placeholder: occurrence.name,
      })];
    }

    return [respond(message, preparation)];
  }

  if (message.method === "textDocument/rename") {
    const request = navigation_request(state, message.params);
    const params = as_record(message.params);

    if (
      request === undefined || params === undefined ||
      typeof params.newName !== "string"
    ) {
      return [respond(message, null)];
    }

    let edit = workspace_rename_symbol(
      workspace_analysis_entries(state),
      request.uri,
      request.offset,
      params.newName,
      state.documents.position_encoding,
    );

    if (edit === undefined) {
      edit = rename_symbol(
        request.index,
        request.document.text,
        request.uri,
        request.offset,
        params.newName,
        state.documents.position_encoding,
      );
    }

    if (edit === undefined) {
      return [respond(message, null)];
    }

    return [respond(message, edit)];
  }

  if (message.method === "workspace/symbol") {
    const params = as_record(message.params);

    if (params === undefined || typeof params.query !== "string") {
      return [respond(message, [])];
    }

    return [respond(
      message,
      workspace_symbols(
        workspace_index_entries(state),
        params.query,
        state.documents.position_encoding,
      ),
    )];
  }

  if (message.method === "textDocument/codeAction") {
    const uri = uri_from_text_document(message.params);
    const params = as_record(message.params);

    if (
      uri === undefined || params === undefined ||
      !is_lsp_range(params.range)
    ) {
      return [respond(message, [])];
    }

    const document = state.documents.get(uri);

    if (document === undefined) {
      return [respond(message, [])];
    }

    const context = as_record(params.context);
    const diagnostics = lsp_diagnostics_from_context(context);
    const parsed = parsed_document(state, uri);
    return [respond(
      message,
      code_actions(
        parsed.source,
        parsed.syntax,
        document_binding_index(state.documents, uri),
        uri,
        document.version,
        params.range,
        diagnostics,
        state.documents.position_encoding,
      ),
    )];
  }

  if (message.method === "duck/expandComptime") {
    const uri = uri_from_text_document(message.params);
    const params = as_record(message.params);
    let position: unknown;

    if (params !== undefined) {
      position = params.position;
    }

    if (
      uri === undefined || !is_lsp_position(position) ||
      state.documents.get(uri) === undefined
    ) {
      return [respond(message, {
        ok: false,
        code: "no_comptime_target",
        message: "duck/expandComptime requires an open document and position",
      })];
    }

    const document = state.documents.get(uri);

    if (document === undefined) {
      throw new Error("Missing open powertools document");
    }

    return [respond(
      message,
      expand_comptime(
        document.text,
        position,
        state.documents.position_encoding,
      ),
    )];
  }

  if (message.method === "duck/viewStage") {
    const uri = uri_from_text_document(message.params);
    const params = as_record(message.params);

    if (
      uri === undefined || params === undefined ||
      !is_stage(params.stage) || state.documents.get(uri) === undefined
    ) {
      return [respond(message, {
        ok: false,
        code: "unsupported_route",
        message: "duck/viewStage requires an open document and valid stage",
      })];
    }

    const document = state.documents.get(uri);

    if (document === undefined) {
      throw new Error("Missing open stage document");
    }

    return [respond(message, view_stage(uri, document.text, params.stage))];
  }

  if (message.method === "textDocument/codeLens") {
    const uri = uri_from_text_document(message.params);

    if (uri === undefined) {
      return [respond(message, [])];
    }

    const document = state.documents.get(uri);

    if (document === undefined) {
      return [respond(message, [])];
    }

    return [respond(
      message,
      powertools_code_lenses(
        uri,
        document.text,
        state.documents.position_encoding,
      ).map((lens) => ({
        range: lens.range,
        command: {
          title: lens.title,
          command: lens.command,
          arguments: lens.arguments,
        },
      })),
    )];
  }

  if (message.method === "workspace/executeCommand") {
    const request = execute_command_from_params(state, message.params);

    if (request === undefined) {
      return [respond(message, {
        ok: false,
        code: "unknown_command",
        message: "Malformed Duck workspace command",
      })];
    }

    return [respond(message, route_execute_command(request))];
  }

  if (message.method === "codeAction/resolve") {
    const action = code_action_from_params(message.params);

    if (action === undefined) {
      return [respond(message, message.params)];
    }

    const document = state.documents.get(action.data.uri);

    if (document === undefined) {
      return [respond(message, action)];
    }

    const parsed = parsed_document(state, action.data.uri);
    const resolved = resolve_code_action(action, {
      analyze: (text) =>
        Source.analyze(text, {
          import_meta: lsp_source_import_meta,
          route: analysis_route(
            action.data.uri,
            Source.parse_with_diagnostics(text).source,
          ),
          uri: action.data.uri,
          resolve_import: (dependency_uri) =>
            resolve_document_import(state, dependency_uri),
          warnings: true,
        }),
      uri: action.data.uri,
      version: document.version,
      text: document.text,
      parsed,
      index: document_binding_index(state.documents, action.data.uri),
      encoding: state.documents.position_encoding,
    });

    if (resolved === undefined) {
      return [respond(message, action)];
    }

    return [respond(message, resolved)];
  }

  if (message.method === "textDocument/completion") {
    const request = navigation_request(state, message.params);

    if (request === undefined) {
      return [respond(message, { isIncomplete: false, items: [] })];
    }

    const parsed = parsed_document(state, request.uri);
    return [respond(
      message,
      completions(
        parsed.source,
        parsed.syntax,
        request.index,
        request.uri,
        request.offset,
        { import_paths: import_completion_paths(state, request.uri) },
      ),
    )];
  }

  if (message.method === "completionItem/resolve") {
    const item = completion_item_from_params(message.params);

    if (item === undefined || item.data === undefined) {
      return [respond(message, message.params)];
    }

    const document = state.documents.get(item.data.uri);

    if (document === undefined) {
      return [respond(message, item)];
    }

    const parsed = parsed_document(state, item.data.uri);
    return [respond(
      message,
      resolve_completion_item(
        item,
        parsed.source,
        document_binding_index(state.documents, item.data.uri),
        parsed.syntax,
      ),
    )];
  }

  if (message.method === "textDocument/inlayHint") {
    const uri = uri_from_text_document(message.params);
    const params = as_record(message.params);

    if (
      uri === undefined || params === undefined ||
      !is_lsp_range(params.range)
    ) {
      return [respond(message, [])];
    }

    const document = state.documents.get(uri);

    if (document === undefined) {
      return [respond(message, [])];
    }

    let offsets;

    try {
      offsets = new PositionIndex(
        document.text,
        state.documents.position_encoding,
      ).offsets_from_range(params.range);
    } catch (error) {
      if (error instanceof Error) {
        return [respond(message, [])];
      }

      throw error;
    }

    const parsed = parsed_document(state, uri);
    const analyzed = semantic_document(state, uri);
    return [respond(
      message,
      inlay_hints(
        analyzed.source,
        parsed.syntax,
        document_binding_index(state.documents, uri),
        uri,
        offsets,
        state.documents.position_encoding,
        state.inlay_hint_config,
      ),
    )];
  }

  if (message.method === "inlayHint/resolve") {
    const hint = inlay_hint_from_params(message.params);

    if (hint === undefined) {
      return [respond(message, message.params)];
    }

    return [respond(message, resolve_inlay_hint(hint))];
  }

  if (message.method === "textDocument/hover") {
    const request = navigation_request(state, message.params);

    if (request === undefined) {
      return [respond(message, null)];
    }

    const parsed = parsed_document(state, request.uri);
    const analyzed = semantic_document(state, request.uri);
    const result = hover_at(
      analyzed.source,
      parsed.syntax,
      request.index,
      request.offset,
      state.documents.position_encoding,
    );

    if (result === undefined) {
      return [respond(message, null)];
    }

    return [respond(message, result)];
  }

  if (message.method === "textDocument/signatureHelp") {
    const request = navigation_request(state, message.params);

    if (request === undefined) {
      return [respond(message, null)];
    }

    const parsed = parsed_document(state, request.uri);
    const analyzed = semantic_document(state, request.uri);
    const result = signature_help(
      analyzed.source,
      parsed.syntax,
      request.index,
      request.offset,
    );

    if (result === undefined) {
      return [respond(message, null)];
    }

    return [respond(message, result)];
  }

  if (message.method === "textDocument/semanticTokens/full") {
    const uri = uri_from_text_document(message.params);

    if (uri === undefined || state.documents.get(uri) === undefined) {
      return [respond(message, { data: [] })];
    }

    return [respond(message, document_semantic_tokens(state, uri))];
  }

  if (message.method === "textDocument/semanticTokens/range") {
    const uri = uri_from_text_document(message.params);
    const params = as_record(message.params);

    if (
      uri === undefined || params === undefined ||
      !is_lsp_range(params.range)
    ) {
      return [respond(message, { data: [] })];
    }

    const document = state.documents.get(uri);

    if (document === undefined) {
      return [respond(message, { data: [] })];
    }

    let offsets;

    try {
      offsets = new PositionIndex(
        document.text,
        state.documents.position_encoding,
      ).offsets_from_range(params.range);
    } catch (error) {
      if (error instanceof Error) {
        return [respond(message, { data: [] })];
      }

      throw error;
    }

    const parsed = parsed_document(state, uri);
    const result = semantic_tokens(
      parsed.source,
      parsed.syntax,
      document_binding_index(state.documents, uri),
      document.version,
      state.documents.position_encoding,
      offsets,
    );
    return [respond(message, result)];
  }

  if (message.method === "textDocument/semanticTokens/full/delta") {
    const uri = uri_from_text_document(message.params);
    const params = as_record(message.params);

    if (
      uri === undefined || params === undefined ||
      typeof params.previousResultId !== "string" ||
      state.documents.get(uri) === undefined
    ) {
      return [respond(message, { data: [] })];
    }

    const current = document_semantic_tokens(state, uri);
    const previous = state.semantic_token_results.get(uri)?.get(
      params.previousResultId,
    );

    if (previous === undefined) {
      return [respond(message, current)];
    }

    return [respond(message, semantic_tokens_delta(previous, current))];
  }

  return [{
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "Method not found: " + message.method },
  }];
}

function handle_notification(
  state: ServerState,
  message: RpcMessage,
): unknown[] {
  if (message.method === "$/cancelRequest") {
    const params = as_record(message.params);

    if (
      params !== undefined &&
      (typeof params.id === "number" || typeof params.id === "string" ||
        params.id === null)
    ) {
      state.cancelled_requests.add(params.id);
    }

    return [];
  }

  if (message.method === "exit") {
    state.exited = true;
    return [];
  }

  if (message.method === "textDocument/didOpen") {
    const document = open_document_from_params(message.params);

    if (document === undefined) {
      return [];
    }

    try {
      state.documents.open(document.uri, document.version, document.text);
    } catch (error) {
      if (error instanceof DocumentStoreError) {
        return [];
      }

      throw error;
    }

    state.workspace.refresh(document.uri, state.documents.get(document.uri));
    state.workspace_analysis_results.delete(document.uri);
    state.pending_diagnostics.delete(document.uri);
    const messages = [publish_diagnostics(state, document.uri)];
    const dependents = invalidate_dependents(state, document.uri);

    for (const dependent of dependents) {
      messages.push(publish_diagnostics(state, dependent));
    }

    return messages;
  }

  if (message.method === "workspace/didChangeConfiguration") {
    for (const settings of workspace_server_settings(message.params)) {
      apply_workspace_config(state, settings);
    }

    for (const settings of workspace_inlay_hint_settings(message.params)) {
      apply_inlay_hint_config(state.inlay_hint_config, settings);
    }
    return [];
  }

  if (message.method === "textDocument/didChange") {
    const change = change_from_params(message.params);

    if (change === undefined) {
      return [];
    }

    let document;

    try {
      document = state.documents.apply_changes(
        change.uri,
        change.version,
        change.changes,
      );
    } catch (error) {
      if (error instanceof DocumentStoreError) {
        return [];
      }

      throw error;
    }

    state.workspace.refresh(change.uri, document);
    state.workspace_analysis_results.delete(change.uri);
    const due_at = state.now() + state.debounce_ms;
    schedule_diagnostics(state, change.uri, document.version, due_at);
    const dependents = invalidate_dependents(state, change.uri);

    for (const dependent of dependents) {
      const dependent_document = state.documents.get(dependent);

      if (dependent_document !== undefined) {
        schedule_diagnostics(
          state,
          dependent,
          dependent_document.version,
          due_at,
        );
      } else {
        schedule_diagnostics(state, dependent, undefined, due_at);
      }
    }
    return [];
  }

  if (message.method === "textDocument/willSave") {
    const uri = uri_from_text_document(message.params);

    if (uri !== undefined) {
      state.documents.will_save(uri);
    }

    return [];
  }

  if (message.method === "textDocument/didSave") {
    const uri = uri_from_text_document(message.params);

    if (uri !== undefined) {
      // didSave.text has no document version. The incremental change stream
      // remains authoritative, so saved text cannot overwrite newer edits.
      state.documents.did_save(uri);
      state.workspace.refresh(uri, state.documents.get(uri));
      state.workspace_analysis_results.delete(uri);
      state.pending_diagnostics.delete(uri);

      if (state.documents.get(uri) !== undefined) {
        const messages = [publish_diagnostics(state, uri)];
        const dependents = invalidate_dependents(state, uri);

        for (const dependent of dependents) {
          messages.push(publish_diagnostics(state, dependent));
        }

        return messages;
      }
    }

    return [];
  }

  if (message.method === "workspace/didChangeWatchedFiles") {
    const params = as_record(message.params);

    if (params === undefined) {
      return [];
    }

    const changes = params.changes;

    if (!Array.isArray(changes)) {
      return [];
    }

    const affected = new Set<string>();

    for (const change of changes) {
      const watched = as_record(change);

      if (watched !== undefined && is_valid_uri(watched.uri)) {
        state.documents.watched_file_changed(watched.uri);
        state.workspace.refresh(
          watched.uri,
          state.documents.get(watched.uri),
        );
        state.workspace_analysis_results.delete(watched.uri);

        for (const dependent of invalidate_dependents(state, watched.uri)) {
          affected.add(dependent);
        }
      }
    }

    const messages: unknown[] = [];

    for (const uri of affected) {
      messages.push(publish_diagnostics(state, uri));
    }

    return messages;
  }

  if (message.method === "textDocument/didClose") {
    const uri = uri_from_text_document(message.params);

    if (uri === undefined) {
      return [];
    }

    state.documents.close(uri);
    state.pending_diagnostics.delete(uri);
    state.semantic_token_results.delete(uri);
    remove_document_dependencies(state, uri);
    state.workspace.refresh(uri, undefined);
    state.workspace_analysis_results.delete(uri);
    const messages: unknown[] = [{
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics: [] },
    }];

    for (const dependent of invalidate_dependents(state, uri)) {
      messages.push(publish_diagnostics(state, dependent));
    }

    return messages;
  }

  return [];
}

export function flush_due_diagnostics(
  state: ServerState,
  current_time: number,
): unknown[] {
  const due: PendingDiagnostics[] = [];

  for (const pending of state.pending_diagnostics.values()) {
    if (pending.due_at <= current_time) {
      due.push(pending);
    }
  }

  due.sort((left, right) => {
    if (left.due_at !== right.due_at) {
      return left.due_at - right.due_at;
    }

    return left.uri.localeCompare(right.uri);
  });
  const messages: unknown[] = [];

  for (const pending of due) {
    state.pending_diagnostics.delete(pending.uri);
    const document = state.documents.get(pending.uri);

    if (pending.version !== undefined) {
      if (document === undefined || document.version !== pending.version) {
        continue;
      }
    } else if (document !== undefined) {
      continue;
    }

    messages.push(publish_diagnostics(state, pending.uri));
  }

  return messages;
}

export function next_diagnostic_deadline(
  state: ServerState,
): number | undefined {
  let deadline: number | undefined;

  for (const pending of state.pending_diagnostics.values()) {
    if (deadline === undefined || pending.due_at < deadline) {
      deadline = pending.due_at;
    }
  }

  return deadline;
}

function publish_diagnostics(state: ServerState, uri: string): unknown {
  const document = state.documents.get(uri);

  if (document === undefined) {
    const analysis = workspace_semantic_document(state, uri);

    if (analysis !== undefined) {
      return {
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          diagnostics: analysis_diagnostics(
            analysis,
            uri,
            state.documents.position_encoding,
          ),
        },
      };
    }

    return {
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics: [] },
    };
  }

  const diagnostics = analysis_diagnostics(
    semantic_document(state, uri),
    uri,
    state.documents.position_encoding,
  );
  return {
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, version: document.version, diagnostics },
  };
}

function parsed_document(
  state: ServerState,
  uri: string,
): ReturnType<typeof Source.parse_with_diagnostics> {
  return state.documents.compute(
    uri,
    "source_parse",
    Source.parse_with_diagnostics,
  );
}

function semantic_document(
  state: ServerState,
  uri: string,
): ReturnType<typeof Source.analyze> {
  const parsed = parsed_document(state, uri);
  const dependencies = new Set<string>();
  let recomputed = false;
  const analysis = state.documents.compute(
    uri,
    "source_analysis",
    (_text) => {
      recomputed = true;
      return Source.analyze_parsed(parsed, {
        host_interface: sibling_host_interface(
          parsed.source,
          uri,
          (dependency_uri) => {
            dependencies.add(dependency_uri);
            return resolve_document_import(state, dependency_uri);
          },
        ),
        import_meta: lsp_source_import_meta,
        route: analysis_route(uri, parsed.source),
        uri,
        resolve_import: (dependency_uri) => {
          dependencies.add(dependency_uri);
          return resolve_document_import(state, dependency_uri);
        },
        warnings: true,
      });
    },
  );

  if (recomputed) {
    replace_document_dependencies(state, uri, dependencies);
  }

  return analysis;
}

function workspace_semantic_document(
  state: ServerState,
  uri: string,
): ReturnType<typeof Source.analyze> | undefined {
  const text = state.workspace.text(uri, state.documents.open_documents());

  if (text === undefined) {
    return undefined;
  }

  const content_hash = document_content_hash(text);
  const cached = state.workspace_analysis_results.get(uri);

  if (
    cached !== undefined && cached.content_hash === content_hash &&
    cached.analysis.syntax.text === text
  ) {
    return cached.analysis;
  }

  const parsed = Source.parse_with_diagnostics(text);
  const analysis = Source.analyze_parsed(parsed, {
    host_interface: sibling_host_interface(
      parsed.source,
      uri,
      (dependency_uri) => resolve_document_import(state, dependency_uri),
    ),
    import_meta: lsp_source_import_meta,
    route: analysis_route(uri, parsed.source),
    uri,
    resolve_import: (dependency_uri) =>
      resolve_document_import(state, dependency_uri),
    warnings: true,
  });
  state.workspace_analysis_results.set(uri, { content_hash, analysis });
  return analysis;
}

function sibling_host_interface(
  source: SourceNode,
  uri: string,
  resolve_source: (uri: string) => string | undefined,
): SourceNode | undefined {
  if (source.module === undefined || source.module.params.length === 0) {
    return undefined;
  }

  const declarations = source.declarations || [];
  let missing_interface = false;

  for (const param of source.module.params) {
    if (param.annotation === undefined) {
      continue;
    }

    const declaration = declarations.find((candidate) => {
      if (candidate.tag === "extend" || candidate.tag === "fixity") {
        return false;
      }

      return candidate.name === param.annotation;
    });

    if (declaration === undefined) {
      missing_interface = true;
      break;
    }
  }

  if (!missing_interface) {
    return undefined;
  }

  const host_uri = new URL("./host.duck", uri).href;

  if (host_uri === uri) {
    return undefined;
  }

  const text = resolve_source(host_uri);

  if (text === undefined) {
    return undefined;
  }

  const parsed = Source.parse_with_diagnostics(text);

  if (parsed.diagnostics.length > 0) {
    return undefined;
  }

  return parsed.source;
}

function analysis_route(
  uri: string,
  source: ReturnType<typeof Source.parse>,
): "ic" | "core" | "managed" {
  if (
    source.module !== undefined || source_import_expressions(source).length > 0
  ) {
    return "core";
  }

  return route_for_uri(uri);
}

function document_semantic_tokens(
  state: ServerState,
  uri: string,
): SemanticTokens {
  const document = state.documents.get(uri);

  if (document === undefined) {
    throw new Error("Cannot tokenize a document that is not open");
  }

  const parsed = parsed_document(state, uri);
  const result = state.documents.compute(
    uri,
    "semantic_tokens",
    () =>
      semantic_tokens(
        parsed.source,
        parsed.syntax,
        document_binding_index(state.documents, uri),
        document.version,
        state.documents.position_encoding,
      ),
  );
  let results = state.semantic_token_results.get(uri);

  if (results === undefined) {
    results = new Map();
    state.semantic_token_results.set(uri, results);
  }

  results.set(result.resultId, result);

  while (results.size > 4) {
    const oldest = results.keys().next().value;

    if (typeof oldest !== "string") {
      throw new Error("Missing semantic token result id");
    }

    results.delete(oldest);
  }

  return result;
}

function schedule_diagnostics(
  state: ServerState,
  uri: string,
  version: number | undefined,
  due_at: number,
): void {
  state.pending_diagnostics.set(uri, { uri, version, due_at });
}

function replace_document_dependencies(
  state: ServerState,
  uri: string,
  dependencies: Set<string>,
): void {
  remove_document_dependencies(state, uri);
  state.dependencies.set(uri, dependencies);

  for (const dependency of dependencies) {
    let importers = state.reverse_dependencies.get(dependency);

    if (importers === undefined) {
      importers = new Set();
      state.reverse_dependencies.set(dependency, importers);
    }

    importers.add(uri);
  }
}

function remove_document_dependencies(state: ServerState, uri: string): void {
  const dependencies = state.dependencies.get(uri);

  if (dependencies === undefined) {
    return;
  }

  for (const dependency of dependencies) {
    const importers = state.reverse_dependencies.get(dependency);

    if (importers === undefined) {
      continue;
    }

    importers.delete(uri);

    if (importers.size === 0) {
      state.reverse_dependencies.delete(dependency);
    }
  }

  state.dependencies.delete(uri);
}

function invalidate_dependents(state: ServerState, uri: string): string[] {
  const affected = new Set<string>();
  const visited = new Set<string>([uri]);
  const pending = [{ uri, depth: 0 }];

  while (
    pending.length > 0 && affected.size < state.max_reanalysis_fanout
  ) {
    const item = pending.shift();

    if (item === undefined) {
      throw new Error("Missing pending dependency URI");
    }

    if (item.depth >= state.diagnostics_depth) {
      continue;
    }

    const importers = state.reverse_dependencies.get(item.uri);

    if (importers === undefined) {
      continue;
    }

    for (const importer of importers) {
      if (visited.has(importer)) {
        continue;
      }

      visited.add(importer);
      state.documents.invalidate_cache(importer);
      state.workspace_analysis_results.delete(importer);
      affected.add(importer);

      if (affected.size >= state.max_reanalysis_fanout) {
        break;
      }

      pending.push({ uri: importer, depth: item.depth + 1 });
    }
  }

  for (
    const importer of state.workspace.affected_dependents(
      uri,
      state.diagnostics_depth,
      state.max_reanalysis_fanout,
    )
  ) {
    if (affected.size >= state.max_reanalysis_fanout) {
      break;
    }

    state.documents.invalidate_cache(importer);
    state.workspace_analysis_results.delete(importer);
    affected.add(importer);
  }

  state.last_reanalysis_fanout = affected.size;
  return [...affected].sort();
}

function resolve_document_import(
  state: ServerState,
  uri: string,
): string | undefined {
  const open = state.documents.get(uri);

  if (open !== undefined) {
    return open.text;
  }

  const workspace_text = state.workspace.text(
    uri,
    state.documents.open_documents(),
  );

  if (workspace_text !== undefined) {
    return workspace_text;
  }

  const url = new URL(uri);

  if (url.protocol !== "file:") {
    return undefined;
  }

  try {
    return Deno.readTextFileSync(url);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }

    throw error;
  }
}

function navigation_request(
  state: ServerState,
  params: unknown,
): NavigationRequest | undefined {
  const record = as_record(params);

  if (record === undefined) {
    return undefined;
  }

  const text_document = as_record(record.textDocument);
  const position = as_record(record.position);

  if (
    text_document === undefined || !is_valid_uri(text_document.uri) ||
    position === undefined || !is_lsp_position(position)
  ) {
    return undefined;
  }

  const document = state.documents.get(text_document.uri);

  if (document === undefined) {
    return undefined;
  }

  let offset: number;

  try {
    offset = new PositionIndex(
      document.text,
      state.documents.position_encoding,
    ).offset_from_position(position);
  } catch (error) {
    if (error instanceof Error) {
      return undefined;
    }

    throw error;
  }

  return {
    uri: text_document.uri,
    document,
    index: document_binding_index(state.documents, text_document.uri),
    offset,
  };
}

function references_include_declaration(params: unknown): boolean {
  const record = as_record(params);

  if (record === undefined) {
    return false;
  }

  const context = as_record(record.context);

  if (context === undefined) {
    return false;
  }

  return context.includeDeclaration === true;
}

function completion_item_from_params(
  params: unknown,
): LspCompletionItem | undefined {
  const item = as_record(params);

  if (
    item === undefined || typeof item.label !== "string" ||
    typeof item.kind !== "number" || typeof item.detail !== "string" ||
    typeof item.sortText !== "string"
  ) {
    return undefined;
  }

  if (item.data !== undefined) {
    const data = as_record(item.data);

    if (
      data === undefined || typeof data.uri !== "string" ||
      typeof data.entity !== "string"
    ) {
      return undefined;
    }
  }

  return item as LspCompletionItem;
}

function lsp_diagnostics_from_context(
  context: Record<string, unknown> | undefined,
): LspDiagnostic[] {
  if (context === undefined || !Array.isArray(context.diagnostics)) {
    return [];
  }

  const diagnostics: LspDiagnostic[] = [];

  for (const value of context.diagnostics) {
    const diagnostic = as_record(value);

    if (
      diagnostic === undefined || !is_lsp_range(diagnostic.range) ||
      typeof diagnostic.severity !== "number" ||
      typeof diagnostic.source !== "string" ||
      typeof diagnostic.message !== "string"
    ) {
      continue;
    }

    if (
      diagnostic.code !== undefined && typeof diagnostic.code !== "string"
    ) {
      continue;
    }

    diagnostics.push(diagnostic as LspDiagnostic);
  }

  return diagnostics;
}

function code_action_from_params(params: unknown): LspCodeAction | undefined {
  const action = as_record(params);

  if (
    action === undefined || typeof action.title !== "string" ||
    !is_code_action_kind(action.kind)
  ) {
    return undefined;
  }

  const data = as_record(action.data);

  if (
    data === undefined || typeof data.uri !== "string" ||
    typeof data.version !== "number" || typeof data.title !== "string" ||
    !is_code_action_kind(data.kind) || typeof data.start !== "number" ||
    typeof data.end !== "number" || typeof data.replacement !== "string" ||
    typeof data.expected !== "string"
  ) {
    return undefined;
  }

  return action as LspCodeAction;
}

function execute_command_from_params(
  state: ServerState,
  params: unknown,
): ExecuteCommandRequest | undefined {
  const request = as_record(params);

  if (
    request === undefined || typeof request.command !== "string" ||
    !Array.isArray(request.arguments)
  ) {
    return undefined;
  }

  const uri = request.arguments[0];

  if (typeof uri !== "string") {
    return undefined;
  }

  const document = state.documents.get(uri);

  if (document === undefined) {
    return undefined;
  }

  const result: ExecuteCommandRequest = {
    command: request.command,
    uri,
    text: document.text,
    encoding: state.documents.position_encoding,
  };

  if (request.command === "duck.viewStage") {
    const stage = request.arguments[1];

    if (is_stage(stage)) {
      result.stage = stage;
    }
  }

  if (request.command === "duck.expandComptime") {
    const position = request.arguments[1];

    if (is_lsp_position(position)) {
      result.position = position;
    }
  }

  return result;
}

function is_stage(value: unknown): value is Stage {
  return value === "ic" || value === "expr" || value === "mod" ||
    value === "wat";
}

function is_code_action_kind(value: unknown): boolean {
  return value === "quickfix" || value === "refactor.rewrite" ||
    value === "refactor.extract" || value === "refactor.inline" ||
    value === "source.fixAll";
}

function completion_trigger_characters(): string[] {
  const characters = [".", '"', "_"];

  for (let code = 65; code <= 90; code += 1) {
    characters.push(String.fromCharCode(code));
  }

  for (let code = 97; code <= 122; code += 1) {
    characters.push(String.fromCharCode(code));
  }

  return characters;
}

function import_completion_paths(state: ServerState, uri: string): string[] {
  let document_url: URL;

  try {
    document_url = new URL(uri);
  } catch (error) {
    if (error instanceof TypeError) {
      return [];
    }

    throw error;
  }

  if (document_url.protocol !== "file:") {
    return [];
  }

  const directory = new URL(".", document_url);
  const paths = new Set<string>();

  try {
    for (const entry of Deno.readDirSync(directory)) {
      if (
        entry.isFile && entry.name.endsWith(".duck") &&
        new URL(encodeURIComponent(entry.name), directory).href !==
          document_url.href
      ) {
        paths.add("./" + entry.name);
      }
    }
  } catch (error) {
    if (
      !(error instanceof Deno.errors.NotFound) &&
      !(error instanceof Deno.errors.PermissionDenied)
    ) {
      throw error;
    }
  }

  for (const document of state.documents.open_documents()) {
    let candidate: URL;

    try {
      candidate = new URL(document.uri);
    } catch (error) {
      if (error instanceof TypeError) {
        continue;
      }

      throw error;
    }

    if (
      candidate.protocol !== "file:" || candidate.href === document_url.href ||
      new URL(".", candidate).href !== directory.href
    ) {
      continue;
    }

    const encoded_name = candidate.pathname.split("/").pop();

    if (encoded_name !== undefined && encoded_name.endsWith(".duck")) {
      paths.add("./" + decodeURIComponent(encoded_name));
    }
  }

  return [...paths].sort();
}

function workspace_roots_from_params(params: unknown): string[] {
  const record = as_record(params);

  if (record === undefined) {
    return [];
  }

  const roots = new Set<string>();

  if (Array.isArray(record.workspaceFolders)) {
    for (const candidate of record.workspaceFolders) {
      const folder = as_record(candidate);

      if (folder !== undefined && is_file_uri(folder.uri)) {
        roots.add(folder.uri);
      }
    }
  }

  if (is_file_uri(record.rootUri)) {
    roots.add(record.rootUri);
  }

  return [...roots].sort();
}

function workspace_index_entries(state: ServerState): WorkspaceIndexEntry[] {
  return workspace_analysis_entries(state);
}

function workspace_analysis_entries(state: ServerState) {
  return state.workspace.entries(state.documents.open_documents());
}

function is_file_uri(value: unknown): value is string {
  if (!is_valid_uri(value)) {
    return false;
  }

  return new URL(value).protocol === "file:";
}

function select_position_encoding(params: unknown): PositionEncoding {
  const initialize = as_record(params);

  if (initialize === undefined) {
    return "utf-16";
  }

  const capabilities = as_record(initialize.capabilities);

  if (capabilities === undefined) {
    return "utf-16";
  }

  const general = as_record(capabilities.general);

  if (general === undefined) {
    return "utf-16";
  }

  const encodings = general.positionEncodings;

  if (!Array.isArray(encodings)) {
    return "utf-16";
  }

  for (const encoding of encodings) {
    if (encoding === "utf-8") {
      return "utf-8";
    }

    if (encoding === "utf-16") {
      return "utf-16";
    }
  }

  return "utf-16";
}

function initialization_inlay_hint_settings(params: unknown): unknown {
  const initialize = as_record(params);

  if (initialize === undefined) {
    return undefined;
  }

  const options = as_record(initialize.initializationOptions);

  if (options === undefined) {
    return undefined;
  }

  return options.inlayHints;
}

function initialization_workspace_settings(params: unknown): unknown {
  const initialize = as_record(params);

  if (initialize === undefined) {
    return undefined;
  }

  const options = as_record(initialize.initializationOptions);

  if (options === undefined) {
    return undefined;
  }

  const duck = as_record(options.duck);

  if (duck !== undefined) {
    return duck;
  }

  return options;
}

function workspace_server_settings(params: unknown): unknown[] {
  const configuration = as_record(params);

  if (configuration === undefined) {
    return [];
  }

  const settings = as_record(configuration.settings);

  if (settings === undefined) {
    return [];
  }

  const result: unknown[] = [settings];
  const duck = as_record(settings.duck);

  if (duck !== undefined) {
    result.push(duck);
  }

  return result;
}

function apply_workspace_config(state: ServerState, settings: unknown): void {
  const record = as_record(settings);

  if (record === undefined) {
    return;
  }

  if (
    typeof record.diagnosticsDepth === "number" &&
    Number.isInteger(record.diagnosticsDepth) &&
    record.diagnosticsDepth >= 0
  ) {
    state.diagnostics_depth = record.diagnosticsDepth;
  }

  if (
    typeof record.maxReanalysisFanout === "number" &&
    Number.isInteger(record.maxReanalysisFanout) &&
    record.maxReanalysisFanout > 0
  ) {
    state.max_reanalysis_fanout = record.maxReanalysisFanout;
  }

  if (typeof record.formattingOnBrokenBuffer === "boolean") {
    state.format_broken_buffers = record.formattingOnBrokenBuffer;
  }
}

function workspace_inlay_hint_settings(params: unknown): unknown[] {
  const configuration = as_record(params);

  if (configuration === undefined) {
    return [];
  }

  const settings = as_record(configuration.settings);

  if (settings === undefined) {
    return [];
  }

  const inlay_hint_settings: unknown[] = [];

  if (settings.inlayHints !== undefined) {
    inlay_hint_settings.push(settings.inlayHints);
  }

  const duck = as_record(settings.duck);

  if (duck !== undefined && duck.inlayHints !== undefined) {
    inlay_hint_settings.push(duck.inlayHints);
  }

  return inlay_hint_settings;
}

function apply_inlay_hint_config(
  config: InlayHintConfig,
  settings: unknown,
): void {
  const record = as_record(settings);

  if (record === undefined) {
    return;
  }

  const categories: InlayHintCategory[] = [
    "types",
    "effects",
    "ownership",
    "comptime",
    "loops",
  ];

  for (const category of categories) {
    const value = record[category];

    if (typeof value === "boolean") {
      config[category] = value;
    }
  }
}

function uri_from_text_document(params: unknown): string | undefined {
  const record = as_record(params);

  if (record === undefined) {
    return undefined;
  }

  const text_document = as_record(record.textDocument);

  if (text_document === undefined || !is_valid_uri(text_document.uri)) {
    return undefined;
  }

  return text_document.uri;
}

function open_document_from_params(params: unknown):
  | { uri: string; version: number; text: string }
  | undefined {
  const record = as_record(params);

  if (record === undefined) {
    return undefined;
  }

  const text_document = as_record(record.textDocument);

  if (text_document === undefined || !is_valid_uri(text_document.uri)) {
    return undefined;
  }

  if (
    !is_valid_version(text_document.version) ||
    typeof text_document.text !== "string"
  ) {
    return undefined;
  }

  return {
    uri: text_document.uri,
    version: text_document.version,
    text: text_document.text,
  };
}

function change_from_params(params: unknown):
  | { uri: string; version: number; changes: TextDocumentChange[] }
  | undefined {
  const record = as_record(params);

  if (record === undefined) {
    return undefined;
  }

  const text_document = as_record(record.textDocument);

  if (text_document === undefined || !is_valid_uri(text_document.uri)) {
    return undefined;
  }

  if (
    !is_valid_version(text_document.version) ||
    !Array.isArray(record.contentChanges)
  ) {
    return undefined;
  }

  const changes: TextDocumentChange[] = [];

  for (const candidate of record.contentChanges) {
    const change = as_record(candidate);

    if (change === undefined || typeof change.text !== "string") {
      return undefined;
    }

    if (change.range === undefined) {
      if (change.rangeLength !== undefined) {
        return undefined;
      }

      changes.push({ text: change.text });
      continue;
    }

    if (!is_lsp_range(change.range)) {
      return undefined;
    }

    if (
      change.rangeLength !== undefined && !is_valid_length(change.rangeLength)
    ) {
      return undefined;
    }

    changes.push({
      text: change.text,
      range: change.range,
      rangeLength: change.rangeLength,
    });
  }

  if (changes.length === 0) {
    return undefined;
  }

  return { uri: text_document.uri, version: text_document.version, changes };
}

function is_lsp_range(value: unknown): value is LspRange {
  const range = as_record(value);

  if (range === undefined) {
    return false;
  }

  const start = as_record(range.start);
  const end = as_record(range.end);

  if (start === undefined || end === undefined) {
    return false;
  }

  return is_valid_length(start.line) && is_valid_length(start.character) &&
    is_valid_length(end.line) && is_valid_length(end.character);
}

function inlay_hint_from_params(value: unknown): LspInlayHint | undefined {
  const hint = as_record(value);

  if (hint === undefined || typeof hint.label !== "string") {
    return undefined;
  }

  const position = as_record(hint.position);
  const data = as_record(hint.data);

  if (
    position === undefined || !is_lsp_position(position) ||
    data === undefined || !is_valid_uri(data.uri) ||
    typeof data.detail !== "string" || !is_inlay_hint_category(data.category)
  ) {
    return undefined;
  }

  return value as LspInlayHint;
}

function is_inlay_hint_category(value: unknown): value is InlayHintCategory {
  return value === "types" || value === "effects" ||
    value === "ownership" || value === "comptime" || value === "loops";
}

function is_lsp_position(
  value: unknown,
): value is LspPosition {
  const position = as_record(value);

  if (position === undefined) {
    return false;
  }

  return is_valid_length(position.line) &&
    is_valid_length(position.character);
}

function is_valid_uri(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }

  try {
    const uri = new URL(value);
    return uri.protocol.length > 0;
  } catch (_error) {
    return false;
  }
}

function is_valid_version(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= -2_147_483_648 && value <= 2_147_483_647;
}

function is_valid_length(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function as_record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function initialization_progress_token(
  params: unknown,
): number | string | undefined {
  const initialize = as_record(params);

  if (initialize === undefined) {
    return undefined;
  }

  if (
    typeof initialize.workDoneToken === "number" ||
    typeof initialize.workDoneToken === "string"
  ) {
    return initialize.workDoneToken;
  }

  return undefined;
}

function progress_message(
  token: number | string,
  value: Record<string, unknown>,
): unknown {
  return {
    jsonrpc: "2.0",
    method: "$/progress",
    params: { token, value },
  };
}

function request_id(message: RpcMessage): number | string | null {
  if (message.id === undefined) {
    throw new Error("Request is missing an id");
  }

  return message.id;
}

function cancelled_response(message: RpcMessage): unknown {
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32800, message: "Request cancelled" },
  };
}

function respond(message: RpcMessage, result: unknown): unknown {
  return { jsonrpc: "2.0", id: message.id, result };
}

export async function run_lsp(): Promise<number> {
  const state = create_state();
  const decoder = new MessageDecoder();
  const writer = Deno.stdout.writable.getWriter();
  const reader = Deno.stdin.readable.getReader();
  let pending_read = reader.read();
  let request_chain = Promise.resolve();
  let write_chain = Promise.resolve();
  let background_error: unknown;

  const queue_writes = (messages: unknown[]): void => {
    write_chain = write_chain.then(async () => {
      for (const message of messages) {
        await writer.write(encode_message(message));
      }
    });
  };

  const queue_request = (message: RpcMessage): void => {
    request_chain = request_chain.then(async () => {
      const replies = await handle_deferred_request(state, message);
      queue_writes(replies);
    }).catch((error) => {
      background_error = error;
    });
  };

  while (true) {
    if (background_error !== undefined) {
      throw background_error;
    }

    const deadline = next_diagnostic_deadline(state);
    let outcome: ReadOutcome;

    if (deadline === undefined) {
      outcome = { tag: "read", result: await pending_read };
    } else {
      const delay = Math.max(0, deadline - state.now());
      const deadline_wait = wait_for_diagnostic_deadline(delay);
      outcome = await Promise.race([
        pending_read.then((result): ReadOutcome => ({ tag: "read", result })),
        deadline_wait.promise,
      ]);

      if (outcome.tag === "read") {
        deadline_wait.cancel();
      }
    }

    if (outcome.tag === "deadline") {
      const diagnostics = flush_due_diagnostics(state, state.now());
      queue_writes(diagnostics);
      continue;
    }

    if (outcome.result.done) {
      await request_chain;
      await write_chain;

      if (background_error !== undefined) {
        throw background_error;
      }

      return 0;
    }

    pending_read = reader.read();

    const decoded = decoder.push(outcome.result.value) as RpcMessage[];

    for (const message of decoded) {
      if (message.method === "$/cancelRequest") {
        handle_message(state, message);
      }
    }

    for (const message of decoded) {
      if (message.method === "$/cancelRequest") {
        continue;
      }

      if (
        message.id !== undefined && message.method !== "initialize"
      ) {
        queue_request(message);
      } else {
        queue_writes(handle_message(state, message));
      }

      if (state.exited) {
        await request_chain;
        await write_chain;

        if (state.shutdown_requested) {
          return 0;
        }

        return 1;
      }
    }
  }
}

async function handle_deferred_request(
  state: ServerState,
  message: RpcMessage,
): Promise<unknown[]> {
  await yield_to_event_loop();

  const snapshot = request_document_snapshot(state, message.params);
  const replies = handle_message(state, message);
  await yield_to_event_loop();

  if (state.cancelled_requests.delete(request_id(message))) {
    return [cancelled_response(message)];
  }

  if (snapshot !== undefined) {
    const current = state.documents.get(snapshot.uri);

    if (current === undefined || current.version !== snapshot.version) {
      return [{
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32801, message: "Document changed during request" },
      }];
    }
  }

  return replies;
}

function request_document_snapshot(
  state: ServerState,
  params: unknown,
): { uri: string; version: number } | undefined {
  const uri = uri_from_text_document(params);

  if (uri === undefined) {
    return undefined;
  }

  const document = state.documents.get(uri);

  if (document === undefined) {
    return undefined;
  }

  return { uri, version: document.version };
}

function yield_to_event_loop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type ReadOutcome =
  | { tag: "read"; result: ReadableStreamReadResult<Uint8Array<ArrayBuffer>> }
  | { tag: "deadline" };

function wait_for_diagnostic_deadline(delay: number): {
  promise: Promise<ReadOutcome>;
  cancel: () => void;
} {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<ReadOutcome>((resolve) => {
    timeout = setTimeout(() => resolve({ tag: "deadline" }), delay);
  });
  return {
    promise,
    cancel: () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    },
  };
}
