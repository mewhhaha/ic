export function assertEquals(actual: unknown, expected: unknown): void {
  const actualText = Deno.inspect(actual, { depth: 100, sorted: true });
  const expectedText = Deno.inspect(expected, { depth: 100, sorted: true });

  if (actualText !== expectedText) {
    throw new Error(
      "Expected:\n" + expectedText + "\n\nActual:\n" + actualText,
    );
  }
}

export function assertIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(
      "Expected text to include:\n" + expected + "\n\nActual:\n" + actual,
    );
  }
}

export function assertThrows(fn: () => unknown, message: string): void {
  let thrown = false;

  try {
    fn();
  } catch (error) {
    thrown = true;

    if (!(error instanceof Error)) {
      throw new Error("Expected Error instance");
    }

    if (!error.message.includes(message)) {
      throw new Error(
        "Expected error message to include:\n" + message +
          "\n\nActual:\n" + error.message,
      );
    }
  }

  if (!thrown) {
    throw new Error("Expected function to throw");
  }
}
