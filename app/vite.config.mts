import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

export default defineConfig(({ mode }) => ({
  base: './',
  define: {
    'import.meta.env.VITE_STATE_API': JSON.stringify(mode === 'pelican' ? './api.php' : '/api/state'),
  },
  plugins: mode === 'pelican' ? [{
    name: 'php-backend',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'api.php', source: readFileSync(new URL('./php/api.php', import.meta.url), 'utf8') });
    },
  }] : [],
  server: {
    proxy: { '/api': 'http://127.0.0.1:3001' },
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/*.db', '**/*.db-*', '**/*.db.*'] },
  },
  preview: {
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
}));
