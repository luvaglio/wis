import { defineConfig } from "vitest/config";

/**
 * These suites cover the boundary logic: context assembly ordering, the
 * untrusted-content wrapper, the confirmation gate, and the tone rules. All of
 * it is pure and binding-free on purpose, so it runs in plain Node and stays
 * fast enough to run on every change.
 *
 * Anything that genuinely needs bindings belongs in a separate suite running
 * on the Workers pool.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
