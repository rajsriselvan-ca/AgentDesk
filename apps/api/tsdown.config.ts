import { defineConfig } from 'tsdown';

/**
 * Production build.
 *
 * Workspace packages are bundled rather than externalised, because they are
 * shipped as TypeScript source and there is nothing to resolve at runtime.
 * Real npm dependencies stay external so they resolve from node_modules.
 */
export default defineConfig({
  entry: ['src/server.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  // Emit .js rather than .mjs. The package is already `type: module`, so the
  // extension carries no extra meaning here, and it keeps the start script and
  // the Dockerfile referring to a path that actually exists.
  fixedExtension: false,
  clean: true,
  sourcemap: true,
  dts: false,
  noExternal: [/^@agentdesk\//],
});
