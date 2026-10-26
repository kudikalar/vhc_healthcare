import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API is proxied, so the browser talks to one origin.
export default defineConfig({
  plugins: [react()],
  // Emit the production build to <repo-root>/dist so Vercel (Root Directory = repo root,
  // Output Directory = "dist") finds it. emptyOutDir is required because outDir is outside this root.
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.VITE_API_PROXY || 'http://localhost:4000', changeOrigin: true } },
  },
});
