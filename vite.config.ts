import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';
import { discoverLive2DModels } from './frontend/avatar/live2d/catalogCore.mjs';

function live2dModelCatalog() {
  const virtualId = 'virtual:ice-live2d-models';
  const resolvedId = `\0${virtualId}`;
  const modelDirectories = ['xglk', 'miku_free', 'miku_pro'];

  return {
    name: 'ice-live2d-model-catalog',
    resolveId(id: string) {
      return id === virtualId ? resolvedId : undefined;
    },
    load(id: string) {
      if (id !== resolvedId) return undefined;
      const files: string[] = [];
      const visit = (directory: string, relativeDirectory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const absolutePath = path.join(directory, entry.name);
          const relativePath = path.posix.join(relativeDirectory, entry.name);
          if (entry.isDirectory()) visit(absolutePath, relativePath);
          else if (entry.isFile()) files.push(relativePath);
        }
      };
      for (const directory of modelDirectories) {
        const absoluteDirectory = path.resolve(__dirname, 'assets', directory);
        if (fs.existsSync(absoluteDirectory)) visit(absoluteDirectory, directory);
      }
      return `export default ${JSON.stringify(discoverLive2DModels(files))};`;
    }
  };
}

export default defineConfig({
  plugins: [react(), live2dModelCatalog()],
  publicDir: 'assets',
  resolve: {
    alias: {
      '@cubism': path.resolve(__dirname, 'CubismSdkForWeb/CubismSdkForWeb-5-r.5/Framework/src')
    }
  },
  optimizeDeps: { entries: ['index.html'] },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/CubismSdkForWeb/**'] }
  },
  envPrefix: ['VITE_', 'TAURI_']
});
