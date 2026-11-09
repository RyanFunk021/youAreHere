import { defineConfig } from 'vite';

// Served from https://ryanfunk021.github.io/youAreHere/
export default defineConfig({
  base: '/youAreHere/',
  build: { target: 'es2022' },
});
