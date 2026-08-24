/**
 * Local production preview with narrow read-only metadata proxies.
 *
 * Discogs rejects Authorization-header CORS preflights on some API routes.
 * Binding to loopback keeps the token on this machine while letting the
 * browser make same-origin requests. MusicBrainz, AcousticBrainz and
 * GetSongBPM use the same route so production needs an equivalent edge/server
 * implementation.
 */
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const base = '/cratenav/';
const host = process.argv.includes('--host')
  ? process.argv[process.argv.indexOf('--host') + 1] ?? '127.0.0.1'
  : '127.0.0.1';
const port = Number(process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1]
  : 4174);
const metadataContact = process.env.CRATENAV_CONTACT?.trim() || 'contact-not-configured';

const contentTypes = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.woff2': 'font/woff2',
};

function cleanContact(value) {
  const text = Array.isArray(value) ? value[0] : value;
  return text?.replace(/[\r\n]/g, ' ').trim().slice(0, 200) || undefined;
}

function retryDelay(response, attempt) {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const milliseconds = Number.isFinite(seconds)
      ? seconds * 1_000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(milliseconds) && milliseconds > 0) {
      return Math.min(milliseconds, 15_000);
    }
  }
  return attempt * 1_500;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchWithRetry(url, init) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const upstream = await fetch(url, init);
      if (![429, 502, 503, 504].includes(upstream.status) || attempt === 3) return upstream;
      await upstream.body?.cancel();
      await delay(retryDelay(upstream, attempt));
    } catch (error) {
      lastError = error;
      if (attempt === 3) throw error;
      await delay(retryDelay(undefined, attempt));
    }
  }
  throw lastError ?? new Error('Metadata request failed.');
}

async function proxyGet(request, response, route) {
  const requestContact = cleanContact(request.headers['x-cratenav-contact']);
  const userAgent = `cratenav/0.1 (${requestContact ?? metadataContact})`;
  const upstream = await fetchWithRetry(
    `${route.target}${request.url.slice(route.prefix.length)}`,
    {
      headers: {
        accept: request.headers.accept ?? 'application/json',
        ...(route.forwardAuthorization && request.headers.authorization
          ? { authorization: request.headers.authorization }
          : {}),
        ...(route.forwardApiKey && request.headers['x-api-key']
          ? { 'x-api-key': request.headers['x-api-key'] }
          : {}),
        'user-agent': userAgent,
      },
    },
  );
  const headers = {};
  for (const name of ['content-type', 'x-discogs-ratelimit', 'x-discogs-ratelimit-remaining', 'retry-after']) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  response.writeHead(upstream.status, headers);
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

async function serveFile(request, response) {
  let relative = request.url.split('?')[0].slice(base.length);
  if (!relative || relative.endsWith('/')) relative += 'index.html';
  const candidate = normalize(join(root, relative));
  if (!candidate.startsWith(root)) { response.writeHead(403).end(); return; }
  try {
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error('not a file');
    response.writeHead(200, { 'content-type': contentTypes[extname(candidate)] ?? 'application/octet-stream' });
    createReadStream(candidate).pipe(response);
  } catch {
    // The PWA is a hash router, but returning the shell is friendlier for a
    // typed local URL and mirrors the production navigation fallback.
    const shell = join(root, 'index.html');
    await access(shell);
    response.writeHead(200, { 'content-type': contentTypes['.html'] });
    createReadStream(shell).pipe(response);
  }
}

createServer(async (request, response) => {
  try {
    if (!request.url || request.method !== 'GET') { response.writeHead(405).end(); return; }
    const route = [
      { prefix: '/api/discogs', target: 'https://api.discogs.com', forwardAuthorization: true },
      { prefix: '/api/musicbrainz', target: 'https://musicbrainz.org' },
      { prefix: '/api/acousticbrainz', target: 'https://acousticbrainz.org' },
      { prefix: '/api/getsongbpm', target: 'https://api.getsong.co', forwardApiKey: true },
    ].find((candidate) => request.url.startsWith(`${candidate.prefix}/`));
    if (route) await proxyGet(request, response, route);
    else if (request.url.startsWith(base)) await serveFile(request, response);
    else response.writeHead(404).end();
  } catch (error) {
    console.error('Local preview request failed:', error instanceof Error ? error.message : error);
    response.writeHead(502, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'Could not reach the metadata service from the local preview server.' }));
  }
}).listen(port, host, () => {
  console.log(`cratenav local preview: http://${host}:${port}${base}`);
  if (metadataContact === 'contact-not-configured') {
    console.log('Enter a MusicBrainz contact in Analyse before searching (CRATENAV_CONTACT is an optional server fallback).');
  }
});
