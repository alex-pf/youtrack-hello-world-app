import {resolve} from 'node:path';
import {execSync} from 'node:child_process';
import {defineConfig} from 'vite';
import {viteStaticCopy} from 'vite-plugin-static-copy';
import react from '@vitejs/plugin-react';

const gitHash = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
})();

const buildTime = new Date().toISOString();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(gitHash),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        {
          src: '../manifest.json',
          dest: '.'
        },
        {
          src: '../settings.json',
          dest: '.'
        },
        {
          src: '../ask-ai.js',
          dest: '.'
        },
        {
          src: '../public/*.*',
          dest: '.'
        }
      ]
    }),
    viteStaticCopy({
      targets: [
        {
          src: 'widgets/**/*.{svg,png,jpg,json}',
          dest: '.'
        }
      ],
      structured: true
    })
  ],
  root: './src',
  base: '',
  publicDir: 'public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    copyPublicDir: false,
    target: ['es2022'],
    assetsDir: 'widgets/assets',
    rollupOptions: {
      input: {
        issuesTable: resolve(__dirname, 'src/widgets/issues-table/index.html'),
        issuesProgress: resolve(__dirname, 'src/widgets/issues-progress/index.html'),
        issueStateHistory: resolve(__dirname, 'src/widgets/issue-state-history/index.html'),
        aiSummary: resolve(__dirname, 'src/widgets/ai-summary/index.html')
      }
    }
  }
});
