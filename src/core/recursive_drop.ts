import { expect } from "../expect.ts";
import type { Func } from "../mod.ts";
import type { Core, CoreExpr } from "./ast.ts";
import {
  runtime_aggregate_layout_for_type,
  type RuntimeAggregateField,
} from "./runtime_aggregate.ts";
import {
  runtime_union_payload,
  type RuntimeUnionPayload,
  type RuntimeUnionPayloadField,
} from "./runtime_union_payload.ts";
import { runtime_union_type_layout } from "./runtime_union/size.ts";
import { static_type_value, type TypeStaticCtx } from "./type_static.ts";

type RecursiveDropOperation =
  | { tag: "free"; offset: number }
  | { tag: "drop"; offset: number; target: string };

type RecursiveDropCase = {
  tag_value: number;
  operations: RecursiveDropOperation[];
};

type RecursiveDropNode = {
  key: string;
  name: string;
  dependencies: Set<string>;
  unsupported: boolean;
  operations?: RecursiveDropOperation[];
  cases?: RecursiveDropCase[];
};

export function core_recursive_drop_functions(
  core: Core,
  ctx: TypeStaticCtx,
): Func[] {
  const rows = core.cleanup_emission || [];
  const nodes = new Map<string, RecursiveDropNode>();
  const roots: { row: (typeof rows)[number]; node: RecursiveDropNode }[] = [];

  for (const row of rows) {
    if (row.destructor_type_expr === undefined) {
      continue;
    }
    const type_value = static_type_value(row.destructor_type_expr, ctx);

    if (
      type_value === undefined ||
      (type_value.tag !== "struct_type" && type_value.tag !== "union_type")
    ) {
      continue;
    }

    const node = build_recursive_drop_node(
      row.destructor_type_expr,
      ctx,
      nodes,
    );
    roots.push({ row, node });
  }

  const selected = new Set<string>();
  for (const root of roots) {
    if (recursive_drop_graph_is_unsupported(root.node.key, nodes, new Set())) {
      continue;
    }
    if (!recursive_drop_graph_has_cycle(root.node.key, nodes)) {
      continue;
    }

    root.row.destructor = root.node.name;
    collect_recursive_drop_dependencies(root.node.key, nodes, selected);
  }

  const funcs: Func[] = [];
  for (const node of nodes.values()) {
    if (!selected.has(node.key)) {
      continue;
    }
    funcs.push({
      name: node.name,
      params: [{ name: "ptr", type: "i32" }],
      result: "i32",
      body: emit_recursive_drop_node(node, nodes),
    });
  }
  return funcs;
}

function build_recursive_drop_node(
  type_expr: CoreExpr,
  ctx: TypeStaticCtx,
  nodes: Map<string, RecursiveDropNode>,
): RecursiveDropNode {
  const type_value = static_type_value(type_expr, ctx);
  expect(
    type_value &&
      (type_value.tag === "struct_type" || type_value.tag === "union_type"),
    "Recursive destructor requires a struct or union type",
  );
  const key = type_value.tag + ":" + JSON.stringify(type_value);
  const existing = nodes.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const node: RecursiveDropNode = {
    key,
    name: "__drop_type_" + nodes.size.toString(),
    dependencies: new Set(),
    unsupported: false,
  };
  nodes.set(key, node);

  if (type_value.tag === "struct_type") {
    const layout = runtime_aggregate_layout_for_type(type_expr, ctx);
    node.operations = runtime_aggregate_drop_operations(
      layout.fields,
      ctx,
      nodes,
      node,
    );
    return node;
  }

  const layout = runtime_union_type_layout(type_value, ctx);
  node.cases = type_value.cases.map((union_case, tag_value) => {
    const payload = runtime_union_payload(union_case.type_name, ctx);
    return {
      tag_value,
      operations: runtime_union_payload_drop_operations(
        payload,
        layout.payload_offset,
        ctx,
        nodes,
        node,
      ),
    };
  });
  return node;
}

function runtime_aggregate_drop_operations(
  fields: RuntimeAggregateField[],
  ctx: TypeStaticCtx,
  nodes: Map<string, RecursiveDropNode>,
  owner: RecursiveDropNode,
): RecursiveDropOperation[] {
  const operations: RecursiveDropOperation[] = [];
  for (const field of fields) {
    if (field.tag === "unit") {
      continue;
    }
    if (field.tag === "struct") {
      operations.push(
        ...runtime_aggregate_drop_operations(field.fields, ctx, nodes, owner),
      );
      continue;
    }
    if (field.resume) {
      owner.unsupported = true;
      continue;
    }
    if (field.text) {
      operations.push({ tag: "free", offset: field.offset });
      continue;
    }
    if (field.union_type_expr !== undefined) {
      operations.push(drop_operation(
        field.offset,
        field.union_type_expr,
        ctx,
        nodes,
        owner,
      ));
    }
  }
  return operations;
}

