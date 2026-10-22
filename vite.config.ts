import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 5173,
    hmr: {
      overlay: false,
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://127.0.0.1:8080",
        ws: true,
      },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'ui': ['lucide-react', 'sonner'],
        }
      }
    },
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: false, // ВРЕМЕННО: оставляем логи для отладки
        drop_debugger: true,
      }
    },
    // Оптимизация размера чанков
    chunkSizeWarningLimit: 1000,
  },
}));
