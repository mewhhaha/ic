import {
  call_typeclass_method,
  install_instance,
  show_typeclass,
  typeclass,
} from "@mewhhaha/typeclasses";
import { expect } from "./expect.ts";

// The compiler traits are typeclasses from @mewhhaha/typeclasses. Each
// companion registers its instance once with `Trait.register(Companion)`;
// the static entry points then dispatch through the instance stored under
// the typeclass token, so `Trait.method(Companion, value)` keeps the
// explicit-dictionary call shape used throughout the compiler.

type Carrier<token extends PropertyKey, instance extends object> = {
  [key in token]: instance;
};

function instance_on<token extends PropertyKey, instance extends object>(
  impl: object,
  token: token,
  label: string,
): instance {
  const carrier = impl as Partial<Carrier<token, instance>>;
  const instance = carrier[token];
  expect(instance, "Missing " + label + " instance for dictionary");
  return instance;
}

export const format_typeclass = Symbol("binned.Format");

export type Format<self> = {
  fmt: (value: self) => string;
};

export const Format = typeclass(format_typeclass, {
  // Registering a formatter also installs the library Show instance, so
  // wrapped values (`as_data(Companion, value)`) work with `Show.show`.
  register<self>(impl: Format<self>): void {
    install_instance(impl, format_typeclass, { fmt: impl.fmt });
    install_instance(impl, show_typeclass, {
      show(this: { value: () => self }): string {
        return impl.fmt(this.value());
      },
    });
  },
  fmt<self>(impl: Format<self>, value: self): string {
    const instance = instance_on<typeof format_typeclass, Format<self>>(
      impl,
      format_typeclass,
      "Format",
    );
    return call_typeclass_method(instance.fmt, impl, value);
  },
  all<self>(impl: Format<self>, values: self[]): string[] {
    return values.map((value) => this.fmt(impl, value));
  },
});

export const emit_typeclass = Symbol("binned.Emit");

export type Emit<from, to> = {
  emit: (value: from) => to;
};

export const Emit = typeclass(emit_typeclass, {
  register<from, to>(impl: Emit<from, to>): void {
    install_instance(impl, emit_typeclass, { emit: impl.emit });
  },
  emit<from, to>(impl: Emit<from, to>, value: from): to {
    const instance = instance_on<typeof emit_typeclass, Emit<from, to>>(
      impl,
      emit_typeclass,
      "Emit",
    );
    return call_typeclass_method(instance.emit, impl, value);
  },
  all<from, to>(impl: Emit<from, to>, values: from[]): to[] {
    return values.map((value) => this.emit(impl, value));
  },
});

export const data_typeclass = Symbol("binned.Data");

export type Data<self, item> = {
  data: (value: self) => item[];
};

export const Data = typeclass(data_typeclass, {
  register<self, item>(impl: Data<self, item>): void {
    install_instance(impl, data_typeclass, { data: impl.data });
  },
  data<self, item>(impl: Data<self, item>, value: self): item[] {
    const instance = instance_on<typeof data_typeclass, Data<self, item>>(
      impl,
      data_typeclass,
      "Data",
    );
    return call_typeclass_method(instance.data, impl, value);
  },
});

export const typed_typeclass = Symbol("binned.Typed");

export type Typed<self, type> = {
  type: (value: self) => type;
};

export const Typed = typeclass(typed_typeclass, {
  register<self, type>(impl: Typed<self, type>): void {
    install_instance(impl, typed_typeclass, { type: impl.type });
  },
  type<self, type>(impl: Typed<self, type>, value: self): type {
    const instance = instance_on<typeof typed_typeclass, Typed<self, type>>(
      impl,
      typed_typeclass,
      "Typed",
    );
    return call_typeclass_method(instance.type, impl, value);
  },
});

export const callable_typeclass = Symbol("binned.Callable");

export type CallableType<type> = {
  args: type[];
  result: type;
};

export type Callable<self, type> = {
  arity: (value: self) => number;
  type: (value: self) => CallableType<type>;
};

export const Callable = typeclass(callable_typeclass, {
  register<self, type>(impl: Callable<self, type>): void {
    install_instance(impl, callable_typeclass, {
      arity: impl.arity,
      type: impl.type,
    });
  },
  arity<self, type>(impl: Callable<self, type>, value: self): number {
    const instance = instance_on<
      typeof callable_typeclass,
      Callable<self, type>
    >(impl, callable_typeclass, "Callable");
    return call_typeclass_method(instance.arity, impl, value);
  },
  type<self, type>(
    impl: Callable<self, type>,
    value: self,
  ): CallableType<type> {
    const instance = instance_on<
      typeof callable_typeclass,
      Callable<self, type>
    >(impl, callable_typeclass, "Callable");
    return call_typeclass_method(instance.type, impl, value);
  },
});

export const reduce_typeclass = Symbol("binned.Reduce");

export type Reduce<ctx, from, to> = {
  reduce: (ctx: ctx, value: from) => to;
};

export const Reduce = typeclass(reduce_typeclass, {
  register<ctx, from, to>(impl: Reduce<ctx, from, to>): void {
    install_instance(impl, reduce_typeclass, { reduce: impl.reduce });
  },
  reduce<ctx, from, to>(
    impl: Reduce<ctx, from, to>,
    ctx: ctx,
    value: from,
  ): to {
    const instance = instance_on<
      typeof reduce_typeclass,
      Reduce<ctx, from, to>
    >(impl, reduce_typeclass, "Reduce");
    return call_typeclass_method(instance.reduce, impl, ctx, value);
  },
  all<ctx, from, to>(
    impl: Reduce<ctx, from, to>,
    ctx: ctx,
    values: from[],
  ): to[] {
    return values.map((value) => this.reduce(impl, ctx, value));
  },
});
