import { build_binding_index, Source } from "../frontend.ts";
import type { BindingEntity, BindingIndex } from "../frontend/binding_index.ts";
import type { Source as FrontSource } from "../frontend/ast.ts";
import { document_content_hash, type TextDocument } from "./documents.ts";
import {
  definition_location,
  type LspLocation,
  type LspWorkspaceEdit,
  reference_locations,
  rename_symbol,
  type WorkspaceIndexEntry,
} from "./navigation.ts";
import { type PositionEncoding, PositionIndex } from "./position.ts";

export type WorkspaceLoadProgress = {
  uri: string;
  loaded: number;
  total: number;
};

export type WorkspaceAnalysisEntry = WorkspaceIndexEntry & {
  source: FrontSource;
  content_hash: string;
};

type CachedWorkspaceFile = WorkspaceAnalysisEntry & {
  disk_text: string;
};

type WorkspaceTarget = {
  entry: WorkspaceAnalysisEntry;
  entity: BindingEntity;
};

export class WorkspaceModel {
  readonly roots: string[];
  #files = new Map<string, CachedWorkspaceFile>();
  #dependencies = new Map<string, Set<string>>();
  #reverse_dependencies = new Map<string, Set<string>>();

  constructor(roots: string[]) {
    this.roots = discover_workspace_roots(roots);
  }

  load(
    overlays: readonly TextDocument[],
    progress?: (event: WorkspaceLoadProgress) => void,
  ): void {
    const uris = workspace_ix_files(this.roots);
    const overlay_by_uri = new Map(
      overlays.map((document) => [document.uri, document]),
    );
    const next = new Map<string, CachedWorkspaceFile>();

    for (let index = 0; index < uris.length; index += 1) {
      const uri = uris[index];

      if (uri === undefined) {
        throw new Error("Missing workspace file URI");
      }

      let text: string | undefined;
      const overlay = overlay_by_uri.get(uri);

      if (overlay !== undefined) {
        text = overlay.text;
      } else {
        text = read_workspace_file(uri);
      }

      if (text !== undefined) {
        const existing = this.#files.get(uri);
        const hash = document_content_hash(text);

        if (
          existing !== undefined && existing.content_hash === hash &&
          existing.text === text
        ) {
          next.set(uri, existing);
        } else {
          next.set(uri, analyze_workspace_file(uri, text));
        }
      }

      if (progress !== undefined) {
        progress({ uri, loaded: index + 1, total: uris.length });
      }
    }

    for (const overlay of overlays) {
      if (!next.has(overlay.uri)) {
        next.set(
          overlay.uri,
          analyze_workspace_file(overlay.uri, overlay.text),
        );
      }
    }

    this.#files = next;
    this.rebuild_graph();
  }

  refresh(uri: string, overlay: TextDocument | undefined): void {
    let text: string | undefined;

    if (overlay !== undefined) {
      text = overlay.text;
    } else {
      text = read_workspace_file(uri);
    }

    if (text === undefined) {
      this.#files.delete(uri);
    } else {
      const existing = this.#files.get(uri);
      const hash = document_content_hash(text);

      if (
        existing === undefined || existing.content_hash !== hash ||
        existing.text !== text
      ) {
        this.#files.set(uri, analyze_workspace_file(uri, text));
      }
    }

    this.rebuild_graph();
  }

  text(uri: string, overlays: readonly TextDocument[]): string | undefined {
    const overlay = overlays.find((document) => document.uri === uri);

    if (overlay !== undefined) {
      return overlay.text;
    }

    return this.#files.get(uri)?.text;
  }

  entries(overlays: readonly TextDocument[]): WorkspaceAnalysisEntry[] {
    const overlay_by_uri = new Map(
      overlays.map((document) => [document.uri, document]),
    );
    const entries: WorkspaceAnalysisEntry[] = [];

    for (const file of this.#files.values()) {
      const overlay = overlay_by_uri.get(file.uri);

      if (overlay === undefined || overlay.text === file.text) {
        entries.push(file);
      } else {
        entries.push(analyze_workspace_file(file.uri, overlay.text));
      }

      overlay_by_uri.delete(file.uri);
    }

    for (const overlay of overlay_by_uri.values()) {
      entries.push(analyze_workspace_file(overlay.uri, overlay.text));
    }

    entries.sort((left, right) => left.uri.localeCompare(right.uri));
    return entries;
  }

