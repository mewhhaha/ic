import { expect } from "./expect.ts";
import type { ValType } from "./op.ts";
import { Emit, Format } from "./trait.ts";
import { indent, type Wat } from "./wat.ts";

export type Func = {
  name: string;
  params?: FuncParam[];
  result: ValType;
  body: Wat;
};

export function Func() {}

export type FuncParam = {
  name: string | undefined;
  type: ValType;
};

Func.fmt = function fmt(func: Func): Wat {
  let signature = `(func $${func.name}`;
  const params = func.params || [];

  for (const param of params) {
    if (param.name) {
      signature += ` (param $${param.name} ${param.type})`;
    } else {
      signature += ` (param ${param.type})`;
    }
  }

  signature += ` (result ${func.result})`;

  return signature + `\n${indent(func.body, 2)}\n)`;
};

Format.register<Func>(Func);

export type FuncType = {
  name: string;
  params: ValType[];
  result: ValType;
};

export function FuncType() {}

FuncType.fmt = function fmt(type: FuncType): Wat {
  let signature = `(type $${type.name} (func`;

  if (type.params.length > 0) {
    signature += " (param " + type.params.join(" ") + ")";
  }

  signature += ` (result ${type.result})))`;
  return signature;
};

Format.register<FuncType>(FuncType);

export type FuncImport = {
  name: string;
  module: string;
  field: string;
  params: ValType[];
  result: ValType;
};

export function FuncImport() {}

FuncImport.fmt = function fmt(func: FuncImport): Wat {
  let signature = `(func $${func.name}`;

  if (func.params.length > 0) {
    signature += " (param " + func.params.join(" ") + ")";
  }

  signature += ` (result ${func.result}))`;
  return `(import ${Deno.inspect(func.module)} ${
    Deno.inspect(func.field)
  } ${signature})`;
};

Format.register<FuncImport>(FuncImport);

export type Memory = {
  name: string;
  pages: number;
  export_name: string | undefined;
};

export function Memory() {}

Memory.fmt = function fmt(memory: Memory): Wat {
  expect(memory.pages > 0, "Memory pages must be positive");
  expect(
    Number.isInteger(memory.pages),
    "Memory pages must be an integer",
  );

  let wat = `(memory $${memory.name} ${memory.pages})`;

  if (memory.export_name !== undefined) {
    wat += `\n(export ${
      Deno.inspect(memory.export_name)
    } (memory $${memory.name}))`;
  }

  return wat;
};

Format.register<Memory>(Memory);

export type Global = {
  name: string;
  type: ValType;
  mutable: boolean;
  value: number | bigint;
};

export function Global() {}

Global.fmt = function fmt(global: Global): Wat {
  let type: string = global.type;

  if (global.mutable) {
    type = "(mut " + type + ")";
  }

  return `(global $${global.name} ${type} (${global.type}.const ${global.value.toString()}))`;
};

Format.register<Global>(Global);

export type Table = {
  name: string;
  elements: string[];
};

export function Table() {}

Table.fmt = function fmt(table: Table): Wat {
  const lines = [
    `(table $${table.name} ${table.elements.length.toString()} funcref)`,
  ];

  if (table.elements.length > 0) {
    lines.push(
      `(elem (i32.const 0) ${
        table.elements.map((name) => "$" + name).join(" ")
      })`,
    );
  }

  return lines.join("\n");
};

Format.register<Table>(Table);

export type DataSegment = {
  offset: number;
  bytes: number[];
};

export function DataSegment() {}

function wat_byte(byte: number): string {
  expect(Number.isInteger(byte), "Data segment byte must be an integer");
  expect(byte >= 0, "Data segment byte out of range: " + byte);
  expect(byte <= 255, "Data segment byte out of range: " + byte);

  const hex = byte.toString(16);

  if (hex.length === 1) {
    return "\\0" + hex;
  }

  return "\\" + hex;
}

function wat_bytes(bytes: number[]): string {
  const parts: string[] = [];

  for (const byte of bytes) {
    parts.push(wat_byte(byte));
  }

  return parts.join("");
}

DataSegment.fmt = function fmt(segment: DataSegment): Wat {
  expect(segment.offset >= 0, "Data segment offset must be non-negative");
  expect(
    Number.isInteger(segment.offset),
    "Data segment offset must be an integer",
  );

  return `(data (i32.const ${segment.offset}) "${wat_bytes(segment.bytes)}")`;
};

Format.register<DataSegment>(DataSegment);

export type Mod = {
  types?: Record<string, FuncType>;
  imports?: Record<string, FuncImport>;
  memory?: Memory;
  globals?: Record<string, Global>;
  table?: Table;
  data?: DataSegment[];
  funcs: Record<string, Func>;
  exports: string[];
};

export function Mod() {}

Mod.emit = function emit(mod: Mod): Wat {
  const parts = ["(module"];
  const types: FuncType[] = [];
  const imports: FuncImport[] = [];
  const globals: Global[] = [];
  const funcs: Func[] = [];

  if (mod.types) {
    for (const name in mod.types) {
      const type = mod.types[name];
      expect(type, "Missing function type: " + name);
      expect(type.name === name, "Function type key/name mismatch: " + name);
      types.push(type);
    }
  }

  if (mod.imports) {
    for (const name in mod.imports) {
      const func = mod.imports[name];
      expect(func, "Missing function import: " + name);
      expect(func.name === name, "Function import key/name mismatch: " + name);
      expect(!mod.funcs[name], "Duplicate function name: " + name);
      imports.push(func);
    }
  }

  if (mod.globals) {
    for (const name in mod.globals) {
      const global = mod.globals[name];
      expect(global, "Missing global: " + name);
      expect(global.name === name, "Global key/name mismatch: " + name);
      globals.push(global);
    }
  }

  for (const name in mod.funcs) {
    const func = mod.funcs[name];
    expect(func, "Missing function: " + name);
    expect(func.name === name, "Function key/name mismatch: " + name);
    funcs.push(func);
  }

  if (types.length > 0) {
    parts.push(indent(Format.all(FuncType, types).join("\n"), 2));
  }

  if (imports.length > 0) {
    parts.push(indent(Format.all(FuncImport, imports).join("\n"), 2));
  }

  if (mod.memory) {
    parts.push(indent(Format.fmt(Memory, mod.memory), 2));
  }

  if (globals.length > 0) {
    parts.push(indent(Format.all(Global, globals).join("\n"), 2));
  }

  if (mod.table) {
    for (const element of mod.table.elements) {
      expect(
        mod.funcs[element] || (mod.imports && mod.imports[element]),
        "Missing function for table element: " + element,
      );
    }

    parts.push(indent(Format.fmt(Table, mod.table), 2));
  }

  if (funcs.length > 0) {
    parts.push(indent(Format.all(Func, funcs).join("\n\n"), 2));
  }

  if (mod.data) {
    expect(mod.memory, "Data segments require memory");
    parts.push(indent(Format.all(DataSegment, mod.data).join("\n"), 2));
  }

  for (const name of mod.exports) {
    if (!mod.funcs[name]) {
      if (!mod.imports || !mod.imports[name]) {
        throw new Error("Missing function for export: " + name);
      }
    }

    parts.push(`  (export "${name}" (func $${name}))`);
  }

  parts.push(")");
  return parts.join("\n");
};

Emit.register<Mod, Wat>(Mod);
