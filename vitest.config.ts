import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The build emits compiled tests to dist/tests/*.test.js without the
    // non-TS fixtures they depend on, so Vitest must never run them.
    exclude: [...configDefaults.exclude, "**/dist/**"],
  },
});