  affected_dependents(
    uri: string,
    max_depth: number,
    max_fanout: number,
  ): string[] {
    const affected: string[] = [];
    const visited = new Set<string>([uri]);
    const pending = [{ uri, depth: 0 }];

    while (pending.length > 0 && affected.length < max_fanout) {
      const next = pending.shift();

      if (next === undefined) {
        throw new Error("Missing workspace dependency traversal item");
      }

      if (next.depth >= max_depth) {
        continue;
      }

      const importers = this.#reverse_dependencies.get(next.uri);

      if (importers === undefined) {
        continue;
      }

      for (const importer of [...importers].sort()) {
        if (visited.has(importer)) {
          continue;
        }

        visited.add(importer);
        affected.push(importer);

        if (affected.length >= max_fanout) {
          break;
        }

        pending.push({ uri: importer, depth: next.depth + 1 });
      }
    }

    return affected;
  }

  dependency_count(): number {
    let count = 0;

    for (const dependencies of this.#dependencies.values()) {
      count += dependencies.size;
    }

    return count;
  }

  file_count(): number {
    return this.#files.size;
  }

  private rebuild_graph(): void {
    this.#dependencies.clear();
    this.#reverse_dependencies.clear();

    for (const file of this.#files.values()) {
      const dependencies = source_dependencies(file.source, file.uri);
      this.#dependencies.set(file.uri, dependencies);

      for (const dependency of dependencies) {
        let importers = this.#reverse_dependencies.get(dependency);

        if (importers === undefined) {
          importers = new Set();
          this.#reverse_dependencies.set(dependency, importers);
        }

        importers.add(file.uri);
      }
    }
  }
}

export function workspace_definition_location(
  entries: WorkspaceAnalysisEntry[],
  current_uri: string,
  offset: number,
  encoding: PositionEncoding,
): LspLocation | undefined {
  const target = workspace_target(entries, current_uri, offset);

  if (target === undefined) {
    return undefined;
  }

  const definition = target.entity.definition;

  if (definition === undefined) {
    return undefined;
  }

  const occurrence = target.entry.index.occurrences.get(definition);

  if (occurrence === undefined) {
    throw new Error("Missing workspace target definition occurrence");
  }

  return definition_location(
    target.entry.index,
    target.entry.text,
    target.entry.uri,
    occurrence.span.start,
    encoding,
  );
}

export function workspace_reference_locations(
  entries: WorkspaceAnalysisEntry[],
  current_uri: string,
  offset: number,
  include_declaration: boolean,
  encoding: PositionEncoding,
): LspLocation[] {
  const target = workspace_target(entries, current_uri, offset);

  if (target === undefined) {
    return [];
  }

  const locations: LspLocation[] = [];
  const definition = target.entity.definition;

  if (definition !== undefined) {
    const occurrence = target.entry.index.occurrences.get(definition);

    if (occurrence === undefined) {
      throw new Error("Missing workspace reference target definition");
    }

    locations.push(...reference_locations(
      target.entry.index,
      target.entry.text,
      target.entry.uri,
      occurrence.span.start,
      include_declaration,
      encoding,
    ));
  }

  for (const entry of entries) {
    for (
      const occurrence of imported_member_occurrences(
        entry,
        target.entry.uri,
        target.entity.name,
      )
    ) {
      locations.push({
        uri: entry.uri,
        range: range_from_offsets(
          new PositionIndex(entry.text, encoding),
          occurrence.start,
          occurrence.end,
        ),
      });
    }
  }

  return unique_locations(locations);
}

export function workspace_rename_symbol(
  entries: WorkspaceAnalysisEntry[],
  current_uri: string,
  offset: number,
  new_name: string,
  encoding: PositionEncoding,
): LspWorkspaceEdit | undefined {
  const target = workspace_target(entries, current_uri, offset);

  if (target === undefined || target.entity.definition === undefined) {
    return undefined;
  }

  const definition = target.entry.index.occurrences.get(
    target.entity.definition,
  );

  if (definition === undefined) {
    throw new Error("Missing workspace rename target definition");
  }

  const local = rename_symbol(
    target.entry.index,
    target.entry.text,
    target.entry.uri,
    definition.span.start,
    new_name,
    encoding,
  );

  if (local === undefined) {
    return undefined;
  }

  const changes = { ...local.changes };

  for (const entry of entries) {
    const imported = imported_member_occurrences(
      entry,
      target.entry.uri,
      target.entity.name,
    );

    if (imported.length === 0) {
      continue;
    }

    const positions = new PositionIndex(entry.text, encoding);
    let edits = changes[entry.uri];

    if (edits === undefined) {
      edits = [];
      changes[entry.uri] = edits;
    }

    for (const occurrence of imported) {
      edits.push({
        range: range_from_offsets(
          positions,
          occurrence.start,
          occurrence.end,
        ),
        newText: new_name,
      });
    }
  }

  return { changes };
}

