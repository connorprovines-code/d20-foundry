import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = import.meta.dirname;
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

/** Copies module.json (with the package version), lang/, templates/ and styles/ next to the bundle. */
function foundryAssets() {
  return {
    name: 'foundry-assets',
    closeBundle() {
      const dist = resolve(root, 'dist');
      mkdirSync(dist, { recursive: true });
      const manifest = JSON.parse(readFileSync(resolve(root, 'module.json'), 'utf8'));
      manifest.version = pkg.version;
      manifest.download = manifest.download.replace('{version}', pkg.version);
      writeFileSync(resolve(dist, 'module.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      cpSync(resolve(root, 'lang'), resolve(dist, 'lang'), { recursive: true });
      cpSync(resolve(root, 'templates'), resolve(dist, 'templates'), { recursive: true });
      cpSync(resolve(root, 'styles'), resolve(dist, 'styles'), { recursive: true });
    },
  };
}

export default defineConfig(({ mode }) => ({
  define: {
    __MODULE_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The release build (vite build --mode release) ships readable, without a source map.
    sourcemap: mode !== 'release',
    minify: false,
    target: 'es2022',
    lib: {
      entry: resolve(root, 'src/main.js'),
      formats: ['es'],
      fileName: () => 'module.js',
    },
    rollupOptions: {
      output: { codeSplitting: false },
    },
  },
  plugins: [foundryAssets()],
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    setupFiles: ['test/helpers/setup.js'],
  },
}));
