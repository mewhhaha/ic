export type DependencyViolation = {
  importer: string;
  imported: string;
  reason: string;
};

export type DependencyReport = {
  cycles: string[][];
  violations: DependencyViolation[];
};

type ModuleGraph = Map<string, Set<string>>;

const repository = new URL("../", import.meta.url);
const source_directory = new URL("src/", repository);
const baseline_url = new URL("dependency-baseline.json", import.meta.url);

if (import.meta.main) {
  const report = analyze_dependencies(source_directory);

  if (Deno.args.includes("--write-baseline")) {
    Deno.writeTextFileSync(
      baseline_url,
      JSON.stringify(report, undefined, 2) + "\n",
    );
    console.log(
      "Recorded " + report.cycles.length.toString() + " cycles and " +
        report.violations.length.toString() + " forbidden imports",
    );
    Deno.exit();
  }

  const baseline = read_baseline();
  const untracked = untracked_findings(report, baseline);

  console.log(JSON.stringify(report, undefined, 2));

  if (Deno.args.includes("--check") && has_findings(untracked)) {
    throw new Error(
      "Dependency boundaries have new findings: " +
        untracked.cycles.length.toString() + " cycles and " +
        untracked.violations.length.toString() + " forbidden imports",
    );
  }
}

export function analyze_dependencies(root: URL): DependencyReport {
  const graph = build_module_graph(root);
  const cycles = strongly_connected_components(graph).filter((component) =>
    component.length > 1
  );
  const violations = dependency_violations(graph);
  return { cycles, violations };
}

export function build_module_graph(root: URL): ModuleGraph {
  const files = collect_typescript_files(root);
  const known = new Set(files);
  const graph: ModuleGraph = new Map();

  for (const file of files) {
    const imports = new Set<string>();
    const source = Deno.readTextFileSync(new URL(file, repository));

    for (const specifier of import_specifiers(source)) {
      const resolved = resolve_import(file, specifier, known);

      if (resolved !== undefined) {
        imports.add(resolved);
      }
    }

    graph.set(file, imports);
  }

  return graph;
}

export function strongly_connected_components(graph: ModuleGraph): string[][] {
  let next_index = 0;
  const indexes = new Map<string, number>();
  const low_links = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const components: string[][] = [];

  function connect(module_path: string): void {
    indexes.set(module_path, next_index);
    low_links.set(module_path, next_index);
    next_index += 1;
    stack.push(module_path);
    stacked.add(module_path);

    const dependencies = graph.get(module_path);

    if (dependencies === undefined) {
      throw new Error("Missing dependency graph node " + module_path);
    }

    for (const dependency of [...dependencies].sort()) {
      if (!graph.has(dependency)) {
        continue;
      }

      if (!indexes.has(dependency)) {
        connect(dependency);
        const dependency_low_link = low_links.get(dependency);
        const module_low_link = low_links.get(module_path);

        if (
          dependency_low_link === undefined || module_low_link === undefined
        ) {
          throw new Error(
            "Missing dependency index for " + module_path + " -> " +
              dependency,
          );
        }

        low_links.set(
          module_path,
          Math.min(module_low_link, dependency_low_link),
        );
        continue;
      }

      if (stacked.has(dependency)) {
        const dependency_index = indexes.get(dependency);
        const module_low_link = low_links.get(module_path);

        if (dependency_index === undefined || module_low_link === undefined) {
          throw new Error(
            "Missing stacked dependency index for " + module_path + " -> " +
              dependency,
          );
        }

        low_links.set(
          module_path,
          Math.min(module_low_link, dependency_index),
        );
      }
    }

    if (low_links.get(module_path) !== indexes.get(module_path)) {
      return;
    }

    const component: string[] = [];

    while (true) {
      const dependency = stack.pop();

      if (dependency === undefined) {
        throw new Error(
          "Dependency component stack underflow at " + module_path,
        );
      }

      stacked.delete(dependency);
      component.push(dependency);

      if (dependency === module_path) {
        break;
      }
    }

    component.sort();
    components.push(component);
  }

  for (const module_path of [...graph.keys()].sort()) {
    if (!indexes.has(module_path)) {
      connect(module_path);
    }
  }

  return components.sort((left, right) => left[0].localeCompare(right[0]));
}