function runtime_union_payload_drop_operations(
  payload: RuntimeUnionPayload,
  payload_offset: number,
  ctx: TypeStaticCtx,
  nodes: Map<string, RecursiveDropNode>,
  owner: RecursiveDropNode,
): RecursiveDropOperation[] {
  if (payload.tag === "none") {
    return [];
  }
  if (payload.tag === "aggregate") {
    return [drop_operation(
      payload_offset,
      payload.type_expr,
      ctx,
      nodes,
      owner,
    )];
  }
  if (payload.tag === "struct") {
    return runtime_union_struct_drop_operations(
      payload.fields,
      ctx,
      nodes,
      owner,
    );
  }
  if (payload.resume) {
    owner.unsupported = true;
    return [];
  }
  if (payload.text) {
    return [{ tag: "free", offset: payload_offset }];
  }
  if (payload.union_type_expr !== undefined) {
    return [drop_operation(
      payload_offset,
      payload.union_type_expr,
      ctx,
      nodes,
      owner,
    )];
  }
  return [];
}

function runtime_union_struct_drop_operations(
  fields: RuntimeUnionPayloadField[],
  ctx: TypeStaticCtx,
  nodes: Map<string, RecursiveDropNode>,
  owner: RecursiveDropNode,
): RecursiveDropOperation[] {
  const operations: RecursiveDropOperation[] = [];
  for (const field of fields) {
    if (field.tag === "struct") {
      operations.push(
        ...runtime_union_struct_drop_operations(
          field.fields,
          ctx,
          nodes,
          owner,
        ),
      );
      continue;
    }
    if (field.resume) {
      owner.unsupported = true;
      continue;
    }
    if (field.text) {
      operations.push({ tag: "free", offset: field.offset });
      continue;
    }
    if (field.union_type_expr !== undefined) {
      operations.push(drop_operation(
        field.offset,
        field.union_type_expr,
        ctx,
        nodes,
        owner,
      ));
    }
  }
  return operations;
}

function drop_operation(
  offset: number,
  type_expr: CoreExpr,
  ctx: TypeStaticCtx,
  nodes: Map<string, RecursiveDropNode>,
  owner: RecursiveDropNode,
): RecursiveDropOperation {
  const target = build_recursive_drop_node(type_expr, ctx, nodes);
  owner.dependencies.add(target.key);
  return { tag: "drop", offset, target: target.key };
}

function recursive_drop_graph_is_unsupported(
  key: string,
  nodes: Map<string, RecursiveDropNode>,
  visited: Set<string>,
): boolean {
  if (visited.has(key)) {
    return false;
  }
  visited.add(key);
  const node = nodes.get(key);
  expect(node, "Missing recursive destructor node: " + key);
  if (node.unsupported) {
    return true;
  }
  for (const dependency of node.dependencies) {
    if (recursive_drop_graph_is_unsupported(dependency, nodes, visited)) {
      return true;
    }
  }
  return false;
}

function recursive_drop_graph_has_cycle(
  root: string,
  nodes: Map<string, RecursiveDropNode>,
): boolean {
  return recursive_drop_node_has_cycle(root, nodes, new Set(), new Set());
}

function recursive_drop_node_has_cycle(
  key: string,
  nodes: Map<string, RecursiveDropNode>,
  visiting: Set<string>,
  visited: Set<string>,
): boolean {
  if (visiting.has(key)) {
    return true;
  }
  if (visited.has(key)) {
    return false;
  }
  visiting.add(key);
  const node = nodes.get(key);
  expect(node, "Missing recursive destructor node: " + key);
  for (const dependency of node.dependencies) {
    if (recursive_drop_node_has_cycle(dependency, nodes, visiting, visited)) {
      return true;
    }
  }
  visiting.delete(key);
  visited.add(key);
  return false;
}

function collect_recursive_drop_dependencies(
  key: string,
  nodes: Map<string, RecursiveDropNode>,
  selected: Set<string>,
): void {
  if (selected.has(key)) {
    return;
  }
  selected.add(key);
  const node = nodes.get(key);
  expect(node, "Missing recursive destructor node: " + key);
  for (const dependency of node.dependencies) {
    collect_recursive_drop_dependencies(dependency, nodes, selected);
  }
}

function emit_recursive_drop_node(
  node: RecursiveDropNode,
  nodes: Map<string, RecursiveDropNode>,
): string {
  const lines = [
    "local.get $ptr",
    "i32.eqz",
    "if",
    "  i32.const 0",
    "  return",
    "end",
  ];

  if (node.cases !== undefined) {
    for (const union_case of node.cases) {
      if (union_case.operations.length === 0) {
        continue;
      }
      lines.push("local.get $ptr");
      lines.push("i32.load");
      lines.push("i32.const " + union_case.tag_value.toString());
      lines.push("i32.eq");
      lines.push("if");
      emit_recursive_drop_operations(
        lines,
        union_case.operations,
        nodes,
        "  ",
      );
      lines.push("end");
    }
  }

  if (node.operations !== undefined) {
    emit_recursive_drop_operations(lines, node.operations, nodes, "");
  }
  lines.push("local.get $ptr");
  lines.push("call $__free");
  return lines.join("\n");
}

function emit_recursive_drop_operations(
  lines: string[],
  operations: RecursiveDropOperation[],
  nodes: Map<string, RecursiveDropNode>,
  indent: string,
): void {
  for (const operation of operations) {
    lines.push(indent + "local.get $ptr");
    lines.push(indent + "i32.load offset=" + operation.offset.toString());
    if (operation.tag === "free") {
      lines.push(indent + "call $__free");
    } else {
      const target = nodes.get(operation.target);
      expect(
        target,
        "Missing recursive destructor target: " + operation.target,
      );
      lines.push(indent + "call $" + target.name);
    }
    lines.push(indent + "drop");
  }
}
