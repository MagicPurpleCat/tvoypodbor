import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) } },
  // allowedHosts: Vite 6 по умолчанию отклоняет чужие домены — разрешаем туннель cloudflared для теста в Telegram
  server: { port: 5173, fs: { allow: ['..'] }, allowedHosts: ['.trycloudflare.com'] },
  build: { target: 'es2020', sourcemap: false },
});
