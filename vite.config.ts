import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vite';

function hasWranglerAuth(): boolean {
  if (process.env.CLOUDFLARE_API_TOKEN) return true;
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const candidates = [
    path.join(xdgConfig, '.wrangler', 'config', 'default.toml'),
    path.join(os.homedir(), '.wrangler', 'config', 'default.toml'),
    path.join(os.homedir(), 'Library', 'Preferences', '.wrangler', 'config', 'default.toml'),
  ];
  return candidates.some((candidate) => fs.existsSync(candidate));
}

export default defineConfig(() => {
  const remoteBindings =
    process.env.CLOUDFLARE_REMOTE_BINDINGS === 'true'
      ? true
      : process.env.CLOUDFLARE_REMOTE_BINDINGS === 'false'
        ? false
        : hasWranglerAuth();

  return {
    plugins: [
      react(),
      tailwindcss(),
      cloudflare({
        remoteBindings,
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
