# WAV Synthesizer Case Study

This case study compiles a small pure Duck synthesizer to managed Wasm and
writes its result as a standard RIFF/WAVE file. It produces one second of mono,
8 kHz, 16-bit little-endian PCM: a repeating four-note phrase made from two
square-wave voices (melody and pulse).

The Duck program owns byte construction. `@Bytes.generate` calls `wav_byte` once
per output position; that function chooses between the pure RIFF header and PCM
sample functions. `little_endian_byte` builds every multi-byte header and sample
field with `@bit_and` and `@shift_right_u`, including the signed sample's
two's-complement representation. The waveform is a pure function of the sample
index, so no mutable audio buffer or reference mutation is needed.

`wav.ts` is deliberately small: it compiles and instantiates the Duck module,
checks that the managed result is `Bytes`, and writes the file only when run as
a command. The renderer itself performs no I/O, which lets the tests inspect the
`Uint8Array` returned through the managed Wasm ABI.

## Run

Write the default `phrase.wav` in the current directory:

```sh
deno run --allow-read --allow-write --allow-run=wat2wasm \
  case-studies/wav/wav.ts
```

Choose an output path:

```sh
deno run --allow-read --allow-write --allow-run=wat2wasm \
  case-studies/wav/wav.ts build/phrase.wav
```

Run the contract tests:

```sh
deno test --allow-read --allow-run=wat2wasm case-studies/wav/wav.test.ts
```

## Boundary

This is a binary-only example. It does not require source formatting or UTF
APIs: RIFF identifiers are emitted as hexadecimal byte constants, and the header
fields and PCM words are assembled as integers. The TypeScript command wrapper
is the only filesystem boundary.