export function dependency_violations(
  graph: ModuleGraph,
): DependencyViolation[] {
  const violations: DependencyViolation[] = [];

  for (const [importer, dependencies] of graph) {
    for (const imported of dependencies) {
      const reason = forbidden_import_reason(importer, imported);

      if (reason !== undefined) {
        violations.push({ importer, imported, reason });
      }
    }
  }

  return violations.sort((left, right) => {
    const importer = left.importer.localeCompare(right.importer);

    if (importer !== 0) {
      return importer;
    }

    return left.imported.localeCompare(right.imported);
  });
}

function collect_typescript_files(directory: URL): string[] {
  const files: string[] = [];

  function collect(current: URL): void {
    for (
      const entry of [...Deno.readDirSync(current)].sort((left, right) =>
        left.name.localeCompare(right.name)
      )
    ) {
      const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), current);

      if (entry.isDirectory) {
        collect(url);
        continue;
      }

      if (!entry.isFile || !entry.name.endsWith(".ts")) {
        continue;
      }

      if (entry.name.endsWith(".test.ts")) {
        continue;
      }

      files.push(repository_relative_path(url));
    }
  }

  collect(directory);
  return files.sort();
}

function import_specifiers(source: string): string[] {
  const specifiers: string[] = [];
  const static_import =
    /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s*)?["']([^"']+)["']/g;
  const dynamic_import = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of source.matchAll(static_import)) {
    const specifier = match[1];

    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }

  for (const match of source.matchAll(dynamic_import)) {
    const specifier = match[1];

    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }

  return specifiers;
}

function resolve_import(
  importer: string,
  specifier: string,
  known: Set<string>,
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const importer_url = new URL(importer, repository);
  const resolved_url = new URL(specifier, importer_url);

  if (!resolved_url.href.startsWith(repository.href)) {
    return undefined;
  }

  const resolved = repository_relative_path(resolved_url);

  if (known.has(resolved)) {
    return resolved;
  }

  if (known.has(resolved + ".ts")) {
    return resolved + ".ts";
  }

  if (known.has(resolved + "/index.ts")) {
    return resolved + "/index.ts";
  }

  return undefined;
}

function forbidden_import_reason(
  importer: string,
  imported: string,
): string | undefined {
  if (
    importer.startsWith("src/frontend/") &&
    imported.startsWith("src/core/")
  ) {
    return "frontend stages cannot import semantic Core";
  }

  if (
    importer.startsWith("src/core/") &&
    imported.startsWith("src/frontend/") &&
    importer !== "src/core/from_source.ts" &&
    !importer.startsWith("src/core/from_source/")
  ) {
    return "semantic Core can depend on frontend syntax only through from_source adapters";
  }

  const importer_layer = core_layer(importer);
  const imported_layer = core_layer(imported);

  if (
    importer_layer !== undefined && imported_layer !== undefined &&
    imported_layer > importer_layer
  ) {
    return "semantic Core layers must flow model -> analysis -> plan -> emit";
  }

  return undefined;
}

function core_layer(path: string): number | undefined {
  const layers = ["model", "analysis", "plan", "emit"];

  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index];

    if (layer !== undefined && path.startsWith("src/core/" + layer + "/")) {
      return index;
    }
  }

  return undefined;
}

function repository_relative_path(url: URL): string {
  const repository_path = decodeURIComponent(repository.pathname);
  const path = decodeURIComponent(url.pathname);

  if (!path.startsWith(repository_path)) {
    throw new Error("Path is outside repository: " + path);
  }

  return path.slice(repository_path.length);
}

function read_baseline(): DependencyReport {
  try {
    return JSON.parse(Deno.readTextFileSync(baseline_url));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { cycles: [], violations: [] };
    }

    throw error;
  }
}

function untracked_findings(
  report: DependencyReport,
  baseline: DependencyReport,
): DependencyReport {
  const baseline_cycles = new Set(
    baseline.cycles.map((cycle) => cycle.join("\n")),
  );
  const baseline_violations = new Set(
    baseline.violations.map(violation_key),
  );
  return {
    cycles: report.cycles.filter((cycle) =>
      !baseline_cycles.has(cycle.join("\n"))
    ),
    violations: report.violations.filter((violation) =>
      !baseline_violations.has(violation_key(violation))
    ),
  };
}

function violation_key(violation: DependencyViolation): string {
  return violation.importer + "\n" + violation.imported + "\n" +
    violation.reason;
}

function has_findings(report: DependencyReport): boolean {
  return report.cycles.length > 0 || report.violations.length > 0;
}
