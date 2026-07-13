import { expect } from "../expect.ts";
import type {
  FrontExpr,
  Param,
  Source,
  Stmt,
  TypeExpr,
  TypeField,
} from "./ast.ts";
import { parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";

const fnv_offset = 0x811c9dc5;
const fnv_prime = 0x01000193;

export function atom_i32(name: string): number {
  expect(
    /^[a-z_][a-z0-9_]*$/.test(name),
    "Atom must use snake_case: " + name,
  );
  let hash = fnv_offset;

  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, fnv_prime) >>> 0;
  }

  return hash | 0;
}

export function validate_atom_identities(source: Source): void {
  const by_id = new Map<number, string>();

  function record(name: string): void {
    const id = atom_i32(name);
    const previous = by_id.get(id);

    if (previous && previous !== name) {
      throw new Error(
        "Atom identity collision between #" + previous + " and #" + name,
      );
    }

    by_id.set(id, name);
  }

  function visit_type_expr(type: TypeExpr): void {
    switch (type.tag) {
      case "atom":
        record(type.name);
        return;

      case "name":
      case "top":
      case "never":
        return;

      case "frozen":
      case "borrow":
        visit_type_expr(type.value);
        return;

      case "union":
      case "intersection":
      case "difference":
        visit_type_expr(type.left);
        visit_type_expr(type.right);
        return;

      case "apply":
        visit_type_expr(type.func);
        visit_type_expr(type.arg);
        return;

      case "tuple":
        for (const item of type.items) {
          visit_type_expr(item);
        }
        return;

      case "arrow":
        visit_type_expr(type.param);
        visit_type_expr(type.result);
        return;
    }
  }

  function visit_type_text(text: string | undefined): void {
    if (!text || !text.includes("#")) {
      return;
    }

    visit_type_expr(parse_type_expr(tokenize(text)));
  }

  function visit_params(params: Param[]): void {
    for (const param of params) {
      if (param.type_annotation) {
        visit_type_expr(param.type_annotation);
      } else {
        visit_type_text(param.annotation);
      }
    }
  }

  function visit_type_fields(fields: TypeField[]): void {
    for (const field of fields) {
      if (field.set_member) {
        visit_type_expr(field.set_member);
      }
      visit_type_text(field.type_name);
    }
  }

  function visit_expr(expr: FrontExpr): void {
    switch (expr.tag) {
      case "atom":
        record(expr.name);
        return;

      case "bool":
      case "num":
      case "unit":
      case "text":
      case "type_name":
      case "var":
      case "linear":
      case "unsupported":
        return;

      case "set_type":
        visit_type_expr(expr.type_expr);
        return;

      case "struct_type":
        visit_type_fields(expr.fields);
        return;

      case "union_type":
        visit_type_fields(expr.cases);
        return;

      case "prim":
        visit_expr(expr.left);
        visit_expr(expr.right);
        return;

      case "lam":
      case "rec":
        visit_params(expr.params);
        visit_expr(expr.body);
        return;

      case "app":
        visit_expr(expr.func);

        for (const arg of expr.args) {
          visit_expr(arg);
        }
        return;

      case "block":
        visit_stmts(expr.statements);
        return;

      case "comptime":
        visit_expr(expr.expr);
        return;

      case "borrow":
      case "freeze":
        visit_expr(expr.value);
        return;

      case "scratch":
        visit_expr(expr.body);
        return;

      case "loop":
        visit_stmts(expr.body);
        return;

      case "captured":
        visit_expr(expr.expr);
        return;

      case "handler":
        for (const state of expr.state) {
          visit_expr(state.value);
        }

        for (const clause of expr.clauses) {
          visit_params(clause.params);
          visit_expr(clause.body);
        }
        visit_params([expr.return_clause.param]);
        visit_expr(expr.return_clause.body);
        return;

      case "try_with":
        visit_expr(expr.body);
        visit_expr(expr.handler);
        return;

      case "with":
      case "struct_update":
        visit_expr(expr.base);

        for (const field of expr.fields) {
          visit_expr(field.value);
        }
        return;

      case "struct_value":
        visit_expr(expr.type_expr);

        for (const field of expr.fields) {
          visit_expr(field.value);
        }
        return;

      case "if":
        visit_expr(expr.cond);
        visit_expr(expr.then_branch);
        visit_expr(expr.else_branch);
        return;

      case "if_let":
        visit_expr(expr.target);
        visit_expr(expr.then_branch);
        visit_expr(expr.else_branch);
        return;

      case "field":
        visit_expr(expr.object);
        return;

      case "index":
        visit_expr(expr.object);
        visit_expr(expr.index);
        return;

      case "is":
        visit_expr(expr.value);
        visit_type_expr(expr.type_expr);
        return;

      case "union_case":
        if (expr.value) {
          visit_expr(expr.value);
        }

        if (expr.type_expr) {
          visit_expr(expr.type_expr);
        }
        return;
    }
  }

  function visit_stmts(statements: Stmt[]): void {
    for (const stmt of statements) {
      switch (stmt.tag) {
        case "import":
        case "host_import":
        case "continue":
        case "unsupported":
          break;

        case "bind":
          if (stmt.type_annotation) {
            visit_type_expr(stmt.type_annotation);
          } else {
            visit_type_text(stmt.annotation);
          }
          visit_expr(stmt.value);
          break;

        case "state_bind":
        case "resume_dup":
        case "assign":
          visit_expr(stmt.value);
          break;

        case "bind_pattern":
          visit_expr(stmt.value);
          break;

        case "index_assign":
          visit_expr(stmt.index);
          visit_expr(stmt.value);
          break;

        case "for_range":
          visit_expr(stmt.start);
          visit_expr(stmt.end);
          visit_expr(stmt.step);
          visit_stmts(stmt.body);
          break;

        case "for_collection":
          visit_expr(stmt.collection);
          visit_stmts(stmt.body);
          break;

        case "if_stmt":
          visit_expr(stmt.cond);
          visit_stmts(stmt.body);
          break;

        case "if_let_stmt":
          visit_expr(stmt.target);
          visit_stmts(stmt.body);
          break;

        case "type_check":
          visit_type_fields(stmt.pattern.fields);
          visit_expr(stmt.target);
          break;

        case "break":
          if (stmt.value) {
            visit_expr(stmt.value);
          }
          break;

        case "return":
          visit_expr(stmt.value);
          break;

        case "expr":
          visit_expr(stmt.expr);
          break;
      }
    }
  }

  if (source.module) {
    visit_params(source.module.params);
  }

  for (const declaration of source.declarations || []) {
    if (declaration.tag === "record") {
      visit_type_fields(declaration.fields);
      continue;
    }

    if (declaration.tag === "type") {
      if (declaration.body.tag === "product") {
        visit_type_fields(declaration.body.fields);
      } else if (declaration.body.tag === "sum") {
        visit_type_fields(declaration.body.cases);
      } else {
        visit_type_text(declaration.body.type_name);
      }
      continue;
    }

    for (const operation of declaration.operations) {
      for (const param of operation.params) {
        visit_type_text(param.type_name);
      }
      visit_type_text(operation.result.type_name);
    }
  }

  visit_stmts(source.statements);
}
