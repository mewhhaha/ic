import type { ValType } from "../../op.ts";
import type { CoreExpr } from "../ast.ts";

export type RuntimeUnionPayload =
  | { tag: "none" }
  | {
    tag: "value";
    type: ValType;
    text: boolean;
    resume: boolean;
    union_type_expr?: CoreExpr;
  }
  | {
    tag: "aggregate";
    type_expr: CoreExpr;
  }
  | {
    tag: "struct";
    type_expr: CoreExpr;
    fields: RuntimeUnionPayloadField[];
  };

export type RuntimeUnionPayloadField =
  | {
    tag: "value";
    name: string;
    offset: number;
    type: ValType;
    text: boolean;
    resume: boolean;
    union_type_expr?: CoreExpr;
  }
  | {
    tag: "struct";
    name: string;
    type_expr: CoreExpr;
    fields: RuntimeUnionPayloadField[];
  };

export type RuntimeUnionInfo = {
  tag_value: number;
  size: number;
  align: 8 | 16;
  payload_offset: number;
  payload: RuntimeUnionPayload;
};

export type RuntimeUnionTarget = {
  target: CoreExpr;
  type_expr: CoreExpr;
  type_value: Extract<CoreExpr, { tag: "union_type" }>;
};

export type RuntimeUnionMatchInfo = {
  case_name: string;
  tag_value: number;
  payload_offset: number;
  payload: RuntimeUnionPayload;
};
