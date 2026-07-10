# Effect examples

These examples exercise file modules, opaque host effects, inferred and
annotated operation rows, and explicit effect-state rebinding.

- `01_inferred_io.ix` lets the compiler infer `Io.read` and `Io.print`.
- `02_annotated_effect_row.ix` shows annotations as upper bounds and lexical
  context forwarding through `read_name()`.
- `../handlers/01_local_counter.ix` implements a deep, stateful `Counter`
  effect entirely inside Ix and installs it with `try ... with ...`.
- `multi_file/` separates a host interface, an effect-using module, and an entry
  module. `host.ix` is supplied as the compiler's host interface; it is not an
  authority-bearing runtime import.

The host gives only the entry module an `Init` value. The entry narrows that
authority when it instantiates `logger.ix`, and the imported file exports an
effectful function through its final record.
