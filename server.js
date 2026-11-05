// Mastermind SSS — servidor do painel em Node.js (sem dependências).
// Serve index.html, manifest.json, sw.js e icons/ para quem não usa o GitHub Pages
// (por exemplo, com o repositório privado). Os dados continuam vindo das Edge Functions do Supabase.
//
// Uso:   node server.js              → http://localhost:3000
//        PORT=8080 node server.js    → outra porta (Render, Railway etc. definem PORT sozinhos)
// Requer Node 18 ou mais novo.
const http = require('http');
const fs = require('fs');
const path = require('path');

const RAIZ = __dirname;
const PORTA = Number(process.env.PORT) || 3000;
// Só estes arquivos são servidos: o resto do repositório (supabase/, docs/, .github/) nunca sai.
const PERMITIDOS = /^\/(index\.html|manifest\.json|sw\.js|icons\/[\w.-]+\.(png|svg|ico))$/;
const TIPOS = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const servidor = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  let caminho;
  try { caminho = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (caminho === '/' || caminho === '') caminho = '/index.html';
  if (caminho === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (!PERMITIDOS.test(caminho)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
  const arquivo = path.join(RAIZ, caminho);
  fs.readFile(arquivo, (erro, dados) => {
    if (erro) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
    const ext = path.extname(arquivo);
    res.writeHead(200, {
      'Content-Type': TIPOS[ext] || 'application/octet-stream',
      // HTML e service worker sempre atualizados; ícones podem ficar em cache
      'Cache-Control': ext === '.png' || ext === '.svg' || ext === '.ico' ? 'public, max-age=604800' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
    });
    res.end(req.method === 'HEAD' ? undefined : dados);
  });
});

servidor.listen(PORTA, () => console.log(`Mastermind SSS no ar: http://localhost:${PORTA}`));
