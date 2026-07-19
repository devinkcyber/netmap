import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Served from the domain root in dev/preview; the GitHub Pages build sets VITE_BASE=/netmap/
  // (a project site lives under /<repo>/) so asset URLs resolve correctly there.
  base: process.env.VITE_BASE || '/',
  plugins: [react(), tailwindcss()],
  server: {
    // Honor the port the harness assigns (autoPort) via PORT; fall back to Vite's default.
    port: Number(process.env.PORT) || 5173,
  },
});
