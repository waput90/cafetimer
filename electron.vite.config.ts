import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main.ts') }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [tailwindcss()]
  }
});
