import { defineConfig, type ProxyOptions } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

// Project page at https://<user>.github.io/cratenav/
const BASE = '/cratenav/';
const METADATA_CONTACT = process.env.CRATENAV_CONTACT?.trim() || 'contact-not-configured';
const METADATA_USER_AGENT = `cratenav/0.1 (${METADATA_CONTACT})`;

function metadataProxy(target: string, prefix: string): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    rewrite: (path) => path.replace(new RegExp(`^${prefix}`), ''),
    headers: { 'User-Agent': METADATA_USER_AGENT },
    configure(proxy) {
      proxy.on('proxyReq', (proxyRequest, request) => {
        const header = request.headers['x-cratenav-contact'];
        const raw = Array.isArray(header) ? header[0] : header;
        const contact = raw?.replace(/[\r\n]/g, ' ').trim().slice(0, 200);
        if (contact) proxyRequest.setHeader('User-Agent', `cratenav/0.1 (${contact})`);
        proxyRequest.removeHeader('X-Cratenav-Contact');
      });
    },
  };
}

export default defineConfig({
  base: BASE,
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    proxy: {
      '/api/discogs': {
        target: 'https://api.discogs.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/discogs/, ''),
        headers: { 'User-Agent': METADATA_USER_AGENT },
      },
      '/api/musicbrainz': metadataProxy('https://musicbrainz.org', '/api/musicbrainz'),
      '/api/acousticbrainz': metadataProxy('https://acousticbrainz.org', '/api/acousticbrainz'),
    },
  },
  plugins: [
    VitePWA({
      registerType: 'prompt',
      // App shell is precached; Discogs artwork is cached at runtime (see below).
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: `${BASE}index.html`,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Discogs artwork. Cache-first: covers never change for a given URL.
            urlPattern: /^https:\/\/i\.discogs\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cratenav-artwork',
              expiration: { maxEntries: 4000, maxAgeSeconds: 60 * 60 * 24 * 180 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // API responses are NEVER served from cache: the local DB is the
            // offline story, not a stale HTTP cache.
            urlPattern: /^https:\/\/api\.discogs\.com\/.*/i,
            handler: 'NetworkOnly',
          },
        ],
      },
      manifest: {
        id: BASE,
        name: 'cratenav — vinyl DJ library',
        short_name: 'cratenav',
        description:
          'Vinyl collection, crate planning and harmonic mixing assistant for DJs.',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        orientation: 'portrait-primary',
        background_color: '#0b0d10',
        theme_color: '#0b0d10',
        categories: ['music', 'utilities'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as Parameters<typeof defineConfig>[0]);
