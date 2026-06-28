export function expect(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}
