export type Format<self> = {
  fmt: (value: self) => string;
};

export function Format() {}

Format.fmt = function fmt<self>(
  impl: Format<self>,
  value: self,
): string {
  return impl.fmt(value);
};

Format.all = function all<self>(
  impl: Format<self>,
  values: self[],
): string[] {
  return values.map((value) => Format.fmt(impl, value));
};

export type Emit<from, to> = {
  emit: (value: from) => to;
};

export function Emit() {}

Emit.emit = function emit<from, to>(
  impl: Emit<from, to>,
  value: from,
): to {
  return impl.emit(value);
};

Emit.all = function all<from, to>(
  impl: Emit<from, to>,
  values: from[],
): to[] {
  return values.map((value) => Emit.emit(impl, value));
};

export type Data<self, item> = {
  data: (value: self) => item[];
};

export function Data() {}

Data.data = function data<self, item>(
  impl: Data<self, item>,
  value: self,
): item[] {
  return impl.data(value);
};

export type Typed<self, type> = {
  type: (value: self) => type;
};

export function Typed() {}

Typed.type = function type<self, type>(
  impl: Typed<self, type>,
  value: self,
): type {
  return impl.type(value);
};

export type CallableType<type> = {
  args: type[];
  result: type;
};

export type Callable<self, type> = {
  arity: (value: self) => number;
  type: (value: self) => CallableType<type>;
};

export function Callable() {}

Callable.arity = function arity<self, type>(
  impl: Callable<self, type>,
  value: self,
): number {
  return impl.arity(value);
};

Callable.type = function type<self, type>(
  impl: Callable<self, type>,
  value: self,
): CallableType<type> {
  return impl.type(value);
};

export type Reduce<ctx, from, to> = {
  reduce: (ctx: ctx, value: from) => to;
};

export function Reduce() {}

Reduce.reduce = function reduce<ctx, from, to>(
  impl: Reduce<ctx, from, to>,
  ctx: ctx,
  value: from,
): to {
  return impl.reduce(ctx, value);
};

Reduce.all = function all<ctx, from, to>(
  impl: Reduce<ctx, from, to>,
  ctx: ctx,
  values: from[],
): to[] {
  return values.map((value) => Reduce.reduce(impl, ctx, value));
};
