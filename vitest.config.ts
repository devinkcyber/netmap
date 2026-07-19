import { defineConfig } from 'vitest/config';

// Unit tests cover the pure logic in src/lib and src/types. parseNmap uses the
// browser DOMParser, so tests run in the jsdom environment.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
