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

export const format_typeclass = Symbol("ducklang.Format");

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

export const callable_typeclass = Symbol("ducklang.Callable");

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