export function discover_workspace_roots(candidates: string[]): string[] {
  const roots = new Set<string>();

  for (const candidate of candidates) {
    const discovered = discover_workspace_root(candidate);

    if (discovered !== undefined) {
      roots.add(discovered);
    }
  }

  return [...roots].sort();
}

function discover_workspace_root(candidate: string): string | undefined {
  let url: URL;

  try {
    url = new URL(candidate);
  } catch (error) {
    if (error instanceof TypeError) {
      return undefined;
    }

    throw error;
  }

  if (url.protocol !== "file:") {
    return undefined;
  }

  try {
    const stat = Deno.statSync(url);

    if (stat.isFile) {
      url = new URL(".", url);
    }
  } catch (error) {
    if (
      !(error instanceof Deno.errors.NotFound) &&
      !(error instanceof Deno.errors.PermissionDenied)
    ) {
      throw error;
    }
  }

  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }

  const fallback = url.href;

  while (true) {
    if (workspace_marker_exists(url)) {
      return url.href;
    }

    const parent = new URL("..", url);

    if (parent.href === url.href) {
      return fallback;
    }

    url = parent;
  }
}

function workspace_marker_exists(directory: URL): boolean {
  for (const marker of ["AGENTS.md", ".git"]) {
    try {
      Deno.statSync(new URL(marker, directory));
      return true;
    } catch (error) {
      if (
        error instanceof Deno.errors.NotFound ||
        error instanceof Deno.errors.PermissionDenied
      ) {
        continue;
      }

      throw error;
    }
  }

  return false;
}

function workspace_ix_files(roots: string[]): string[] {
  const files = new Set<string>();

  for (const root of roots) {
    let url: URL;

    try {
      url = new URL(root);
    } catch (error) {
      if (error instanceof TypeError) {
        continue;
      }

      throw error;
    }

    collect_workspace_files(url, files);
  }

  return [...files].sort();
}

function collect_workspace_files(url: URL, files: Set<string>): void {
  let stat: Deno.FileInfo;

  try {
    stat = Deno.statSync(url);
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.PermissionDenied
    ) {
      return;
    }

    throw error;
  }

  if (stat.isFile) {
    if (url.pathname.endsWith(".ix")) {
      files.add(url.href);
    }

    return;
  }

  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }

  let entries: Deno.DirEntry[];

  try {
    entries = [...Deno.readDirSync(url)].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.PermissionDenied
    ) {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    if (entry.isSymlink || ignored_directory(entry.name)) {
      continue;
    }

    const child = new URL(encodeURIComponent(entry.name), url);

    if (entry.isDirectory) {
      child.pathname += "/";
      collect_workspace_files(child, files);
    } else if (entry.isFile && entry.name.endsWith(".ix")) {
      files.add(child.href);
    }
  }
}

function ignored_directory(name: string): boolean {
  return name === ".git" || name === ".claude" || name === ".codex" ||
    name === "node_modules" || name === "target" || name === "vendor" ||
    name === ".deno";
}

function read_workspace_file(uri: string): string | undefined {
  let url: URL;

  try {
    url = new URL(uri);
  } catch (error) {
    if (error instanceof TypeError) {
      return undefined;
    }

    throw error;
  }

  if (url.protocol !== "file:") {
    return undefined;
  }

  try {
    return Deno.readTextFileSync(url);
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.PermissionDenied
    ) {
      return undefined;
    }

    throw error;
  }
}

function analyze_workspace_file(
  uri: string,
  text: string,
): CachedWorkspaceFile {
  const parsed = Source.parse_with_diagnostics(text);
  return {
    uri,
    text,
    disk_text: text,
    source: parsed.source,
    index: build_binding_index(parsed, 0),
    content_hash: document_content_hash(text),
  };
}

