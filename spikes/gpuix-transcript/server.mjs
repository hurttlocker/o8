import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

export async function previewServer() {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const name = path === '/' ? 'index.html' : path.slice(1);
    if (!['index.html', 'preview.js', 'preview.js.map'].includes(name)) {
      response.writeHead(404).end(); return;
    }
    try {
      const body = await readFile(new URL(`./dist/${name}`, import.meta.url));
      response.setHeader('content-type', name.endsWith('.html') ? 'text/html' : 'text/javascript');
      response.setHeader('cache-control', 'no-store'); response.end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); },
  };
}
