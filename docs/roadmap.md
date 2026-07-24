# Reserved Feature Roadmap

This roadmap orders the larger reserved capabilities. Each item needs a focused
design and case study; they are not maintenance cleanups and should not be
implemented together.

## 1. Runtime collections

Define one canonical memory-backed collection representation, indexing and
mutation rules, element ownership, bounds behavior, and cleanup. Extend an
existing byte-oriented case study before generalizing to arbitrary elements.

Success requires dynamic construction, indexed read/write, iteration, ownership
transfer, deterministic traps, ABI coverage, and allocation-reuse tests.

## 2. First-class linear closures

Generalize one-shot closure environments beyond the currently supported direct
capture shapes. The design must make invocation count, moved captures, branch
selection, disposal after traps, and returned ownership explicit.

Success requires closure values crossing bindings, branches, aggregate fields,
and host callable boundaries without copying or leaking moved values.

## 3. Portable asynchronous effects

Specify a target-independent task/poll protocol before adding JavaScript
promises. The Wasm contract must represent pending, ready, cancellation, host
resource lifetime, and errors without suspending the Wasm stack implicitly.

Success requires deterministic polling tests and at least one streaming or
timer-driven case study.

## 4. Richer runtime unions

Extend runtime union layouts beyond scalar, Text, Unit, and static-shaped
scalar/Text records. Reuse the collection and ownership layout rules instead of
introducing a second aggregate representation.

Success requires nested arrays, closures or owned buffers in payloads, complete
drop behavior, ABI round trips, and dynamic matching.

## 5. Broader semantic lowering

Extend the semantic Core and gpufuck adapter together. Control-flow joins,
storage effects, host calls, and ownership facts must have explicit semantic
representations before they reach gpufuck Functional Core. Do not add a fallback
backend to cover unsupported source shapes.