function source_dependencies(source: FrontSource, uri: string): Set<string> {
  const dependencies = new Set<string>();
  const seen = new WeakSet<object>();

  const visit = (value: object): void => {
    if (seen.has(value)) {
      return;
    }

    seen.add(value);
    const record = value as { tag?: string; path?: unknown };

    if (record.tag === "import" && typeof record.path === "string") {
      try {
        dependencies.add(new URL(record.path, uri).href);
      } catch (error) {
        if (!(error instanceof TypeError)) {
          throw error;
        }
      }
    }

    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object") {
        if (Array.isArray(child)) {
          for (const entry of child) {
            if (entry !== null && typeof entry === "object") {
              visit(entry);
            }
          }
        } else {
          visit(child);
        }
      }
    }
  };

  visit(source);

  return dependencies;
}

function workspace_target(
  entries: WorkspaceAnalysisEntry[],
  current_uri: string,
  offset: number,
): WorkspaceTarget | undefined {
  const current = entries.find((entry) => entry.uri === current_uri);

  if (current === undefined) {
    return undefined;
  }

  const occurrence = current.index.occurrence_at(offset);

  if (occurrence === undefined) {
    return undefined;
  }

  if (occurrence.entity !== undefined) {
    const entity = current.index.entities.get(occurrence.entity);

    if (
      entity !== undefined && entity.scope === "scope:0" &&
      entity.owner === undefined && entity.kind !== "module_parameter"
    ) {
      return { entry: current, entity };
    }
  }

  const imported = imported_member_at(current, occurrence.span.start);

  if (imported === undefined) {
    return undefined;
  }

  let target_uri: string;

  try {
    target_uri = new URL(imported.path, current.uri).href;
  } catch (error) {
    if (error instanceof TypeError) {
      return undefined;
    }

    throw error;
  }

  const target_entry = entries.find((entry) => entry.uri === target_uri);

  if (target_entry === undefined) {
    return undefined;
  }

  const entity = root_entity_named(target_entry.index, occurrence.name);

  if (entity === undefined) {
    return undefined;
  }

  return { entry: target_entry, entity };
}

function root_entity_named(
  index: BindingIndex,
  name: string,
): BindingEntity | undefined {
  let result: BindingEntity | undefined;

  for (const entity of index.entities.values()) {
    if (
      entity.name !== name || entity.scope !== "scope:0" ||
      entity.owner !== undefined || entity.definition === undefined
    ) {
      continue;
    }

    if (result === undefined || result.generation < entity.generation) {
      result = entity;
    }
  }

  return result;
}

function imported_member_at(
  entry: WorkspaceAnalysisEntry,
  member_start: number,
): { alias: string; path: string } | undefined {
  const prefix_start = Math.max(0, member_start - 128);
  const prefix = entry.text.slice(prefix_start, member_start);
  const match = prefix.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/);

  if (match === null || match[1] === undefined) {
    return undefined;
  }

  const alias = match[1];
  const statement = entry.source.statements.find((candidate) =>
    candidate.tag === "bind" && candidate.name === alias &&
    candidate.value.tag === "import"
  );

  if (
    statement === undefined || statement.tag !== "bind" ||
    statement.value.tag !== "import"
  ) {
    return undefined;
  }

  return { alias, path: statement.value.path };
}

function imported_member_occurrences(
  entry: WorkspaceAnalysisEntry,
  target_uri: string,
  member_name: string,
): { start: number; end: number }[] {
  const result: { start: number; end: number }[] = [];

  for (const occurrence of entry.index.occurrences.values()) {
    if (occurrence.name !== member_name) {
      continue;
    }

    const imported = imported_member_at(entry, occurrence.span.start);

    if (imported === undefined) {
      continue;
    }

    let uri: string;

    try {
      uri = new URL(imported.path, entry.uri).href;
    } catch (error) {
      if (error instanceof TypeError) {
        continue;
      }

      throw error;
    }

    if (uri === target_uri) {
      result.push(occurrence.span);
    }
  }

  return result;
}

function unique_locations(locations: LspLocation[]): LspLocation[] {
  const seen = new Set<string>();
  const result: LspLocation[] = [];

  locations.sort((left, right) => {
    const by_uri = left.uri.localeCompare(right.uri);

    if (by_uri !== 0) {
      return by_uri;
    }

    if (left.range.start.line !== right.range.start.line) {
      return left.range.start.line - right.range.start.line;
    }

    return left.range.start.character - right.range.start.character;
  });

  for (const location of locations) {
    const key = JSON.stringify(location);

    if (!seen.has(key)) {
      seen.add(key);
      result.push(location);
    }
  }

  return result;
}

function range_from_offsets(
  positions: PositionIndex,
  start: number,
  end: number,
) {
  return {
    start: positions.position_from_offset(start),
    end: positions.position_from_offset(end),
  };
}
