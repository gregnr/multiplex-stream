import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'general',
      environment: 'node',
      include: ['src/**/*.{test,spec}.ts'],
    },
  },
]);
