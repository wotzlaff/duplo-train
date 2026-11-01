import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

/** GitHub Pages serves project sites below /<repo>/, local dev stays at /. */
const base = process.env.BASE_PATH || '/';

/** Ship the long-form reverse-engineering notes and the licence with the site. */
function copyDocs() {
  return {
    name: 'duplo-copy-docs',
    closeBundle() {
      for (const file of ['BLE-MECHANICS.md', 'LICENSE']) {
        const source = resolve(root, file);
        if (existsSync(source)) copyFileSync(source, resolve(root, 'dist', file));
      }
    },
  };
}

export default defineConfig({
  appType: 'mpa',
  base,
  plugins: [copyDocs()],
  build: {
    rollupOptions: {
      input: {
        landing: resolve(root, 'index.html'),
        control: resolve(root, 'control/index.html'),
      },
    },
  },
});
