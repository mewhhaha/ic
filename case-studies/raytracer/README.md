# Scalar Ray Tracer Case Study

This directory renders a fixed 32×20 binary P6 PPM image with a small CPU ray
tracer written in Duck. It uses scalar `F32` vectors rather than the planned
SIMD surface so the program remains a readable baseline for later comparison.

Each generated pixel starts with a camera ray through a small view plane. The
ray is tested against one sphere, shaded with an ambient-plus-diffuse light, and
otherwise receives a vertical sky gradient. The program returns the PPM as owned
`Bytes`; `@Bytes.generate` calls the pure `render_byte` callback once per output
byte, so there is no public mutable reference or host effect in the renderer.

The PPM header is `P6\n32 20\n255\n`, followed by 1,920 RGB bytes. The
TypeScript host is deliberately thin: it compiles the Duck source, instantiates
the managed artifact, and writes or returns the resulting bytes.

## Run

Write the deterministic image to a file:

```sh
deno run --allow-read --allow-run=wat2wasm \
  case-studies/raytracer/raytracer.ts > raytracer.ppm
```

Run the render contract test:

```sh
deno test --no-check --allow-read --allow-run \
  case-studies/raytracer/raytracer.test.ts
```

The test validates the PPM header and exact byte count, then uses an FNV-1a
checksum to lock the complete image output.
