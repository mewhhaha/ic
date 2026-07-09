import { call_typeclass_method, typeclass } from "jsr:@mewhhaha/typeclasses";

export type Format<self> = {
  fmt: (value: self) => string;
};

export const Format = typeclass(Symbol("Format"), {
  fmt<self>(impl: Format<self>, value: self): string {
    return call_typeclass_method(impl.fmt, impl, value);
  },

  all<self>(impl: Format<self>, values: self[]): string[] {
    return values.map((value) => Format.fmt(impl, value));
  },
});

export type Emit<from, to> = {
  emit: (value: from) => to;
};

export const Emit = typeclass(Symbol("Emit"), {
  emit<from, to>(impl: Emit<from, to>, value: from): to {
    return call_typeclass_method(impl.emit, impl, value);
  },

  all<from, to>(impl: Emit<from, to>, values: from[]): to[] {
    return values.map((value) => Emit.emit(impl, value));
  },
});

export type Parse<from, to> = {
  parse: (value: from) => to;
};

export const Parse = typeclass(Symbol("Parse"), {
  parse<from, to>(impl: Parse<from, to>, value: from): to {
    return call_typeclass_method(impl.parse, impl, value);
  },
});

export type Data<self, item> = {
  data: (value: self) => item[];
};

export const Data = typeclass(Symbol("Data"), {
  data<self, item>(impl: Data<self, item>, value: self): item[] {
    return call_typeclass_method(impl.data, impl, value);
  },
});

export type Typed<self, type> = {
  type: (value: self) => type;
};

export const Typed = typeclass(Symbol("Typed"), {
  type<self, type>(impl: Typed<self, type>, value: self): type {
    return call_typeclass_method(impl.type, impl, value);
  },
});

export type CallableType<type> = {
  args: type[];
  result: type;
};

export type Callable<self, type> = {
  arity: (value: self) => number;
  type: (value: self) => CallableType<type>;
};

export const Callable = typeclass(Symbol("Callable"), {
  arity<self, type>(impl: Callable<self, type>, value: self): number {
    return call_typeclass_method(impl.arity, impl, value);
  },

  type<self, type>(
    impl: Callable<self, type>,
    value: self,
  ): CallableType<type> {
    return call_typeclass_method(impl.type, impl, value);
  },
});

export type Reduce<ctx, from, to> = {
  reduce: (ctx: ctx, value: from) => to;
};

export const Reduce = typeclass(Symbol("Reduce"), {
  reduce<ctx, from, to>(
    impl: Reduce<ctx, from, to>,
    ctx: ctx,
    value: from,
  ): to {
    return call_typeclass_method(impl.reduce, impl, ctx, value);
  },

  all<ctx, from, to>(
    impl: Reduce<ctx, from, to>,
    ctx: ctx,
    values: from[],
  ): to[] {
    return values.map((value) => Reduce.reduce(impl, ctx, value));
  },
});
