// sss-compras: Compra Recorrente com paginacao completa da VarejOnline + desconto dos pedidos em andamento da Central.
// Modulos (POST): { modulo: 'recorrente' | 'vinculo' | 'diagnosticoCentral' | 'catalogoCentral' | 'pedidoSugerido' | 'vendedores' | 'compatibilidade' | 'painel' | 'comparativo' | 'lojaEditar', ... }.
// Secrets: VAREJONLINE_API_BASE, APP_PASSCODE, PEDIDOS_API_KEY, ALLOWED_ORIGIN (opcional), LIMITE_PEDIDO_SEM_CONFIRMACAO (opcional, em R$).
// Tabelas: lojas_config, pedidos_vinculos, pedidos_sugeridos.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { saidasComCache, saldosComCache, registrarLojas, lojaDaChave, prepararChamada, abrirChave, reiniciarMedicao, resumoMedicao, medicao, diaDaVenda } from '../_shared/vendas_cache.ts';


// ALLOWED_ORIGIN aceita varios enderecos separados por virgula (ex.: GitHub Pages + servidor Node).
// localhost sempre pode (painel rodando no computador com node server.js).
const ORIGENS_PERMITIDAS = String(Deno.env.get('ALLOWED_ORIGIN') || '*').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
function origemPermitida(req: Request): string {
  if (ORIGENS_PERMITIDAS.includes('*')) return '*';
  const o = (req.headers.get('origin') ?? '').replace(/\/+$/, '');
  // dominio da rede (ex.: https://insight.santosantosantofranquia.com.br) sempre pode
  if (o && (ORIGENS_PERMITIDAS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) || /^https:\/\/([a-z0-9-]+\.)*santosantosantofranquia\.com\.br$/.test(o))) return o;
  return ORIGENS_PERMITIDAS[0];
}
const cors: Record<string, string> = {
  'Access-Control-Allow-Origin': ORIGENS_PERMITIDAS.includes('*') ? '*' : ORIGENS_PERMITIDAS[0],
  'Vary': 'Origin',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-app-passcode',
};
// =====================================================================
// ACESSO — login por usuário (Supabase Auth) + senha do time (transição)
// Papéis: admin (tudo), equipe (rede toda), franqueado (só as lojas liberadas).
// Secret LOGIN_OBRIGATORIO=true desliga a senha do time.
// (bloco idêntico em sss-compras e sss-mastermind)
// =====================================================================
type Acesso = { tipo: 'usuario' | 'senha'; userId?: string; email?: string; nome: string; papel: 'admin' | 'equipe' | 'franqueado'; lojas: string[]; todas: boolean; trocarSenha?: boolean };
class ErroAcesso extends Error { constructor(msg: string, public status = 403) { super(msg); } }
const cacheAcesso = new Map<string, { quando: number; acesso: Acesso }>();

// O login vale 24 h: o token do Supabase traz em "amr" a hora em que a pessoa digitou a senha
// (a renovação automática do token não muda essa hora).
const LOGIN_VALIDADE_MS = 24 * 3600_000;
function loginVencido(jwt: string): boolean {
  try {
    const b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)));
    const ts = Math.max(0, ...(Array.isArray(p.amr) ? p.amr : []).map((x: any) => Number(x?.timestamp) || 0));
    return ts > 0 && Date.now() - ts * 1000 > LOGIN_VALIDADE_MS;
  } catch (_) { return false; }
}
async function obterAcesso(req: Request): Promise<Acesso> {
  const auth = req.headers.get('authorization') ?? '';
  const jwt = /^bearer /i.test(auth) ? auth.slice(7).trim() : '';
  const chavesPublicas = [Deno.env.get('SUPABASE_ANON_KEY'), Deno.env.get('SUPABASE_PUBLISHABLE_KEY')].filter(Boolean);
  if (jwt && !chavesPublicas.includes(jwt)) {
    if (loginVencido(jwt)) throw new ErroAcesso('Sua sessão terminou: o acesso vale por 24 horas. Entre de novo.', 401);
    const c = cacheAcesso.get(jwt);
    if (c && Date.now() - c.quando < 60000) return c.acesso;
    const adm = clienteAcesso();
    const { data, error } = await adm.auth.getUser(jwt);
    if (error || !data?.user) throw new ErroAcesso('Sua sessão expirou. Entre de novo.', 401);
    const { data: p, error: e2 } = await adm.from('usuarios_painel').select('nome, papel, lojas, ativo, trocar_senha').eq('user_id', data.user.id).maybeSingle();
    if (e2) throw new ErroAcesso(`Erro ao ler o perfil do usuário: ${e2.message}`, 500);
    if (!p || !p.ativo) throw new ErroAcesso('Seu usuário não tem acesso ao painel. Fale com o administrador.', 403);
    const papel = (['admin', 'equipe', 'franqueado'].includes(p.papel) ? p.papel : 'franqueado') as Acesso['papel'];
    const acesso: Acesso = { tipo: 'usuario', userId: data.user.id, email: data.user.email ?? '', nome: p.nome || data.user.email || 'usuário', papel, lojas: p.lojas ?? [], todas: papel !== 'franqueado', trocarSenha: !!p.trocar_senha };
    cacheAcesso.set(jwt, { quando: Date.now(), acesso });
    return acesso;
  }
  const obrigatorio = String(Deno.env.get('LOGIN_OBRIGATORIO') ?? '').toLowerCase() === 'true';
  const esperado = Deno.env.get('APP_PASSCODE');
  const enviado = req.headers.get('x-app-passcode') ?? '';
  if (!obrigatorio && esperado && enviado && iguaisSeguro(enviado, esperado)) return { tipo: 'senha', nome: 'Senha do time', papel: 'admin', lojas: [], todas: true };
  if (enviado && esperado) await freioTentativa(req);
  if (!obrigatorio && !esperado) return { tipo: 'senha', nome: 'Acesso livre', papel: 'admin', lojas: [], todas: true };
  throw new ErroAcesso(obrigatorio ? 'Entre com seu e-mail e senha.' : 'Senha de acesso inválida ou ausente.', 401);
}
// Lojas que o usuário pode consultar (null = todas). Franqueado: só as liberadas.
function lojasDoAcesso(a: Acesso, pedidas: unknown): string[] | null {
  const lista = Array.isArray(pedidas) ? pedidas.map(String).filter(Boolean) : [];
  if (a.todas) return lista.length ? lista : null;
  const ok = (lista.length ? lista : a.lojas).filter((l) => a.lojas.includes(l));
  if (!ok.length) throw new ErroAcesso(a.lojas.length ? 'Sem acesso a esta loja.' : 'Nenhuma loja liberada para o seu usuário. Fale com o administrador.', 403);
  return ok;
}
function exigirPapel(a: Acesso, ...papeis: Acesso['papel'][]) { if (!papeis.includes(a.papel)) throw new ErroAcesso('Seu usuário não tem permissão para esta ação.', 403); }
// Comparacao de senha/chave em tempo constante (nao revela quantos caracteres acertou)
function iguaisSeguro(a: string, b: string) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let dif = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) dif |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return dif === 0;
}
// Tentativas erradas de senha do time / chave: espera crescente por IP (freia quem tenta adivinhar)
const errosPorIp = new Map<string, { n: number; ate: number }>();
const ipDe = (req: Request) => (req.headers.get('x-forwarded-for') ?? req.headers.get('cf-connecting-ip') ?? '?').split(',')[0].trim();
async function freioTentativa(req: Request) {
  const ip = ipDe(req), agora = Date.now(), e = errosPorIp.get(ip);
  const n = e && agora - e.ate < 15 * 60_000 ? e.n + 1 : 1;
  errosPorIp.set(ip, { n, ate: agora }); if (errosPorIp.size > 5000) errosPorIp.clear();
  await new Promise((ok) => setTimeout(ok, Math.min(8000, 400 * n)));
}
function exigirLoja(a: Acesso, loja: unknown) { if (!a.todas && !a.lojas.includes(String(loja ?? ''))) throw new ErroAcesso('Sem acesso a esta loja.', 403); }
const respostaErroAcesso = (e: ErroAcesso, headers: Record<string, string>) => new Response(JSON.stringify({ error: e.message, acesso: e.status === 401 ? 'login' : 'negado' }), { status: e.status, headers: { ...headers, 'Content-Type': 'application/json' } });

// Toda resposta de sucesso leva _desempenho (tempo total, VarejOnline, cache de vendas, Central) para o diagnostico do painel.
const resp = (o: unknown, s = 200) => new Response(JSON.stringify(o && typeof o === 'object' && !Array.isArray(o) && s < 400 ? { ...(o as any), _desempenho: resumoMedicao() } : o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const sb = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const clienteAcesso = sb;

const limpa = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const normLoja = (s: unknown) => limpa(String(s ?? '').replace(/^\s*\d+\s*-?\s*/, '')).replace(/\bSSS\b/g, '').replace(/\s+/g, ' ').trim();
const codNorm = (s: unknown) => String(s ?? '').trim().toUpperCase().split(' ').join('');
const fmtBR = (d: Date) => `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
const tokens = (s: unknown) => new Set(limpa(s).split(' ').filter((t) => t.length > 1));
function jaccard(a: Set<string>, b: Set<string>) {
  let i = 0;
  for (const t of a) if (b.has(t)) i++;
  const u = a.size + b.size - i;
  return u ? i / u : 0;
}

const CENTRAL = 'https://app.centraldofranqueado.com.br/api/v2/pedidos';
const FINAIS = new Set(['finalizado', 'concluido', 'cancelado']); // situacoes que ja chegaram ou foram canceladas
const DIAS_PARADO = 120; // pedido sem alteracao ha mais de 4 meses nao desconta
// Pedido "Enviado" há mais que isso já chegou na loja (muita loja não confirma o recebimento na Central): não conta como "a caminho".
const DIAS_ENVIADO = 15;
const ehEnviado = (p: any) => /envi/i.test(String(p.situacao?.descricao ?? '')) || /envi/i.test(String(p.situacao?.status ?? ''));
// Lojas da Central cujo nome nao bate sozinho com o nome no painel.
const OVERRIDES: Record<string, string> = {
  'GOIANIA SETOR OESTE': 'SSS GOIANIA 1', 'GOIANIA JD GOIAS': 'SSS GOIANIA 2',
  'RIBEIRAO PRETO': 'SSS RIBEIRAO 1', 'RIBEIRAO PRETO UNIDADE 02': 'SSS RIBEIRAO 2',
  'BRASILIA ASA SUL': 'SSS BRASILIA 1', 'BRASILIA ASA NORTE': 'SSS BRASILIA 2',
  'SAO PAULO VILA LEOPOLDINA': 'SSS VILA LEOPOLDINA', 'SANTO SANTO SANTO OFICIAL': 'SSS RIO PRETO',
};

// A API entrega no maximo ~300 itens por pagina: avanca pelo tamanho real e so para em pagina vazia.
// onPage: processa cada pagina e descarta (economiza memoria; evita o erro 546 do Supabase).
// Uma pagina da VarejOnline com nova tentativa: erro 5xx/429 ou falha de rede tenta de novo (ate 4 vezes),
// pedindo paginas menores (1000 -> 300 -> 100), que a VarejOnline aguenta melhor em lojas grandes.
async function paginaVarejo(urlBase: string, token: string): Promise<any> {
  ({ url: urlBase, token } = await prepararChamada(urlBase, token)); // loja que divide o token: token real + entidades=
  const tamanhos = [1000, 300, 100, 100];
  let ultimo = '';
  for (let t = 0; t < tamanhos.length; t++) {
    if (t) await new Promise((ok) => setTimeout(ok, 800 * t + Math.random() * 400));
    let r: Response;
    try { r = await fetch(`${urlBase}&quantidade=${tamanhos[t]}&token=${token}`, { signal: AbortSignal.timeout(45000) }); }
    catch (e) { ultimo = `sem resposta (${String((e as Error)?.name ?? e)})`; continue; }
    if (r.ok) return await r.json();
    const caminho = urlBase.split('?')[0];
    if (r.status === 401 || r.status === 403) throw new Error(`VarejOnline recusou o token desta loja (${r.status}) — atualize o token em Lojas`);
    ultimo = `respondeu ${r.status} em ${caminho}`;
    if (r.status !== 429 && r.status < 500) break;
  }
  throw new Error(`VarejOnline ${ultimo}${ultimo.startsWith('respondeu 5') ? ' (instabilidade da VarejOnline; tentei 4 vezes)' : ''}`);
}

async function fetchAllPages(url: string, token: string, onPage?: (items: any[]) => void): Promise<any[]> {
  const { filtrar } = await prepararChamada(url, token); // descarta itens de outra unidade do mesmo token
  const out: any[] = [];
  let inicio = 0;
  let ultima = '';
  for (let n = 0; n < 100; n++) {
    const sep = url.includes('?') ? '&' : '?';
    const page = await paginaVarejo(`${url}${sep}inicio=${inicio}`, token);
    const items = Array.isArray(page) ? page : (page.items ?? page.dados ?? []);
    if (!items.length) break;
    const sig = JSON.stringify(items[0]).slice(0, 300);
    if (sig === ultima) break;
    ultima = sig;
    const daLoja = filtrar(items);
    if (onPage) onPage(daLoja); else out.push(...daLoja);
    inicio += items.length;
  }
  return out;
}

// Le as vendas em janelas de ~15 dias em paralelo (a paginacao da VarejOnline e sequencial e lenta em lojas grandes).
// As janelas se sobrepoem em 1 dia e as vendas repetidas sao descartadas pelo id.
// Vendas de um periodo: dias fechados vem do cache (vendas_cache_dias); ontem e hoje, da VarejOnline.
async function buscarSaidasParalelo(apiBase: string, token: string, dIni: Date, dFim: Date, onSaida: (sd: any) => void, janelaDias = 15, conc = 4) {
  await saidasComCache({ sb, buscarPaginas: fetchAllPages, apiBase, token, loja: lojaDaChave(token), dIni, dFim, onSaida, janelaDias, conc });
}

// { loja: chave } — a chave é o token; para lojas que dividem o token, token + nome (ver registrarLojas).
async function getLojasTokens(): Promise<Record<string, string>> {
  const { data, error } = await sb().from('lojas_config').select('nome, token, cnpj').eq('ativo', true);
  if (error) throw new Error(`Erro ao ler lojas_config: ${error.message}`);
  return registrarLojas(data ?? []);
}

// Busca os pedidos da Central dos ultimos nDias (a API devolve um dia por chamada).
let cacheCentral: { quando: number; dias: number; dados: any } | null = null;
// Guarda so os campos que o Mastermind usa (o pedido completo traz comentarios, arquivos e historico).
const compactarPedidoCentral = (p: any) => ({
  _id: p._id, codigo: p.codigo, dataCriacao: p.dataCriacao, dataPrevisao: p.dataPrevisao, updatedAt: p.updatedAt,
  tipoFrete: p.tipoFrete, formaPagamento: p.formaPagamento, observacaoEntrega: p.observacaoEntrega,
  fornecedor: p.fornecedor ? { id: p.fornecedor.id, nome: p.fornecedor.nome } : undefined,
  franqueado: p.franqueado ? { id: p.franqueado.id, nome: p.franqueado.nome } : undefined,
  situacao: p.situacao ? { status: p.situacao.status, descricao: p.situacao.descricao, isSituacaoFinal: p.situacao.isSituacaoFinal, isCancelamento: p.situacao.isCancelamento, dataAlteracao: p.situacao.dataAlteracao } : undefined,
  itensPedido: (p.itensPedido ?? []).map((i: any) => ({
    codigo: i.codigo, descricaoProduto: i.descricaoProduto, categoriaProduto: i.categoriaProduto, idProduto: i.idProduto, idFornecedor: i.idFornecedor,
    quantidadeProdutos: i.quantidadeProdutos, valorUnitario: i.valorUnitario, qtdMinima: i.qtdMinima, qtdMaxima: i.qtdMaxima, fatorConversao: i.fatorConversao,
    prazo: i.prazo, unidade: i.unidade, qtdSolicitadaInicio: i.qtdSolicitadaInicio, qtdCasasDecimais: i.qtdCasasDecimais, variacao: i.variacao,
  })),
});
type ResultadoCentral = { lista: any[]; falhas: number; erro?: string; pendentes?: number; semCache?: boolean };
async function buscarPedidosCentral(nDias: number, orcamentoMs = 70000): Promise<ResultadoCentral> {
  if (cacheCentral && Date.now() - cacheCentral.quando < 10 * 60000 && cacheCentral.dias >= nDias && !cacheCentral.dados.falhas && !cacheCentral.dados.pendentes) return cacheCentral.dados;
  const dados = await sincronizarCentralDias(nDias, orcamentoMs);
  if (!dados.erro) cacheCentral = { quando: Date.now(), dias: nDias, dados };
  return dados;
}

// ---- Cache persistente dos pedidos da Central (tabela central_cache_dias) ----
// A API da Central devolve um dia por chamada; buscar 120-180 dias a cada clique estourava o limite de
// 150 s do Supabase. Agora cada dia fica guardado e so e rebuscado quando "vence".
const TABELA_CACHE_CENTRAL = 'central_cache_dias';
const validadeDia = (idadeDias: number) => idadeDias <= 1 ? 5 * 60000 : idadeDias <= 20 ? 20 * 60000 : idadeDias <= 60 ? 6 * 3600000 : 24 * 3600000;
async function buscarDiaCentral(chave: string, dia: string): Promise<any[]> {
  const r = await fetch(`${CENTRAL}?periodo=${dia}`, { headers: { 'x-api-key': chave }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(String(r.status));
  const j: any = await r.json();
  return (Array.isArray(j) ? j : (j?.pedidos ?? [])).map(compactarPedidoCentral);
}
async function sincronizarCentralDias(nDias: number, orcamentoMs: number): Promise<ResultadoCentral> {
  const t0Central = Date.now();
  try { return await sincronizarCentralDiasInterno(nDias, orcamentoMs); } finally { medicao.centralMs += Date.now() - t0Central; }
}
async function sincronizarCentralDiasInterno(nDias: number, orcamentoMs: number): Promise<ResultadoCentral> {
  const chave = (Deno.env.get('PEDIDOS_API_KEY') ?? '').trim();
  if (!chave) return { lista: [], falhas: 0, erro: 'PEDIDOS_API_KEY nao configurada' };
  const t0 = Date.now();
  const hoje = new Date(); hoje.setUTCHours(0, 0, 0, 0);
  const dias = Array.from({ length: nDias }, (_, i) => new Date(hoje.getTime() - i * 86400000).toISOString().slice(0, 10));
  const porDia = new Map<string, any[]>();
  const vencidos: string[] = [], faltando: string[] = [];
  let semCache = false;
  const s = sb();
  const { data, error } = await s.from(TABELA_CACHE_CENTRAL).select('dia, pedidos, atualizado_em').gte('dia', dias[dias.length - 1]);
  if (error) semCache = true;
  const guardado = new Map<string, any>((data ?? []).map((r: any) => [String(r.dia).slice(0, 10), r]));
  dias.forEach((d, idade) => {
    const g = guardado.get(d);
    if (!g) { faltando.push(d); return; }
    porDia.set(d, g.pedidos ?? []);
    if (Date.now() - Date.parse(g.atualizado_em) > validadeDia(idade)) vencidos.push(d);
  });
  // primeiro os dias que faltam, depois os vencidos (mais recentes primeiro)
  const fila = [...faltando, ...vencidos];
  let falhas = 0;
  const novos: any[] = [];
  const naoBuscados = new Set(fila);
  for (let i = 0; i < fila.length; i += 12) {
    if (Date.now() - t0 > orcamentoMs) break;
    const lote = fila.slice(i, i + 12);
    const res = await Promise.allSettled(lote.map((d) => buscarDiaCentral(chave, d)));
    res.forEach((r, k) => {
      const d = lote[k];
      if (r.status === 'fulfilled') { porDia.set(d, r.value); novos.push({ dia: d, pedidos: r.value, total: r.value.length, atualizado_em: new Date().toISOString() }); naoBuscados.delete(d); }
      else falhas++;
    });
  }
  if (novos.length && !semCache) {
    for (let i = 0; i < novos.length; i += 20) await s.from(TABELA_CACHE_CENTRAL).upsert(novos.slice(i, i + 20), { onConflict: 'dia' });
  }
  const pendentes = faltando.filter((d) => naoBuscados.has(d)).length;
  const lista: any[] = [], vistos = new Set<string>();
  for (const d of dias) for (const p of porDia.get(d) ?? []) { const id = String(p._id ?? p.codigo); if (!vistos.has(id)) { vistos.add(id); lista.push(p); } }
  const avisos: string[] = [];
  if (pendentes) avisos.push(`${pendentes} dia(s) de pedidos da Central ainda nao carregados`);
  if (falhas) avisos.push(`${falhas} consulta(s) a Central falharam`);
  return { lista, falhas, pendentes, semCache, erro: avisos.length ? avisos.join('; ') : undefined };
}

// Pedidos da Central de um intervalo de dias (para análises longas, até ~13 meses, pedidas em trechos).
// Lê os dias guardados; busca na Central só os que faltam (e os recentes vencidos). Dias com mais de 60 dias
// já guardados não são rebuscados (pedido antigo quase não muda).
async function centralIntervalo(de: string, ate: string, orcamentoMs = 90000) {
  const chave = (Deno.env.get('PEDIDOS_API_KEY') ?? '').trim();
  if (!chave) return { lista: [] as any[], falhas: 0, pendentes: 0, erro: 'PEDIDOS_API_KEY nao configurada' };
  const t0 = Date.now(), hoje = new Date(); hoje.setUTCHours(0, 0, 0, 0);
  const dias: string[] = [];
  for (let t = Date.parse(ate + 'T00:00:00Z'); t >= Date.parse(de + 'T00:00:00Z'); t -= 86400000) dias.push(new Date(t).toISOString().slice(0, 10));
  const { data, error } = await sb().from(TABELA_CACHE_CENTRAL).select('dia, pedidos, atualizado_em').gte('dia', de).lte('dia', ate);
  const guardado = new Map<string, any>((error ? [] : data ?? []).map((r: any) => [String(r.dia).slice(0, 10), r]));
  const porDia = new Map<string, any[]>(), fila: string[] = [];
  for (const d of dias) {
    const g = guardado.get(d), idade = Math.round((hoje.getTime() - Date.parse(d + 'T00:00:00Z')) / 86400000);
    if (g) porDia.set(d, g.pedidos ?? []);
    if (!g || (idade <= 60 && Date.now() - Date.parse(g.atualizado_em) > validadeDia(idade))) fila.push(d);
  }
  let falhas = 0; const novos: any[] = [], naoBuscados = new Set(fila);
  for (let i = 0; i < fila.length; i += 12) {
    if (Date.now() - t0 > orcamentoMs) break;
    const lote = fila.slice(i, i + 12);
    const res = await Promise.allSettled(lote.map((d) => buscarDiaCentral(chave, d)));
    res.forEach((r, k) => { const d = lote[k]; if (r.status === 'fulfilled') { porDia.set(d, r.value); novos.push({ dia: d, pedidos: r.value, total: r.value.length, atualizado_em: new Date().toISOString() }); naoBuscados.delete(d); } else falhas++; });
  }
  if (novos.length && !error) for (let i = 0; i < novos.length; i += 20) await sb().from(TABELA_CACHE_CENTRAL).upsert(novos.slice(i, i + 20), { onConflict: 'dia' });
  const pendentes = dias.filter((d) => !guardado.has(d) && naoBuscados.has(d)).length;
  const lista: any[] = [], vistos = new Set<string>();
  for (const d of dias) for (const p of porDia.get(d) ?? []) { const id = String(p._id ?? p.codigo); if (!vistos.has(id)) { vistos.add(id); lista.push(p); } }
  return { lista, falhas, pendentes, erro: pendentes ? `${pendentes} dia(s) da Central ainda não carregados` : (falhas ? `${falhas} consulta(s) à Central falharam` : undefined) };
}

// =====================================================================
// PAINEL DO FORNECEDOR (franqueadora): o que as lojas compraram de cada fornecedor na Central num período,
// quanto venderam desses produtos, quanto isso pesa no faturamento e se compensa (com frete).
//   acao 'compras'    — uma chamada: pedidos da Central do período, por fornecedor × loja × código
//   acao 'vendasLoja' — uma chamada por loja: vendas do período ligadas ao fornecedor (vínculo / código / descrição,
//                       a mesma regra da tela Vínculos) + faturamento total da loja
//   acao 'frete' / 'salvarFrete' — frete estimado (% do valor do pedido) de cada fornecedor
// =====================================================================
const CHAVE_FRETE = 'frete_fornecedores', CHAVE_INSUMO = 'fornecedores_insumo', CHAVE_PACOTE = 'pacote_itens_central';
async function moduloFornecedores(body: any, a: Acesso) {
  const acao = String(body.acao ?? '');
  const isoOk = (x: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(x ?? ''));
  const hojeIso = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const desde = isoOk(body.desde) ? String(body.desde) : new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
  const ate = isoOk(body.ate) ? String(body.ate) : hojeIso;
  if (desde > ate) throw new Error('A data inicial é depois da data final.');

  if (acao === 'salvarInsumo') { // fornecedor de insumo (embalagem, material de loja): não entra na análise de venda
    const fid = String(body.fornecedorId ?? '').trim(); if (!fid) throw new Error('Fornecedor não informado.');
    const { data, error } = await sb().from('painel_cache').select('dados').eq('chave', CHAVE_INSUMO).maybeSingle();
    if (error) throw new Error('Rode antes o SQL 20261117000001_painel_cache.sql no Supabase.');
    const lista = new Set<string>(Array.isArray(data?.dados) ? data.dados : []);
    if (body.insumo) lista.add(fid); else lista.delete(fid);
    const r = await sb().from('painel_cache').upsert({ chave: CHAVE_INSUMO, dados: [...lista], atualizado_em: new Date().toISOString() }, { onConflict: 'chave' });
    if (r.error) throw new Error(r.error.message);
    return { ok: true, insumo: [...lista] };
  }
  if (acao === 'frete' || acao === 'salvarFrete') {
    const { data, error } = await sb().from('painel_cache').select('dados').eq('chave', CHAVE_FRETE).maybeSingle();
    if (error) throw new Error('Rode antes o SQL 20261117000001_painel_cache.sql no Supabase.');
    const atual: Record<string, number> = data?.dados ?? {};
    if (acao === 'frete') {
      const ins = await sb().from('painel_cache').select('dados').eq('chave', CHAVE_INSUMO).maybeSingle();
      const mf = await sb().from('painel_cache').select('dados').eq('chave', 'marcas_fornecedor').maybeSingle();
      const pc = await sb().from('painel_cache').select('dados').eq('chave', CHAVE_PACOTE).maybeSingle();
      return { frete: atual, insumo: Array.isArray(ins.data?.dados) ? ins.data.dados : [], marcasFornecedor: mf.data?.dados ?? {}, pacote: pc.data?.dados ?? {} };
    }
    const fid = String(body.fornecedorId ?? '').trim();
    if (!fid) throw new Error('Fornecedor não informado.');
    const v = body.percentual === null || body.percentual === '' ? null : Number(body.percentual);
    if (v != null && (!Number.isFinite(v) || v < 0 || v > 100)) throw new Error('Frete deve ser um percentual entre 0 e 100.');
    if (v == null) delete atual[fid]; else atual[fid] = Math.round(v * 100) / 100;
    const r = await sb().from('painel_cache').upsert({ chave: CHAVE_FRETE, dados: atual, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' });
    if (r.error) throw new Error(r.error.message);
    return { ok: true, frete: atual };
  }

  // Item da Central comprado em pacote/caixa e vendido em unidades na loja (ex.: SANTITAS PACK = 27 unidades).
  // { "ST-PACK": 27 } — vale para a rede inteira; a tela de fornecedores multiplica a compra e divide o custo.
  if (acao === 'salvarPacote') {
    const codigo = codNorm(body.codigo);
    if (!codigo) throw new Error('Código da Central não informado.');
    const n = body.unidades === null || body.unidades === '' ? null : Number(body.unidades);
    if (n != null && (!Number.isInteger(n) || n < 1 || n > 10000)) throw new Error('Informe um número inteiro de unidades (1 a 10.000).');
    const { data, error } = await sb().from('painel_cache').select('dados').eq('chave', CHAVE_PACOTE).maybeSingle();
    if (error) throw new Error(error.message);
    const atual: Record<string, number> = data?.dados ?? {};
    if (n == null || n === 1) delete atual[codigo]; else atual[codigo] = n;
    const r = await sb().from('painel_cache').upsert({ chave: CHAVE_PACOTE, dados: atual, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' });
    if (r.error) throw new Error(r.error.message);
    return { ok: true, pacote: atual };
  }

  if (acao === 'compras') {
    const diasAtras = Math.ceil((Date.now() - Date.parse(desde + 'T12:00:00Z')) / 86400_000) + 1;
    if (diasAtras > 400) throw new Error('A análise vai até 13 meses atrás. Escolha uma data inicial mais recente.');
    const dur = (Date.parse(ate) - Date.parse(desde)) / 86400_000;
    // trechos curtos (o painel pede de mês em mês): lê só esses dias; senão, o atalho dos últimos N dias
    const base: any = dur <= 62 ? await centralIntervalo(desde, ate) : await buscarPedidosCentral(Math.max(1, diasAtras));
    const tokens = await getLojasTokens();
    const permitidas = lojasDoAcesso(a, undefined);
    const nomePainel = new Map(Object.keys(tokens).map((n) => [normLoja(n), n]));
    const forn = new Map<string, any>();
    let foraDoPainel = 0;
    for (const p of base.lista) {
      const t = Date.parse(String(p.dataCriacao ?? '')); if (!Number.isFinite(t)) continue;
      const dia = diaBR(new Date(t).toISOString());
      if ( dia < desde || dia > ate) continue;
      const fid = String(p.fornecedor?.id ?? ''); if (!fid) continue;
      const loja = nomePainel.get(lojaDoPedido(p));
      if (!loja) { foraDoPainel++; continue; }
      if (permitidas && !permitidas.includes(loja)) continue;
      const f = forn.get(fid) ?? { id: fid, nome: p.fornecedor?.nome ?? fid, pedidos: 0, cancelados: 0, valor: 0, pecas: 0, primeira: dia, ultima: dia, lojas: {} as Record<string, any>, itens: {} as Record<string, any> };
      forn.set(fid, f);
      if (ehCancelado(p)) { f.cancelados++; continue; }
      f.pedidos++; if (dia < f.primeira) f.primeira = dia; if (dia > f.ultima) f.ultima = dia;
      const L = f.lojas[loja] ?? (f.lojas[loja] = { pedidos: 0, valor: 0, pecas: 0, ultima: dia });
      L.pedidos++; if (dia > L.ultima) L.ultima = dia;
      for (const i of p.itensPedido ?? []) {
        const q = Number(i.quantidadeProdutos ?? 0), v = q * Number(i.valorUnitario ?? 0);
        f.valor += v; f.pecas += q; L.valor += v; L.pecas += q;
        const c = codNorm(i.codigo); if (!c) continue;
        const it = f.itens[c] ?? (f.itens[c] = { codigo: String(i.codigo).trim(), descricao: i.descricaoProduto ?? '', pecas: 0, valor: 0, lojas: {} as Record<string, number> });
        it.pecas += q; it.valor += v; it.lojas[loja] = (it.lojas[loja] ?? 0) + q;
      }
    }
    const lista = [...forn.values()].map((f) => ({ ...f, valor: r2(f.valor), pecas: r2(f.pecas),
      lojas: Object.fromEntries(Object.entries(f.lojas).map(([k, v]: any) => [k, { ...v, valor: r2(v.valor), pecas: r2(v.pecas) }])),
      itens: Object.values(f.itens).map((it: any) => ({ ...it, valor: r2(it.valor), pecas: r2(it.pecas) })) }));
    return { desde, ate, fornecedores: lista, centralIncompleta: !!(base.falhas || base.pendentes || base.erro), pendentes: base.pendentes ?? 0, aviso: base.erro ?? null, pedidosForaDoPainel: foraDoPainel };
  }

  // Vendas de uma loja num trecho de datas (o painel pede em trechos de até 31 dias para não passar do limite de CPU),
  // somadas por produto: [produtoId, descricao, codigoSistema, codigoInterno, qtd, faturamento, custo]
  if (acao === 'vendasLoja') {
    const loja = String(body.loja ?? '');
    const tokens = await getLojasTokens();
    if (!tokens[loja]) throw new Error('Loja inválida.');
    const de = isoOk(body.de) ? String(body.de) : desde, atePer = isoOk(body.ateVendas) ? String(body.ateVendas) : hojeIso;
    const ini = new Date(de + 'T12:00:00Z'), fim = new Date(atePer + 'T12:00:00Z');
    if (fim < ini) throw new Error('O fim das vendas é antes do início.');
    if ((fim.getTime() - ini.getTime()) / 86400_000 > 62) throw new Error('Peça as vendas em trechos de até 62 dias.');
    const agg = new Map<string, any[]>();
    let faturamento = 0, pecasLoja = 0, custoLoja = 0;
    await buscarSaidasParalelo(Deno.env.get('VAREJONLINE_API_BASE')!, tokens[loja], ini, fim, (sd) => {
      if (!ehVenda(sd)) return;
      for (const it of sd.mercadorias ?? []) {
        const pr = it.produto; if (!pr) continue;
        const q = Number(it.quantidade ?? 0), v = Number(it.valorTotal ?? 0), c = Number(it.valorCusto ?? 0);
        faturamento += v; pecasLoja += q; custoLoja += c;
        const k = String(pr.id);
        let x = agg.get(k); if (!x) { x = [pr.id, pr.descricao ?? '', pr.codigoSistema ?? null, pr.codigoInterno ?? null, 0, 0, 0]; agg.set(k, x); }
        x[4] += q; x[5] += v; x[6] += c;
      }
    });
    return { loja, de, ate: atePer, faturamento: r2(faturamento), pecas: r2(pecasLoja), custo: r2(custoLoja),
      produtos: [...agg.values()].map((x) => [x[0], x[1], x[2], x[3], r2(x[4]), r2(x[5]), r2(x[6])]) };
  }
  // MARCA de cada produto (categoria de nível MARCA no cadastro da VarejOnline), guardada para a rede em
  // painel_cache (chave marcas_rede: chave do produto → marca). Entrada: itens [[chave, loja, produtoId]];
  // busca no cadastro só o que ainda não está guardado, em lotes de 50, com limite de tempo.
  if (acao === 'marcas') {
    const itens: any[] = Array.isArray(body.itens) ? body.itens.slice(0, 3000) : [];
    const { data, error } = await sb().from('painel_cache').select('dados').eq('chave', 'marcas_rede').maybeSingle();
    if (error) throw new Error('Rode antes o SQL 20261117000001_painel_cache.sql no Supabase.');
    const guardado: Record<string, string> = data?.dados ?? {};
    const faltam = itens.filter(([k]) => !(k in guardado));
    const tokens = await getLojasTokens(), apiBase = Deno.env.get('VAREJONLINE_API_BASE')!;
    const porLoja = new Map<string, any[]>();
    for (const it of faltam) { if (!tokens[it[1]]) continue; if (!porLoja.has(it[1])) porLoja.set(it[1], []); porLoja.get(it[1])!.push(it); }
    const lotes: { loja: string; itens: any[] }[] = [];
    for (const [loja, l] of porLoja) for (let i = 0; i < l.length; i += 50) lotes.push({ loja, itens: l.slice(i, i + 50) });
    const t0 = Date.now(); let feitos = 0, novos = 0, j = 0;
    await Promise.all(Array.from({ length: Math.min(4, lotes.length) }, async () => {
      while (j < lotes.length) {
        if (Date.now() - t0 > 55_000) return;
        const lote = lotes[j++];
        const porId = new Map(lote.itens.map((x) => [String(x[2]), x[0]]));
        try {
          await fetchAllPages(`${apiBase}/produtos?idsProdutos=${[...porId.keys()].join(',')}`, tokens[lote.loja], (pg) => {
            for (const p of pg) { const k = porId.get(String(p.id)); if (!k) continue; const mc = (p.categorias ?? []).find((c: any) => c?.nivel === 'MARCA'); guardado[k] = String(mc?.nome ?? '').trim(); novos++; }
          });
          for (const k of porId.values()) if (!(k in guardado)) { guardado[k] = ''; novos++; } // produto sem cadastro: não pede de novo
          feitos++;
        } catch { /* tenta na próxima chamada */ }
      }
    }));
    if (novos) await sb().from('painel_cache').upsert({ chave: 'marcas_rede', dados: guardado, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' });
    const marcas: Record<string, string> = {}; let pendentes = 0;
    for (const [k] of itens) { if (k in guardado) marcas[k] = guardado[k]; else pendentes++; }
    return { marcas, pendentes };
  }
  // Marcas conhecidas (do cadastro já lido) e as marcas que a franqueadora ligou a cada fornecedor
  if (acao === 'listaMarcas') {
    const { data } = await sb().from('painel_cache').select('dados').eq('chave', 'marcas_rede').maybeSingle();
    const cont: Record<string, number> = {};
    for (const m of Object.values(data?.dados ?? {}) as string[]) if (m) cont[m] = (cont[m] ?? 0) + 1;
    return { marcas: Object.entries(cont).sort((a, b) => b[1] - a[1]).map(([marca, produtos]) => ({ marca, produtos })) };
  }
  if (acao === 'salvarMarcas') {
    const fid = String(body.fornecedorId ?? '').trim(); if (!fid) throw new Error('Fornecedor não informado.');
    const marcas = (Array.isArray(body.marcas) ? body.marcas : []).map((x: any) => String(x).trim().toUpperCase()).filter(Boolean).slice(0, 20);
    const { data, error } = await sb().from('painel_cache').select('dados').eq('chave', 'marcas_fornecedor').maybeSingle();
    if (error) throw new Error(error.message);
    const atual: Record<string, string[]> = data?.dados ?? {};
    if (marcas.length) atual[fid] = marcas; else delete atual[fid];
    const r = await sb().from('painel_cache').upsert({ chave: 'marcas_fornecedor', dados: atual, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' });
    if (r.error) throw new Error(r.error.message);
    return { ok: true, marcasFornecedor: atual };
  }
  // Cadastro completo de alguns produtos na VarejOnline (para conferir marca, fornecedor, classificação)
  if (acao === 'cadastroProdutos') {
    const loja = String(body.loja ?? ''); const tokens = await getLojasTokens();
    if (!tokens[loja]) throw new Error('Loja inválida.');
    const ids = (Array.isArray(body.ids) ? body.ids : []).map((x: any) => String(x)).filter((x: string) => /^\d+$/.test(x)).slice(0, 50);
    const out: any[] = [];
    if (ids.length) await fetchAllPages(`${Deno.env.get('VAREJONLINE_API_BASE')}/produtos?idsProdutos=${ids.join(',')}`, tokens[loja], (pg) => { out.push(...pg); });
    return { produtos: out };
  }
  // Liga os produtos vendidos de uma loja ao item/fornecedor da Central (mesma regra da tela Vínculos)
  // entrada: produtos [[produtoId, descricao, codigoSistema, codigoInterno]]; saída: produtoId → [fornecedorId, nome, códigoCentral, descrição, via] | 'ignorado' | null
  // Estoque atual de uma loja (saldo da VarejOnline, todas as entidades), só produtos com saldo positivo:
  // [produtoId, codigoSistema, codigoInterno, quantidade]. A tela liga ao fornecedor e valoriza pelo custo da Central.
  if (acao === 'estoqueLoja') {
    const loja = String(body.loja ?? '');
    const tokens = await getLojasTokens();
    if (!tokens[loja]) throw new Error('Loja inválida.');
    const saldos: any[] = await saldosComCache(fetchAllPages, `${Deno.env.get('VAREJONLINE_API_BASE')!}/saldos-mercadorias`, tokens[loja], () => {});
    const agg = new Map<string, any[]>();
    for (const sl of saldos) {
      const id = sl.produto?.id; if (id == null) continue;
      const k = String(id), q = Number(sl.quantidade ?? 0);
      const cur = agg.get(k) ?? [id, sl.produto?.codigoSistema ?? null, sl.produto?.codigoInterno ?? null, 0];
      cur[3] += q; agg.set(k, cur);
    }
    return { loja, produtos: [...agg.values()].filter((x) => x[3] > 0).map((x) => [x[0], x[1], x[2], r2(x[3])]) };
  }

  if (acao === 'mapearLoja') {
    const loja = String(body.loja ?? '');
    const lista: any[] = Array.isArray(body.produtos) ? body.produtos.slice(0, 6000) : [];
    const { idx } = await catalogoIndexado();
    const vinc = await carregarVinculosLoja(loja);
    const mapa: Record<string, any> = {};
    for (const [produtoId, descricao, codigoSistema, codigoInterno] of lista) {
      const m = casarProduto({ produtoId, descricao, codigoSistema, codigoInterno }, idx, vinc);
      if (m.via === 'ignorado') { mapa[produtoId] = 'ignorado'; continue; }
      const it = m.item;
      mapa[produtoId] = it?.fornecedorId ? [it.fornecedorId, it.fornecedorNome ?? '', String(it.codigo ?? '').trim(), it.descricao ?? '', m.via.startsWith('vínculo') ? 'vinculo' : m.via, Number(it.preco) || null] : null;
    }
    return { loja, mapa };
  }
  throw new Error('Ação desconhecida no painel de fornecedores.');
}

async function moduloSincronizarCentral(body: any) {
  const dias = Math.min(180, Math.max(1, Number(body.dias ?? 180)));
  const r = await sincronizarCentralDias(dias, 100000);
  cacheCentral = null;
  return { dias, pendentes: r.pendentes ?? 0, falhas: r.falhas, semCache: !!r.semCache, pedidos: r.lista.length };
}

async function buscarPedidosCentralSemCache(nDias: number, completo = false): Promise<{ lista: any[]; falhas: number; erro?: string }> {
  const chave = (Deno.env.get('PEDIDOS_API_KEY') ?? '').trim();
  if (!chave) return { lista: [], falhas: 0, erro: 'PEDIDOS_API_KEY nao configurada' };
  const agora = Date.now();
  const dias = Array.from({ length: nDias }, (_, i) => new Date(agora - i * 86400000).toISOString().slice(0, 10));
  const lista: any[] = [];
  const vistos = new Set<string>();
  let falhas = 0;
  for (let i = 0; i < dias.length; i += 12) {
    const res = await Promise.allSettled(dias.slice(i, i + 12).map(async (d) => {
      const r = await fetch(`${CENTRAL}?periodo=${d}`, { headers: { 'x-api-key': chave }, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error(String(r.status));
      const j: any = await r.json();
      return Array.isArray(j) ? j : (j?.pedidos ?? []);
    }));
    for (const r of res) {
      if (r.status !== 'fulfilled') { falhas++; continue; }
      for (const p of r.value) { const id = String(p._id ?? p.codigo); if (!vistos.has(id)) { vistos.add(id); lista.push(completo ? p : compactarPedidoCentral(p)); } }
    }
  }
  return { lista, falhas, erro: falhas ? `${falhas} dia(s) de pedidos da Central falharam` : undefined };
}

const ehCancelado = (p: any) => p.situacao?.isCancelamento === true || String(p.situacao?.status) === 'cancelado';
const ehFinal = (p: any) => p.situacao?.isSituacaoFinal === true || ehCancelado(p) || FINAIS.has(String(p.situacao?.status));
const lojaDoPedido = (p: any) => { const nome = String(p.franqueado?.nome ?? ''); return normLoja(OVERRIDES[normLoja(nome)] ?? nome); };

// Pedidos da Central em andamento (tudo que nao e situacao final nem cancelamento), agrupados pela loja do painel.
async function pedidosEmAndamento(listaPronta?: { lista: any[]; falhas: number; erro?: string }) {
  const porLoja = new Map<string, any[]>();
  const base = listaPronta ?? await buscarPedidosCentral(120);
  const agora = Date.now();
  let total = 0;
  for (const p of base.lista) {
    if (ehFinal(p)) continue;
    const alt = Date.parse(String(p.situacao?.dataAlteracao ?? p.updatedAt ?? p.dataCriacao));
    if (Number.isFinite(alt) && agora - alt > DIAS_PARADO * 86400000) continue;
    if (ehEnviado(p) && Number.isFinite(alt) && agora - alt > DIAS_ENVIADO * 86400000) continue;
    const k = lojaDoPedido(p);
    if (!porLoja.has(k)) porLoja.set(k, []);
    porLoja.get(k)!.push(p);
    total++;
  }
  // cor (sem tamanho) de cada item, pelo nome ORIGINAL da variacao (a chave perde os parenteses)
  const idVar = criarIdentificadorVariacao(base.lista);
  const cbPorChave = new Map<string, string>();
  for (const p of base.lista) for (const i of p.itensPedido ?? []) cbPorChave.set(idVar(i).chave, corBase(i.variacao?.descricao ?? ''));
  return { porLoja, total, erro: base.erro, idVar, cbPorChave };
}

async function carregarVinculos() {
  const mapa = new Map<string, Map<string, any>>();
  const { data, error } = await lerTudo('pedidos_vinculos', 'loja, codigo_central, produto_id, ignorar', 'produto_id');
  if (error) return { mapa, aviso: `Vinculos nao carregados: ${error.message}` as string | undefined };
  for (const r of data ?? []) {
    if (!mapa.has(r.loja)) mapa.set(r.loja, new Map());
    mapa.get(r.loja)!.set(r.codigo_central, r);
  }
  return { mapa, aviso: undefined as string | undefined };
}

const enxutoSaldo = (sl: any) => ({ quantidade: sl.quantidade, entidade: sl.entidade ? { id: sl.entidade.id, nome: sl.entidade.nome } : undefined,
  produto: sl.produto ? { id: sl.produto.id, codigoSistema: sl.produto.codigoSistema, codigoInterno: sl.produto.codigoInterno, codigoBarras: sl.produto.codigoBarras } : undefined });

// Pedidos aprovados no Insight que ainda não viraram pedido na Central (últimos 15 dias). Cache curto por chamada.
let _aprovados: { quando: number; p: Promise<any[]> } | null = null;
function aprovadosNaoLancados(): Promise<any[]> {
  if (_aprovados && Date.now() - _aprovados.quando < 20_000) return _aprovados.p;
  const desde = new Date(Date.now() - 15 * 86400_000).toISOString();
  const p = (async () => { try { const { data } = await sb().from('pedidos_sugeridos').select('id, loja, status, itens, criado_em, fornecedor_nome').in('status', ['aprovado', 'enviando', 'erro_envio']).gte('criado_em', desde); return data ?? []; } catch { return []; } })();
  _aprovados = { quando: Date.now(), p };
  return p;
}

async function moduloRecorrente(apiBase: string, lojasTokens: Record<string, string>, body: any, listaCentral?: { lista: any[]; falhas: number; erro?: string }) {
  const diasHistorico = Number(body.diasHistorico ?? 90);
  const diasPeriodoAlvo = Number(body.diasPeriodoAlvo ?? 30);
  const percentCrescimento = Number(body.percentCrescimento ?? 0);
  const diasSeguranca = Number(body.diasSeguranca ?? 7);
  const multiplicar = body.multiplicarPorFator === true; // quantidadeProdutos x fatorConversao (confirmar na Central)
  const fator = 1 + percentCrescimento / 100;
  const filtro: string[] | null = body.lojas ?? null;
  const nomes = filtro && filtro.length ? filtro.filter((n) => lojasTokens[n]) : Object.keys(lojasTokens);

  const hoje = new Date();
  const ini = new Date(hoje);
  ini.setDate(ini.getDate() - diasHistorico);
  const desde = fmtBR(ini);
  const ate = fmtBR(hoje);

  const [andamento, vinc] = await Promise.all([pedidosEmAndamento(listaCentral), carregarVinculos()]);
  const vincRede = new Map<string, any>();
  {
    let r: any = await lerTudo(TABELA_VINCULOS, 'produto_chave, chave_central, codigo_central, variacao, ignorar, grade, chaves_grade, descricao_central', 'produto_chave');
    if (r.error) r = await lerTudo(TABELA_VINCULOS, 'produto_chave, chave_central, codigo_central, variacao, ignorar, grade, descricao_central', 'produto_chave');
    if (r.error) r = await lerTudo(TABELA_VINCULOS, 'produto_chave, chave_central, codigo_central, variacao, ignorar, descricao_central', 'produto_chave');
    const data = r.data;
    for (const v of data ?? []) vincRede.set(String(v.produto_chave), v);
  }
  // fornecedor de cada produto: pelo vínculo com o item da Central (catálogo fixo)
  const fornFixo = { porChave: new Map<string, string>(), porCodigo: new Map<string, string>() };
  try {
    for (const it of await carregarCatalogoFixo()) {
      if (!it.fornecedor_nome) continue;
      fornFixo.porChave.set(String(it.chave), it.fornecedor_nome);
      const cn = codNorm(it.codigo); if (!fornFixo.porCodigo.has(cn)) fornFixo.porCodigo.set(cn, it.fornecedor_nome);
    }
  } catch { /* sem catálogo: fica sem fornecedor */ }

  async function processar(nomeLoja: string): Promise<any> {
    const token = lojasTokens[nomeLoja];
    let saidas: any[] = [];
    let saldos: any[] = [];
    try {
      const enxuta = (sd: any) => ({ cancelado: sd.cancelado, tipoSaida: sd.tipoSaida, entidade: sd.entidade ? { id: sd.entidade.id, nome: sd.entidade.nome } : undefined, entidadeId: sd.entidadeId,
        mercadorias: (sd.mercadorias ?? []).map((it: any) => ({ produto: it.produto ? { id: it.produto.id, descricao: it.produto.descricao, codigoSistema: it.produto.codigoSistema } : null, quantidade: it.quantidade, valorCusto: it.valorCusto, valorTotal: it.valorTotal })) });
      [, saldos] = await Promise.all([
        buscarSaidasParalelo(apiBase, token, ini, hoje, (sd) => { saidas.push(enxuta(sd)); }),
        saldosComCache(fetchAllPages, `${apiBase}/saldos-mercadorias`, token, (pg) => { for (const sl of pg) saldos.push(enxutoSaldo(sl)); })]);
    } catch (e) {
      return { nomeLoja, erro: String(e), totalProdutosAnalisados: 0, valorTotalEstimadoCompra: 0, recomendacoes: [] };
    }

    const venda = new Map<string, any>();
    for (const s of saidas) {
      if (s.cancelado) continue;
      if (s.tipoSaida && s.tipoSaida !== 'PEDIDO_VENDA') continue;
      for (const it of s.mercadorias ?? []) {
        const p = it.produto;
        if (!p) continue;
        const k = String(p.id);
        const cur = venda.get(k) ?? { produtoId: p.id, descricao: p.descricao, codigoSistema: p.codigoSistema, qtd: 0, custo: 0, receita: 0 };
        cur.qtd += Number(it.quantidade ?? 0);
        cur.custo += Number(it.valorCusto ?? 0);
        cur.receita += Number(it.valorTotal ?? 0);
        venda.set(k, cur);
      }
    }
    // ---- Estoque da unidade ----
    // Unidades (entidades) que de fato venderam no periodo = a loja.
    const entVenda = new Map<string, { id: string; nome: string; vendas: number }>();
    for (const sd of saidas) {
      const e = sd.entidade ?? (sd.entidadeId != null ? { id: sd.entidadeId } : null);
      if (e?.id == null) continue;
      const k = String(e.id);
      const cur = entVenda.get(k) ?? { id: k, nome: e.nome ?? '', vendas: 0 };
      cur.vendas++; entVenda.set(k, cur);
    }
    const linhasSemFiltro = saldos.length;
    let consultaComEntidade = false;
    // Algumas contas devolvem lista vazia sem o parametro "entidades": refaz informando a unidade.
    if (!saldos.length && entVenda.size) {
      try { await saldosComCache(fetchAllPages, `${apiBase}/saldos-mercadorias?entidades=${[...entVenda.keys()].join(',')}`, token, (pg) => { for (const sl of pg) saldos.push(enxutoSaldo(sl)); }); consultaComEntidade = true; }
      catch (e) { /* segue sem estoque; aparece no diagnostico */ }
    }
    // Se o token enxerga varias unidades (loja + deposito...), fica so com a(s) que venderam.
    const entSaldo = new Map<string, { id: string; nome: string; linhas: number; total: number }>();
    for (const sl of saldos) {
      const k = String(sl.entidade?.id ?? '?');
      const cur = entSaldo.get(k) ?? { id: k, nome: sl.entidade?.nome ?? '', linhas: 0, total: 0 };
      cur.linhas++; cur.total += Number(sl.quantidade ?? 0); entSaldo.set(k, cur);
    }
    let filtrouEntidade = false;
    if (entSaldo.size > 1 && entVenda.size && [...entVenda.keys()].some((k) => entSaldo.has(k))) {
      saldos = saldos.filter((sl) => entVenda.has(String(sl.entidade?.id)));
      filtrouEntidade = true;
    }
    const estoque = new Map<string, number>();
    const estoquePorCodigo = new Map<string, number>();
    const internos = new Map<string, string>();
    for (const sl of saldos) {
      const id = sl.produto?.id;
      const q = Number(sl.quantidade ?? 0);
      if (id != null) estoque.set(String(id), (estoque.get(String(id)) ?? 0) + q);
      for (const c of [sl.produto?.codigoSistema, sl.produto?.codigoInterno, sl.produto?.codigoBarras]) {
        if (c) estoquePorCodigo.set(codNorm(c), (estoquePorCodigo.get(codNorm(c)) ?? 0) + q);
      }
      if (id != null && sl.produto?.codigoInterno) internos.set(String(id), sl.produto.codigoInterno);
    }
    // Estoque do produto: pelo id; se o id nao bater, pelo codigo do sistema.
    let porId = 0, porCod = 0, semSaldo = 0;
    const estoqueDe = (k: string, agg: any) => {
      if (estoque.has(k)) { porId++; return estoque.get(k)!; }
      const c = agg.codigoSistema ? codNorm(agg.codigoSistema) : '';
      if (c && estoquePorCodigo.has(c)) { porCod++; return estoquePorCodigo.get(c)!; }
      semSaldo++; return 0;
    };

    // Indices dos produtos que venderam (so eles geram linha de recomendacao).
    const porCodigo = new Map<string, string>();
    const porNome = new Map<string, string>();
    const toks: { id: string; t: Set<string> }[] = [];
    for (const [k, v] of venda) {
      if (v.codigoSistema) porCodigo.set(codNorm(v.codigoSistema), k);
      const ci = internos.get(k);
      if (ci) porCodigo.set(codNorm(ci), k);
      porNome.set(limpa(v.descricao), k);
      toks.push({ id: k, t: tokens(v.descricao) });
    }

    // Itens dos pedidos em andamento desta loja, somados por codigo da Central.
    const pedidos = andamento.porLoja.get(normLoja(nomeLoja)) ?? [];
    const itens = new Map<string, any>();
    for (const p of pedidos) {
      for (const i of p.itensPedido ?? []) {
        const c = codNorm(i.codigo);
        if (!c) continue;
        const f = multiplicar ? (Number(i.fatorConversao ?? 1) || 1) : 1;
        const q = Number(i.quantidadeProdutos ?? 0) * f;
        const ch = andamento.idVar(i).chave;
        const cur = itens.get(ch) ?? { cod: c, chave: ch, codigoCentral: String(i.codigo).trim(), descricao: i.descricaoProduto, forn: p.fornecedor?.nome ?? '', qtd: 0, pedidos: [] };
        cur.qtd += q;
        cur.pedidos.push({ pedido: p.codigo, situacao: p.situacao?.descricao, quantidade: q, criadoEm: p.dataCriacao, desde: p.situacao?.dataAlteracao ?? null });
        itens.set(ch, cur);
      }
    }

    const vl = vinc.mapa.get(nomeLoja) ?? new Map<string, any>();
    const andamentoProd = new Map<string, { qtd: number; pedidos: any[] }>();
    const revisao: any[] = [], semLigacao: any[] = [];
    let vinculados = 0, ignorados = 0, semVenda = 0;
    // vinculos exatos (produto -> codigo+variacao) desta loja, invertidos: item da Central -> produto
    const exatos = new Map<string, string[]>();
    const porGrade = new Map<string, string[]>();
    for (const [prod, vd] of venda) {
      const v = vincRede.get(chaveProduto({ codigoSistema: vd.codigoSistema, produtoId: prod }));
      if (v && !v.ignorar && v.chave_central) {
        if (!exatos.has(v.chave_central)) exatos.set(v.chave_central, []); exatos.get(v.chave_central)!.push(prod);
        // itens extras escolhidos à mão (vários tamanhos/cores): pedido de qualquer um deles é deste produto
        for (const ch of Array.isArray(v.chaves_grade) ? v.chaves_grade : []) {
          if (!exatos.has(ch)) exatos.set(ch, []); if (!exatos.get(ch)!.includes(prod)) exatos.get(ch)!.push(prod);
          const cvx = `CV:${codVar(String(ch).split('|')[0], String(ch).split('|')[1] ?? '')}`; if (!exatos.has(cvx)) exatos.set(cvx, []); if (!exatos.get(cvx)!.includes(prod)) exatos.get(cvx)!.push(prod);
        }
        const cv = `CV:${codVar(v.codigo_central ?? String(v.chave_central).split('|')[0], v.variacao ?? String(v.chave_central).split('|')[1])}`;
        if (!exatos.has(cv)) exatos.set(cv, []); if (!exatos.get(cv)!.includes(prod)) exatos.get(cv)!.push(prod);
        // vinculo a grade: qualquer tamanho do mesmo codigo e cor e deste produto
        if (v.grade) {
          const kg = `${String(v.chave_central).split('|')[0]}|${andamento.cbPorChave.get(v.chave_central) ?? corBaseDaChave(v.chave_central)}`; if (!porGrade.has(kg)) porGrade.set(kg, []); porGrade.get(kg)!.push(prod);
          // familia por letra (A-Z, cada letra com codigo proprio): pedido de qualquer letra e deste produto
          const kl = chaveFamiliaLetra(v.descricao_central, String(v.chave_central).split('|')[1]); if (kl) { if (!porGrade.has(kl)) porGrade.set(kl, []); if (!porGrade.get(kl)!.includes(prod)) porGrade.get(kl)!.push(prod); }
          // letras como variacao do mesmo codigo (A, B, ... Z): pedido de qualquer letra
          { const tcv = tamanhoDoCodigo(String(v.chave_central).split('|')[0]); if (tcv) { const kt = `TC:${tcv.base}|${varNorm(String(v.chave_central).split('|')[1] ?? '')}`; if (!porGrade.has(kt)) porGrade.set(kt, []); if (!porGrade.get(kt)!.includes(prod)) porGrade.get(kt)!.push(prod); } }
          { const kq = `${String(v.chave_central).split('|')[0]}|**`; if (!porGrade.has(kq)) porGrade.set(kq, []); if (!porGrade.get(kq)!.includes(prod)) porGrade.get(kq)!.push(prod); } // grade de cores
          if (/^[A-Z]( |$)/.test(String(v.chave_central).split('|')[1] ?? '')) { const kc = `${String(v.chave_central).split('|')[0]}|*`; if (!porGrade.has(kc)) porGrade.set(kc, []); if (!porGrade.get(kc)!.includes(prod)) porGrade.get(kc)!.push(prod); }
        }
      }
    }
    for (const it of itens.values()) {
      const v = vl.get(it.cod);
      const kl = chaveFamiliaLetra(it.descricao, String(it.chave).split('|')[1]);
      const varIt = String(it.chave).split('|')[1] ?? '';
      const ex = exatos.get(it.chave) ?? exatos.get(`CV:${codVar(it.cod, varIt)}`) ?? (/^[A-Z]( |$)/.test(varIt) ? porGrade.get(`${String(it.chave).split('|')[0]}|*`) : undefined) ?? porGrade.get(`${String(it.chave).split('|')[0]}|${andamento.cbPorChave.get(it.chave) ?? corBaseDaChave(it.chave)}`) ?? (kl ? porGrade.get(kl) : undefined) ?? (() => { const t = tamanhoDoCodigo(it.codigoCentral ?? String(it.chave).split('|')[0]); return t ? porGrade.get(`TC:${t.base}|${varNorm(String(it.chave).split('|')[1] ?? '')}`) : undefined; })()
        ?? (!fornecedorTemGrade(it.forn) ? porGrade.get(`${String(it.chave).split('|')[0]}|**`) : undefined);
      if (!ex && v?.ignorar) { ignorados++; continue; }
      let pid: string | null = null;
      if (ex?.length === 1) pid = ex[0];
      else if (v?.produto_id != null) pid = String(v.produto_id);
      else if (porCodigo.has(it.cod)) pid = porCodigo.get(it.cod)!;
      else if (porNome.has(limpa(it.descricao))) pid = porNome.get(limpa(it.descricao))!;
      if (pid) {
        if (!venda.has(pid)) { semVenda++; continue; }
        const cur = andamentoProd.get(pid) ?? { qtd: 0, pedidos: [] };
        cur.qtd += it.qtd;
        cur.pedidos.push(...it.pedidos);
        andamentoProd.set(pid, cur);
        vinculados++;
      } else {
        // Sem vinculo seguro: so sugere (nao desconta) quando ha candidato parecido entre os produtos que venderam.
        const tc = tokens(it.descricao);
        const cands = toks.map((x) => ({ id: x.id, sc: jaccard(tc, x.t) })).filter((x) => x.sc >= 0.6).sort((a, b) => b.sc - a.sc).slice(0, 3);
        if (!cands.length) semLigacao.push({ codigoCentral: it.codigoCentral, descricaoCentral: it.descricao, quantidade: it.qtd, fornecedor: it.forn, pedidos: it.pedidos.slice(0, 2) });
        if (cands.length) {
          revisao.push({
            codigoCentral: it.codigoCentral, descricaoCentral: it.descricao, quantidade: it.qtd, pedidos: it.pedidos.slice(0, 3),
            candidatos: cands.map((c) => ({ produtoId: venda.get(c.id).produtoId, descricao: venda.get(c.id).descricao, codigoSistema: venda.get(c.id).codigoSistema, similaridade: Math.round(c.sc * 100) / 100 })),
          });
        }
      }
    }
    // Pedidos aprovados no Insight e ainda não lançados na Central também contam como "em andamento"
    // (senão o pedido seguinte sugere de novo o que já foi aprovado).
    for (const pa of (await aprovadosNaoLancados()).filter((x: any) => normLoja(x.loja) === normLoja(nomeLoja))) {
      for (const it of Array.isArray(pa.itens) ? pa.itens : []) {
        const pid = it.produtoIdLoja != null ? String(it.produtoIdLoja) : null;
        if (!pid || !venda.has(pid)) continue;
        const q = Number(it.qtd ?? 0) * (multiplicar ? (Number(it.fator ?? 1) || 1) : 1);
        if (!(q > 0)) continue;
        const cur = andamentoProd.get(pid) ?? { qtd: 0, pedidos: [] };
        cur.qtd += q;
        cur.pedidos.push({ pedido: `Insight ${String(pa.id).slice(0, 8)}`, situacao: pa.status === 'erro_envio' ? 'aprovado no Insight (erro no envio)' : 'aprovado no Insight, ainda não lançado', quantidade: q, criadoEm: pa.criado_em, fornecedor: pa.fornecedor_nome });
        andamentoProd.set(pid, cur);
      }
    }
    revisao.sort((a, b) => b.quantidade - a.quantidade);

    const linhas: any[] = [];
    for (const [k, agg] of venda) {
      const vel = agg.qtd / diasHistorico;
      const vf = vincRede.get(chaveProduto({ codigoSistema: agg.codigoSistema, produtoId: k }));
      const fornecedorNome = !vf ? null : vf.ignorar ? 'Fora da Central' : (fornFixo.porChave.get(String(vf.chave_central)) ?? fornFixo.porCodigo.get(codNorm(vf.codigo_central ?? String(vf.chave_central).split('|')[0])) ?? null);
      const demanda = vel * diasPeriodoAlvo * fator;
      const seguranca = vel * diasSeguranca * fator;
      const est = estoqueDe(k, agg);
      const and = andamentoProd.get(k);
      const emAndamento = and?.qtd ?? 0;
      const qtdRec = Math.max(0, Math.ceil(demanda + seguranca - est - emAndamento));
      const custoUnit = agg.qtd > 0 ? agg.custo / agg.qtd : 0;
      linhas.push({
        produtoId: agg.produtoId, descricao: agg.descricao, codigoSistema: agg.codigoSistema, codigoInterno: internos.get(k) ?? null,
        vendaMediaDiaria: Number(vel.toFixed(2)), estoqueAtual: est,
        emAndamento, pedidosEmAndamento: (and?.pedidos ?? []).slice(0, 6),
        demandaProjetadaPeriodo: Number(demanda.toFixed(1)),
        qtdRecomendadaCompra: qtdRec,
        valorEstimadoCompra: Number((qtdRec * custoUnit).toFixed(2)),
        // preco medio de venda (liquido do que foi cobrado) e custo medio, para retorno e perda no pedido
        precoMedioVenda: agg.qtd > 0 ? r2(agg.receita / agg.qtd) : null, custoUnitario: r2(custoUnit),
        riscoRuptura: est + emAndamento < demanda,
        fornecedorNome,
      });
    }
    linhas.sort((a, b) => b.qtdRecomendadaCompra - a.qtdRecomendadaCompra);
    const resumoPedido = (p: any) => ({ pedido: p.codigo, fornecedor: p.fornecedor?.nome, situacao: p.situacao?.descricao, desde: p.situacao?.dataAlteracao, previsao: p.dataPrevisao ?? null });
    const aguardandoFranqueado = pedidos.filter((p) => /aguardando_franqueado|aguardando_pagamento/.test(String(p.situacao?.status))).map(resumoPedido);
    const atrasados = pedidos.filter((p) => p.dataPrevisao && Date.parse(p.dataPrevisao) < Date.now()).map(resumoPedido);
    return {
      nomeLoja, totalProdutosAnalisados: linhas.length,
      valorTotalEstimadoCompra: Number(linhas.reduce((s, r) => s + r.valorEstimadoCompra, 0).toFixed(2)),
      recomendacoes: linhas,
      pedidosCentral: { pedidosAbertos: pedidos.length, itensEmAndamento: itens.size, vinculados, aRevisar: revisao.length, ignorados, semVendaNoPeriodo: semVenda, aguardandoFranqueado, atrasados },
      revisao: revisao.slice(0, 40),
      semLigacao: semLigacao.sort((a, b) => b.quantidade - a.quantidade).slice(0, 400).map((x) => [x.codigoCentral, x.descricaoCentral, x.quantidade, x.fornecedor, x.pedidos[0]?.pedido ?? null, x.pedidos[0]?.situacao ?? null]),
      diagEstoque: {
        linhasSaldoSemFiltro: linhasSemFiltro, consultaComEntidade, filtrouEntidade, linhasSaldoUsadas: saldos.length,
        unidadesQueVenderam: [...entVenda.values()], unidadesNoSaldo: [...entSaldo.values()].map((e) => ({ ...e, total: Math.round(e.total) })),
        produtosVendidos: venda.size, comSaldoPorId: porId, comSaldoPorCodigo: porCod, semSaldo,
        coberturaPercent: venda.size ? Math.round((porId + porCod) / venda.size * 100) : null,
      },
    };
  }

  const lojas: any[] = [];
  for (let i = 0; i < nomes.length; i += 6) lojas.push(...await Promise.all(nomes.slice(i, i + 6).map(processar)));

  return {
    parametros: { diasHistorico, diasPeriodoAlvo, percentCrescimento, diasSeguranca, multiplicarPorFator: multiplicar },
    pedidos: { totalEmAndamento: andamento.total, erro: andamento.erro, avisoVinculos: vinc.aviso },
    valorTotalEstimadoCompraRede: Number(lojas.reduce((s, l) => s + (l.valorTotalEstimadoCompra ?? 0), 0).toFixed(2)),
    lojas: lojas.sort((a, b) => a.nomeLoja.localeCompare(b.nomeLoja)),
  };
}

// Salva a correcao manual de um item da Central: vincular a um produto, ignorar ou remover o vinculo.
async function moduloVinculo(body: any) {
  const acao = String(body.acao ?? '');
  const loja = String(body.loja ?? '');
  const cod = codNorm(body.codigoCentral);
  if (!loja || !cod) throw new Error('Informe loja e codigoCentral.');
  const s = sb();
  if (acao === 'remover') {
    const { error } = await s.from('pedidos_vinculos').delete().eq('loja', loja).eq('codigo_central', cod);
    if (error) throw new Error(`Erro ao remover vinculo: ${error.message}`);
    return { ok: true };
  }
  let linha: any;
  if (acao === 'ignorar') linha = { loja, codigo_central: cod, produto_id: null, ignorar: true };
  else if (acao === 'salvar' && Number.isFinite(Number(body.produtoId))) linha = { loja, codigo_central: cod, produto_id: Number(body.produtoId), ignorar: false };
  else throw new Error('Acao invalida: use salvar (com produtoId), ignorar ou remover.');
  const { error } = await s.from('pedidos_vinculos').upsert({ ...linha, atualizado_em: new Date().toISOString() }, { onConflict: 'loja,codigo_central' });
  if (error) throw new Error(`Erro ao salvar vinculo: ${error.message}`);
  return { ok: true };
}

// =====================================================================
// CATALOGO DA CENTRAL — montado a partir do historico de pedidos
// (a API publica da Central so expoe GET /pedidos; cada item pedido revela
//  fornecedor, preco, minimo/maximo, embalagem, variacao e prazo)
// =====================================================================
const DIAS_CATALOGO = 180;
const mediana = (xs: number[]) => { if (!xs.length) return null; const o = [...xs].sort((a, b) => a - b); const m = Math.floor(o.length / 2); return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const chaveItem = (codigo: unknown, variacao: unknown, extra = '') => `${codNorm(codigo)}|${limpa(variacao)}${extra ? '|' + extra : ''}`;

// ---- Variacao = cor E tamanho ----
// Na Central a variacao tem "descricao" (ex.: AZUL) e "referencia" (ex.: "PSB 18 cm"). Quando o mesmo codigo+descricao
// aparece com referencias diferentes (ou idProduto diferentes), sao tamanhos/modelos distintos: a chave passa a incluir
// esse diferencial. Para itens que so variam por cor a chave continua igual (codigo|cor).
const separarNumeros = (s: string) => s.replace(/(\d)([A-Z])/g, '$1 $2').replace(/([A-Z])(\d)/g, '$1 $2');
const TAMANHOS = new Set(['PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'EG', 'EGG', 'U', 'UN', 'UNICO', 'INFANTIL', 'ADULTO', 'MINI', 'PEQUENO', 'MEDIO', 'GRANDE']);
// "Cor" de uma variacao sem o tamanho: "38CM (TRADICIONAL)" -> "", "AZUL P" -> "AZUL", "COR 3" -> "COR 3".
// Remove medidas (numero + unidade), tamanhos (P, M, G...) e textos entre parenteses; numero solto fica (COR 3).
function corBase(desc: unknown) {
  const t = separarNumeros(limpa(String(desc ?? '').replace(/\([^)]*\)/g, ' '))).split(' ').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < t.length; i++) {
    if (TAMANHOS.has(t[i])) continue;
    if (/^\d+$/.test(t[i]) && i + 1 < t.length && /^(C+M|CMS|M+M|M|ML|L|G|KG|POL)$/.test(t[i + 1])) { i++; continue; } // C+M: aceita erro de digitacao (17Ccm)
    out.push(t[i]);
  }
  return out.join(' ');
}
// corBase a partir da chave do item (CODIGO|DESCRICAO[|extra])
const corBaseDaChave = (chave: string) => corBase(String(chave ?? '').split('|')[1] ?? '');
// tokens para comparar variacoes: mantem letras soltas (P, M, G) e separa numero de unidade (18CM -> 18 CM)
const tokensVar = (s: unknown) => new Set(separarNumeros(limpa(s)).split(' ').filter(Boolean));
// so os pedacos que indicam tamanho/medida (para nao exigir que o codigo da referencia apareca no nome do produto)
function tokensTamanho(s: unknown) {
  const t = [...tokensVar(s)];
  const out = new Set<string>();
  t.forEach((x, i) => {
    if (TAMANHOS.has(x)) out.add(x);
    else if (/^\d+$/.test(x) && (i + 1 < t.length && /^(CM|MM|M|ML|L|G|KG|POL)$/.test(t[i + 1]))) { out.add(x); out.add(t[i + 1]); }
    else if (/^\d+$/.test(x) && x.length <= 3) out.add(x);
  });
  return out;
}
function criarIdentificadorVariacao(lista: any[]) {
  const refs = new Map<string, Set<string>>(), prods = new Map<string, Set<string>>();
  for (const p of lista) for (const i of p.itensPedido ?? []) {
    const g = chaveItem(i.codigo, i.variacao?.descricao ?? '');
    const r = codNorm(i.variacao?.referencia);
    if (r) { if (!refs.has(g)) refs.set(g, new Set()); refs.get(g)!.add(r); }
    if (i.idProduto) { if (!prods.has(g)) prods.set(g, new Set()); prods.get(g)!.add(String(i.idProduto)); }
  }
  return (i: any) => {
    const desc = String(i.variacao?.descricao ?? '').trim();
    const g = chaveItem(i.codigo, desc);
    const refTxt = String(i.variacao?.referencia ?? '').trim(), ref = codNorm(refTxt);
    if (ref && (refs.get(g)?.size ?? 0) > 1) return { chave: chaveItem(i.codigo, desc, 'R' + ref), rotulo: desc ? `${desc} · ${refTxt}` : refTxt, descricaoVar: desc, tamanho: tokensTamanho(refTxt) };
    if (i.idProduto && (prods.get(g)?.size ?? 0) > 1) return { chave: chaveItem(i.codigo, desc, 'P' + i.idProduto), rotulo: `${desc ? desc + ' · ' : ''}${String(i.descricaoProduto ?? '').trim()}`, descricaoVar: desc, tamanho: tokensTamanho(i.descricaoProduto) };
    return { chave: g, rotulo: desc, descricaoVar: desc, tamanho: tokensTamanho(desc) };
  };
}

// Prazo de entrega de cada fornecedor (pelo nome): mediana real (criação do pedido → situação final, sem cancelados)
// e o prazo mais informado nos itens. Usado no alerta "pedir até" da ruptura.
function prazosFornecedores(lista: any[]): Record<string, { leadTimeMedianoDias: number | null; amostras: number; prazoInformado: string | null }> {
  const f = new Map<string, { lt: number[]; prazos: Map<string, number> }>();
  for (const p of lista) {
    const nome = String(p.fornecedor?.nome ?? '').trim(); if (!nome || ehCancelado(p)) continue;
    const x = f.get(nome) ?? { lt: [], prazos: new Map() }; f.set(nome, x);
    for (const i of p.itensPedido ?? []) { const pr = String(i.prazo ?? '').trim(); if (pr) x.prazos.set(pr, (x.prazos.get(pr) ?? 0) + 1); }
    if (ehFinal(p)) { const lt = (Date.parse(p.situacao?.dataAlteracao) - Date.parse(p.dataCriacao)) / 86400000; if (Number.isFinite(lt) && lt >= 0 && lt < 180) x.lt.push(lt); }
  }
  const out: Record<string, any> = {};
  for (const [nome, x] of f) out[nome] = { leadTimeMedianoDias: x.lt.length ? r2(mediana(x.lt)!) : null, amostras: x.lt.length, prazoInformado: [...x.prazos.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null };
  return out;
}

function montarCatalogo(lista: any[]) {
  const idVar = criarIdentificadorVariacao(lista);
  const franqueados = new Map<string, string>();
  const ultimasCondicoes = new Map<string, any>();
  const itens = new Map<string, any>();
  const forn = new Map<string, any>();
  const ordenada = [...lista].sort((a, b) => Date.parse(a.dataCriacao) - Date.parse(b.dataCriacao)); // mais recente sobrescreve
  for (const p of ordenada) {
    const fid = String(p.fornecedor?.id ?? '');
    if (!fid) continue;
    const f = forn.get(fid) ?? { id: fid, nome: p.fornecedor?.nome ?? '', pedidos: 0, cancelados: 0, valorTotal: 0, valores: [] as number[], leadTimes: [] as number[], lojas: new Set<string>(), porLoja: new Map<string, { n: number; valor: number; ultimo: string }>(), prazos: new Map<string, number>(), formas: new Map<string, number>() };
    forn.set(fid, f);
    if (ehCancelado(p)) { f.cancelados++; continue; }
    const loja = lojaDoPedido(p);
    let valorPedido = 0;
    for (const i of p.itensPedido ?? []) {
      const q = Number(i.quantidadeProdutos ?? 0);
      const pu = Number(i.valorUnitario ?? i.variacao?.custoTotal ?? 0);
      valorPedido += q * pu;
      const iv = idVar(i);
      const varDesc = iv.rotulo;
      const k = iv.chave;
      const c = itens.get(k) ?? { chave: k, codigo: String(i.codigo ?? '').trim(), vezes: 0, qtdTotal: 0, lojas: new Set<string>(), descricoes: new Set<string>() };
      Object.assign(c, {
        idProduto: i.idProduto, descricao: i.descricaoProduto, variacao: varDesc, variacaoDescricao: iv.descricaoVar, corBase: corBase(iv.descricaoVar), tamanho: [...iv.tamanho], referencia: i.variacao?.referencia || null,
        categoria: i.categoriaProduto, fornecedorId: fid, fornecedorNome: p.fornecedor?.nome ?? '',
        preco: pu, qtdMinima: Number(i.qtdMinima) || 1, qtdMaxima: Number(i.qtdMaxima) || null,
        fatorConversao: Number(i.fatorConversao) || 1, prazo: String(i.prazo ?? '').trim() || c.prazo || null,
        emEstoque: i.variacao?.emEstoque ?? c.emEstoque ?? null, ultimaCompra: p.dataCriacao,
        // dados exigidos pelo POST /api/v3/cart/finishOrders (copiados do pedido mais recente)
        unidade: i.unidade ?? c.unidade ?? null, qtdSolicitadaInicio: Number(i.qtdSolicitadaInicio ?? i.qtdMinima ?? 1) || 1,
        qtdCasasDecimais: Number(i.qtdCasasDecimais ?? 0) || 0, variacaoRaw: i.variacao ?? {}, idFornecedorItem: i.idFornecedor ?? fid,
      });
      c.vezes++; c.qtdTotal += q; c.lojas.add(loja); if (i.descricaoProduto) c.descricoes.add(String(i.descricaoProduto));
      itens.set(k, c);
      const pr = String(i.prazo ?? '').trim(); if (pr) f.prazos.set(pr, (f.prazos.get(pr) ?? 0) + 1);
    }
    f.pedidos++; f.valorTotal += valorPedido; f.valores.push(valorPedido); f.lojas.add(loja);
    const fp = String(p.formaPagamento ?? ''); if (fp) f.formas.set(fp, (f.formas.get(fp) ?? 0) + 1);
    const pl = f.porLoja.get(loja) ?? { n: 0, valor: 0, ultimo: '' };
    pl.n++; pl.valor += valorPedido; pl.ultimo = p.dataCriacao; f.porLoja.set(loja, pl);
    if (p.franqueado?.id) franqueados.set(loja, String(p.franqueado.id));
    ultimasCondicoes.set(`${loja}|${fid}`, { tipoFrete: p.tipoFrete ?? null, formaPagamento: p.formaPagamento ?? null, observacaoEntrega: p.observacaoEntrega ?? null, quando: p.dataCriacao });
    if (ehFinal(p)) {
      const lt = (Date.parse(p.situacao?.dataAlteracao) - Date.parse(p.dataCriacao)) / 86400000;
      if (Number.isFinite(lt) && lt >= 0 && lt < 180) f.leadTimes.push(lt);
    }
  }
  const maisComum = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const fornecedores = [...forn.values()].map((f) => {
    const vs = [...f.valores].sort((a: number, b: number) => a - b);
    return {
      id: f.id, nome: f.nome, pedidos: f.pedidos, cancelados: f.cancelados,
      taxaCancelamento: f.pedidos + f.cancelados ? r2(f.cancelados / (f.pedidos + f.cancelados) * 100) : 0,
      valorTotal: r2(f.valorTotal), ticketMedio: f.pedidos ? r2(f.valorTotal / f.pedidos) : 0,
      ticketP10: vs.length ? r2(vs[Math.floor(vs.length * 0.1)]) : 0,
      leadTimeMedianoDias: f.leadTimes.length ? r2(mediana(f.leadTimes)!) : null, leadTimeAmostras: f.leadTimes.length,
      prazoInformado: maisComum(f.prazos), formaPagamento: maisComum(f.formas), lojas: f.lojas.size,
      _porLoja: f.porLoja,
    };
  }).sort((a, b) => b.valorTotal - a.valorTotal);
  const listaItens = [...itens.values()].map((c) => ({ ...c, lojas: c.lojas.size, descricoes: [...c.descricoes] })).sort((a, b) => b.vezes - a.vezes);
  return { fornecedores, itens: listaItens, franqueados, ultimasCondicoes, idVar };
}

async function moduloCatalogoCentral(body: any) {
  const dias = Math.min(365, Math.max(30, Number(body.dias ?? DIAS_CATALOGO)));
  const base = await buscarPedidosCentral(dias);
  if (base.erro && !base.lista.length) throw new Error(base.erro);
  const cat = montarCatalogo(base.lista);
  return {
    dias, pedidosLidos: base.lista.length, aviso: base.erro,
    fornecedores: cat.fornecedores.map(({ _porLoja, ...f }) => f),
    itens: cat.itens,
  };
}

// =====================================================================
// PEDIDO SUGERIDO — recomendacao da loja convertida para itens da Central,
// separada por fornecedor, respeitando minimo/maximo/embalagem.
// =====================================================================
async function gerarPedidoSugerido(apiBase: string, lojasTokens: Record<string, string>, body: any) {
  const loja = String(body.loja ?? '');
  if (!loja || !lojasTokens[loja]) throw new Error('Escolha uma loja valida para gerar o pedido.');
  const multiplicar = body.multiplicarPorFator === true;
  const diasCatalogo = Math.min(DIAS_CATALOGO, Math.max(30, Number(body.diasCatalogo ?? DIAS_CATALOGO)));
  // Etapa 2 do fluxo em duas etapas: o painel ja calculou a recomendacao (modulo recorrente) e manda so o necessario.
  // Assim esta chamada nao le a VarejOnline e cabe no limite de memoria/CPU do Supabase.
  let rec: any, l: any;
  const base = await buscarPedidosCentral(diasCatalogo);
  if (base.erro && !base.lista.length) throw new Error(base.erro);
  if (body.recomendacao && Array.isArray(body.recomendacao.recomendacoes)) {
    l = body.recomendacao; rec = { parametros: body.recomendacao.parametros ?? {} };
  } else {
    rec = await moduloRecorrente(apiBase, lojasTokens, { ...body, lojas: [loja] }, base);
    l = rec.lojas[0];
  }
  if (!l || l.erro) throw new Error(`Nao foi possivel calcular a recomendacao de ${loja}: ${l?.erro ?? 'sem dados'}`);
  const cat = juntarCatalogoFixo(montarCatalogo(base.lista), await carregarCatalogoFixo());

  const idx = indexarCatalogo(cat);
  const vinc = await carregarVinculosLoja(loja);

  const linhas: any[] = [];
  const semCorrespondencia: any[] = [];
  let ignoradosVinculo = 0;
  for (const r of l.recomendacoes) {
    if (!(r.qtdRecomendadaCompra > 0)) continue;
    const m = casarProduto(r, idx, vinc);
    if (m.via === 'ignorado') { ignoradosVinculo++; continue; }
    if (!m.item) {
      semCorrespondencia.push({ produtoId: r.produtoId, descricao: r.descricao, codigoSistema: r.codigoSistema, qtdRecomendada: r.qtdRecomendadaCompra, valorEstimado: r.valorEstimadoCompra, riscoRuptura: r.riscoRuptura });
      continue;
    }
    const esc = m.item, via = m.via, variacaoIncerta = m.variacaoIncerta;
    const fator = esc.fatorConversao || 1;
    let qtd = multiplicar ? Math.ceil(r.qtdRecomendadaCompra / fator) : r.qtdRecomendadaCompra;
    const ajustes: string[] = [];
    if (qtd < esc.qtdMinima) { qtd = esc.qtdMinima; ajustes.push(`subiu p/ mínimo ${esc.qtdMinima}`); }
    if (esc.qtdMaxima && qtd > esc.qtdMaxima) { qtd = esc.qtdMaxima; ajustes.push(`limitado ao máximo ${esc.qtdMaxima}`); }
    linhas.push({
      produtoId: r.produtoId, descricaoLoja: r.descricao, codigoSistema: r.codigoSistema,
      riscoRuptura: r.riscoRuptura, vendaMediaDiaria: r.vendaMediaDiaria, estoqueAtual: r.estoqueAtual, emAndamento: r.emAndamento,
      precoVenda: r.precoMedioVenda ?? null, demandaPeriodo: r.demandaProjetadaPeriodo ?? null, unidadesPorQtd: multiplicar ? fator : 1,
      qtdRecomendadaUnidades: r.qtdRecomendadaCompra, qtd, valor: r2(qtd * esc.preco), via, ajustes, variacaoIncerta,
      central: { chave: esc.chave, codigo: esc.codigo, idProduto: esc.idProduto, descricao: esc.descricao, variacao: esc.variacao, variacaoDescricao: esc.variacaoDescricao ?? esc.variacao, corBase: esc.corBase ?? corBase(esc.variacaoDescricao ?? esc.variacao), referencia: esc.referencia, categoria: esc.categoria, preco: esc.preco, qtdMinima: esc.qtdMinima, qtdMaxima: esc.qtdMaxima, fatorConversao: fator, prazo: esc.prazo, emEstoque: esc.emEstoque, ultimaCompra: esc.ultimaCompra },
      alternativas: m.alternativas.map(resumoItemCentral),
      // vinculo a grade: o painel distribui a quantidade entre os tamanhos pela proporcao da rede
      distribuirGrade: !!(m as any).gradeEscolhida || (!!(m as any).grade && !!itensDaGrade(idx, esc)),
      tipoGrade: (m as any).gradeEscolhida ? 'escolhida' : itensDaGrade(idx, esc)?.tipo ?? null,
      // grade: familia por letra (A-Z) ou todas as variacoes (cores/tamanhos) do mesmo codigo e fornecedor
      grade: (() => {
        if ((m as any).gradeEscolhida) return (m as any).gradeEscolhida.map((x: any) => ({ ...resumoItemCentral(x), rotuloGrade: `${x.codigo} · ${x.variacaoDescricao ?? x.variacao ?? ''}` }));
        const fam = itensDaGrade(idx, esc);
        if (fam?.tipo === 'letra') return fam.itens.map((x: any) => ({ ...resumoItemCentral(x), rotuloGrade: `Letra ${letraDoItem(x)}` }));
        if (fam?.tipo === 'cor') return (m as any).grade ? fam.itens.map(resumoItemCentral) : [];
        if (fam?.tipo === 'tamanho' && tamanhoDoCodigo(esc.codigo) && fam.itens.some((x: any) => codNorm(x.codigo) !== codNorm(esc.codigo))) return fam.itens.map((x: any) => ({ ...resumoItemCentral(x), rotuloGrade: `Tamanho ${tamanhoDoCodigo(x.codigo)!.tam}` }));
        return !fornecedorTemGrade(esc.fornecedorNome) ? [] : (idx.porCodigo.get(codNorm(esc.codigo)) ?? []).filter((x: any) => x.fornecedorId === esc.fornecedorId && codNorm(x.codigo) === codNorm(esc.codigo)).slice(0, 80).map(resumoItemCentral);
      })(),
      fornecedorId: esc.fornecedorId, fornecedorNome: esc.fornecedorNome,
    });
  }

  const fInfo = new Map(cat.fornecedores.map((f) => [f.id, f]));
  const kLoja = normLoja(loja);
  const grupos = new Map<string, any>();
  for (const ln of linhas) {
    const fi = fInfo.get(ln.fornecedorId);
    const hist = fi?._porLoja.get(kLoja);
    const g = grupos.get(ln.fornecedorId) ?? {
      fornecedorId: ln.fornecedorId, fornecedorNome: ln.fornecedorNome, itens: [] as any[],
      prazoInformado: fi?.prazoInformado ?? null, leadTimeMedianoDias: fi?.leadTimeMedianoDias ?? null,
      taxaCancelamento: fi?.taxaCancelamento ?? 0, formaPagamento: fi?.formaPagamento ?? null,
      ticketP10Rede: fi?.ticketP10 ?? 0, pedidosDestaLoja: hist?.n ?? 0, ticketMedioDestaLoja: hist?.n ? r2(hist.valor / hist.n) : null, ultimoPedidoDestaLoja: hist?.ultimo ?? null,
    };
    g.itens.push(ln);
    grupos.set(ln.fornecedorId, g);
  }
  const fornecedores = [...grupos.values()].map((g) => {
    g.itens.sort((a: any, b: any) => Number(b.riscoRuptura) - Number(a.riscoRuptura) || b.valor - a.valor);
    g.valorTotal = r2(g.itens.reduce((s: number, x: any) => s + x.valor, 0));
    g.itensRisco = g.itens.filter((x: any) => x.riscoRuptura).length;
    g.abaixoDoHabitual = g.ticketP10Rede > 0 && g.valorTotal < g.ticketP10Rede;
    return g;
  }).sort((a, b) => b.itensRisco - a.itensRisco || b.valorTotal - a.valorTotal);

  return {
    loja, geradoEm: new Date().toISOString(), parametros: { ...rec.parametros, diasCatalogo },
    avisoCentral: base.erro, pedidosAndamento: l.pedidosCentral, diagEstoque: l.diagEstoque,
    totais: { valor: r2(fornecedores.reduce((s, f) => s + f.valorTotal, 0)), itens: linhas.length, fornecedores: fornecedores.length, semCorrespondencia: semCorrespondencia.length, ignoradosVinculo, itensRisco: linhas.filter((x) => x.riscoRuptura).length },
    fornecedores,
    // fornecedores do catálogo sem item sugerido para esta loja: dá para montar um pedido à mão
    outrosFornecedores: (() => {
      const cont = new Map<string, { nome: string; n: number }>();
      for (const it of idx.itens) { if (!it.fornecedorId || grupos.has(it.fornecedorId)) continue; const c = cont.get(it.fornecedorId) ?? { nome: it.fornecedorNome ?? '', n: 0 }; c.n++; cont.set(it.fornecedorId, c); }
      return [...cont.entries()].map(([id, c]) => { const fi = fInfo.get(id); const hist = fi?._porLoja.get(kLoja);
        return { fornecedorId: id, fornecedorNome: c.nome || fi?.nome || id, itensCatalogo: c.n, prazoInformado: fi?.prazoInformado ?? null, leadTimeMedianoDias: fi?.leadTimeMedianoDias ?? null, taxaCancelamento: fi?.taxaCancelamento ?? 0, formaPagamento: fi?.formaPagamento ?? null, ticketP10Rede: fi?.ticketP10 ?? 0, pedidosDestaLoja: hist?.n ?? 0, ticketMedioDestaLoja: hist?.n ? r2(hist.valor / hist.n) : null, ultimoPedidoDestaLoja: hist?.ultimo ?? null }; })
        .sort((a, b) => a.fornecedorNome.localeCompare(b.fornecedorNome, 'pt-BR'));
    })(),
    semCorrespondencia: semCorrespondencia.sort((a, b) => Number(b.riscoRuptura) - Number(a.riscoRuptura) || b.valorEstimado - a.valorEstimado),
  };
}

class ConfirmacaoNecessaria extends Error { constructor(msg: string, public tipo: string) { super(msg); } }


// =====================================================================
// ENVIO PARA A CENTRAL — POST /api/v3/cart/finishOrders
// Secrets: CENTRAL_ENVIO_HABILITADO=true (liga o envio), CENTRAL_BASE_URL (opcional),
//          CENTRAL_API_KEY_PEDIDOS (opcional; se vazio usa PEDIDOS_API_KEY). A chave precisa da permissao criar_pedido.
// =====================================================================
const centralBase = () => (Deno.env.get('CENTRAL_BASE_URL') ?? 'https://app.centraldofranqueado.com.br').replace(/\/+$/, '');
const centralChave = () => (Deno.env.get('CENTRAL_API_KEY_PEDIDOS') ?? Deno.env.get('PEDIDOS_API_KEY') ?? '').trim();
const envioHabilitado = () => String(Deno.env.get('CENTRAL_ENVIO_HABILITADO') ?? '').toLowerCase() === 'true';

// Le as opcoes de frete e pagamento sem depender do formato exato da resposta:
// procura objetos com id + nome dentro de chaves que falam de frete / pagamento.
function extrairOpcoes(raw: any, fornecedorId: string) {
  const fretes = new Map<string, any>(), pagamentos = new Map<string, any>();
  const idDe = (o: any) => o?._id ?? o?.id ?? o?.value ?? null;
  const nomeDe = (o: any) => o?.nome ?? o?.descricao ?? o?.label ?? o?.name ?? o?.titulo ?? null;
  const fornDe = (o: any) => o?.idFornecedor ?? o?.fornecedorId ?? o?.fornecedor?.id ?? o?.fornecedor ?? null;
  function andar(o: any, caminho: string, forn: string | null) {
    if (o == null || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach((x) => andar(x, caminho, forn)); return; }
    const f = fornDe(o); const fornAqui = typeof f === 'string' ? f : forn;
    const id = idDe(o), nome = nomeDe(o);
    if (id != null && nome != null && typeof nome === 'string') {
      const alvo = /frete|shipping|entrega/i.test(caminho) ? fretes : /pagamento|pagto|payment/i.test(caminho) ? pagamentos : null;
      if (alvo) {
        const ant = alvo.get(String(id));
        const doFornecedor = fornAqui === fornecedorId;
        if (!ant || (doFornecedor && !ant.doFornecedor)) alvo.set(String(id), { id: String(id), nome, doFornecedor, geral: fornAqui == null });
      }
    }
    for (const [k, v] of Object.entries(o)) andar(v, `${caminho}.${k}`, fornAqui);
  }
  andar(raw, '', null);
  const filtrar = (m: Map<string, any>) => { const l = [...m.values()]; const doF = l.filter((x) => x.doFornecedor); return (doF.length ? doF : l.filter((x) => x.geral || !x.doFornecedor)).map(({ id, nome }) => ({ id, nome })); };
  return { fretes: filtrar(fretes), pagamentos: filtrar(pagamentos) };
}

async function buscarOpcoesCentral(fornecedorId: string) {
  const chave = centralChave();
  if (!chave) throw new Error('Chave da API da Central nao configurada.');
  const r = await fetch(`${centralBase()}/api/v3/order/options?idFornecedor=${encodeURIComponent(fornecedorId)}`, { headers: { 'x-api-key': chave }, signal: AbortSignal.timeout(20000) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Central respondeu ${r.status} ao listar opcoes de frete/pagamento: ${txt.slice(0, 200)}`);
  let raw: any; try { raw = JSON.parse(txt); } catch { raw = txt; }
  return { raw, ...extrairOpcoes(raw, fornecedorId) };
}

// Monta o carrinho a partir de um pedido aprovado + catalogo atual da Central.
async function montarEnvio(pedido: any) {
  const base = await buscarPedidosCentral(DIAS_CATALOGO);
  if (base.erro && !base.lista.length) throw new Error(base.erro);
  const cat = montarCatalogo(base.lista);
  const kLoja = normLoja(pedido.loja);
  const franqueado = cat.franqueados.get(kLoja) ?? null;
  const ult = cat.ultimasCondicoes.get(`${kLoja}|${pedido.fornecedor_id}`) ?? null;
  const porChave = new Map(cat.itens.map((i: any) => [i.chave, i]));
  const itens: any[] = [], problemas: string[] = [];
  for (const it of pedido.itens ?? []) {
    const k = it.chave ?? chaveItem(it.codigo, it.variacao);
    const c: any = porChave.get(k);
    if (!c) { problemas.push(`${it.codigo}${it.variacao ? ' (' + it.variacao + ')' : ''}: nao encontrado no catalogo da Central`); continue; }
    if (c.fornecedorId !== pedido.fornecedor_id) { problemas.push(`${it.codigo}: pertence a outro fornecedor na Central`); continue; }
    if (!c.idProduto || !c.unidade) problemas.push(`${it.codigo}: sem idProduto/unidade no historico`);
    const qtd = Number(it.qtd);
    if (qtd < c.qtdMinima) problemas.push(`${it.codigo}: quantidade ${qtd} abaixo do minimo ${c.qtdMinima}`);
    if (c.qtdMaxima && qtd > c.qtdMaxima) problemas.push(`${it.codigo}: quantidade ${qtd} acima do maximo ${c.qtdMaxima}`);
    itens.push({
      payload: {
        idProduto: c.idProduto, idFornecedor: c.idFornecedorItem ?? c.fornecedorId, codigo: c.codigo, descricaoProduto: c.descricao,
        quantidadeProdutos: qtd, valorUnitario: Number(c.preco), unidade: c.unidade, fatorConversao: Number(c.fatorConversao) || 1,
        qtdMinima: Number(c.qtdMinima) || 1, qtdSolicitadaInicio: Number(c.qtdSolicitadaInicio) || 1, qtdCasasDecimais: Number(c.qtdCasasDecimais) || 0,
        variacao: c.variacaoRaw ?? {},
      },
      precoAprovado: Number(it.preco), precoAtual: Number(c.preco), ultimaCompra: c.ultimaCompra, variacaoRotulo: c.variacao,
    });
  }
  if (!franqueado) problemas.push('ID da unidade na Central nao encontrado (a loja nao tem pedidos na Central nos ultimos 180 dias).');
  return { franqueado, ultimasCondicoes: ult, itens, problemas };
}

// Aprovacao e acompanhamento. Tabela: pedidos_sugeridos (SQL no README da entrega).
async function moduloPedidoSugerido(apiBase: string, lojasTokens: Record<string, string>, body: any) {
  const acao = String(body.acao ?? 'gerar');
  if (acao === 'gerar') return await gerarPedidoSugerido(apiBase, lojasTokens, body);
  const s = sb();

  if (acao === 'aprovar') {
    const itens = Array.isArray(body.itens) ? body.itens.filter((i: any) => Number(i.qtd) > 0) : [];
    if (!body.loja || !body.fornecedorId || !itens.length) throw new Error('Informe loja, fornecedor e ao menos um item com quantidade.');
    const aprovadoPor = String(body.aprovadoPor ?? '').trim();
    if (!aprovadoPor) throw new Error('Informe quem esta aprovando.');
    // trava de duplicidade: mesmo fornecedor/loja aprovado e ainda nao lancado nas ultimas 72h
    const { data: dup } = await s.from('pedidos_sugeridos').select('id, criado_em').eq('loja', body.loja).eq('fornecedor_id', body.fornecedorId).eq('status', 'aprovado').gte('criado_em', new Date(Date.now() - 72 * 3600000).toISOString());
    if (dup?.length && body.forcar !== true) throw new ConfirmacaoNecessaria(`Ja existe um pedido aprovado para este fornecedor nesta loja nas ultimas 72h (ainda nao lancado na Central). Confirme para aprovar mesmo assim.`, 'duplicidade');
    const valor = r2(itens.reduce((t: number, i: any) => t + Number(i.qtd) * Number(i.preco ?? 0), 0));
    const limite = Number(Deno.env.get('LIMITE_PEDIDO_SEM_CONFIRMACAO') ?? 0);
    if (limite > 0 && valor > limite && body.confirmarValor !== true) throw new ConfirmacaoNecessaria(`Pedido de ${valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} passa do limite de ${limite.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}. Confirme o valor para aprovar.`, 'valor');
    const { data, error } = await s.from('pedidos_sugeridos').insert({
      loja: body.loja, fornecedor_id: body.fornecedorId, fornecedor_nome: body.fornecedorNome ?? null,
      itens, valor_total: valor, status: 'aprovado', aprovado_por: aprovadoPor, observacao: body.observacao ?? null,
    }).select('id').single();
    if (error) throw new Error(`Erro ao salvar o pedido: ${error.message}`);
    _aprovados = null;
    return { ok: true, id: data.id, valor };
  }

  if (acao === 'status') {
    const novo = String(body.status ?? '');
    if (!['descartado', 'lancado', 'aprovado'].includes(novo) || !body.id) throw new Error('Informe id e status (aprovado, lancado ou descartado).');
    const patch: any = { status: novo };
    if (novo === 'lancado') { patch.lancado_em = new Date().toISOString(); patch.codigo_pedido_central = body.codigoPedidoCentral ? Number(body.codigoPedidoCentral) : null; }
    const { error } = await s.from('pedidos_sugeridos').update(patch).eq('id', body.id);
    _aprovados = null;
    if (error) throw new Error(`Erro ao atualizar: ${error.message}`);
    return { ok: true };
  }

  if (acao === 'opcoesEnvio' || acao === 'enviar') {
    if (!body.id) throw new Error('Informe o id do pedido aprovado.');
    const { data: ped, error } = await s.from('pedidos_sugeridos').select('*').eq('id', body.id).maybeSingle();
    if (error) throw new Error(`Erro ao ler o pedido: ${error.message}`);
    if (!ped) throw new Error('Pedido nao encontrado.');

    if (acao === 'opcoesEnvio') {
      const env = await montarEnvio(ped);
      let opcoes: any = { fretes: [], pagamentos: [], raw: null }, erroOpcoes: string | null = null;
      try { opcoes = await buscarOpcoesCentral(ped.fornecedor_id); } catch (e) { erroOpcoes = e instanceof Error ? e.message : String(e); }
      const u = env.ultimasCondicoes;
      const sugFrete = u?.tipoFrete && opcoes.fretes.some((f: any) => f.id === u.tipoFrete) ? u.tipoFrete : (opcoes.fretes.length === 1 ? opcoes.fretes[0].id : u?.tipoFrete ?? null);
      const sugPag = opcoes.pagamentos.find((x: any) => x.id === u?.formaPagamento || limpa(x.nome) === limpa(u?.formaPagamento))?.id ?? (opcoes.pagamentos.length === 1 ? opcoes.pagamentos[0].id : null);
      return {
        habilitado: envioHabilitado(), status: ped.status, loja: ped.loja, fornecedor: ped.fornecedor_nome, franqueado: env.franqueado,
        fretes: opcoes.fretes, pagamentos: opcoes.pagamentos, erroOpcoes, opcoesRaw: JSON.stringify(opcoes.raw ?? null).slice(0, 4000),
        sugestao: { tipoFrete: sugFrete, formaPagamento: sugPag, observacaoEntrega: u?.observacaoEntrega ?? '' },
        ultimoPedidoComFornecedor: u ? { tipoFrete: u.tipoFrete, formaPagamento: u.formaPagamento, quando: u.quando } : null,
        itens: env.itens.map((i: any) => ({ codigo: i.payload.codigo, descricao: i.payload.descricaoProduto, variacao: i.variacaoRotulo ?? i.payload.variacao?.descricao ?? '', qtd: i.payload.quantidadeProdutos, precoAprovado: i.precoAprovado, precoAtual: i.precoAtual, ultimaCompra: i.ultimaCompra })),
        valorAtual: r2(env.itens.reduce((t: number, i: any) => t + i.payload.quantidadeProdutos * i.payload.valorUnitario, 0)),
        problemas: env.problemas,
      };
    }

    // ---- enviar ----
    if (!envioHabilitado()) throw new Error('Envio para a Central desativado. Crie o secret CENTRAL_ENVIO_HABILITADO = true no Supabase para liberar.');
    if (ped.status !== 'aprovado' && !(ped.status === 'erro_envio' && body.reenviar === true)) throw new Error(ped.status === 'enviando' ? 'Este pedido ja esta sendo enviado.' : `Pedido com status "${ped.status}" nao pode ser enviado.`);
    if (!body.tipoFrete || !body.formaPagamento) throw new Error('Escolha o tipo de frete e a forma de pagamento.');
    const enviadoPor = String(body.enviadoPor ?? '').trim();
    if (!enviadoPor) throw new Error('Informe quem esta enviando.');
    const env = await montarEnvio(ped);
    if (env.problemas.length || !env.franqueado || !env.itens.length) throw new Error('Pedido com pendencias, nada foi enviado: ' + (env.problemas.join(' | ') || 'sem itens'));
    const valorAtual = r2(env.itens.reduce((t: number, i: any) => t + i.payload.quantidadeProdutos * i.payload.valorUnitario, 0));
    if (body.valorConfirmado == null || Math.abs(Number(body.valorConfirmado) - valorAtual) > 0.01) throw new Error(`O valor mudou para ${valorAtual.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} (precos atualizados). Revise e confirme de novo.`);

    // trava: so um envio por vez (compare-and-set no status)
    const { data: trava, error: eT } = await s.from('pedidos_sugeridos').update({ status: 'enviando', enviado_por: enviadoPor, erro_envio: null }).eq('id', ped.id).eq('status', ped.status).select('id');
    if (eT) throw new Error(`Erro ao travar o pedido: ${eT.message}`);
    if (!trava?.length) throw new Error('Outro envio deste pedido esta em andamento. Atualize a lista.');

    const cart = { cart: { franqueado: env.franqueado, pedidos: [{
      idFornecedor: ped.fornecedor_id, tipoFrete: String(body.tipoFrete), formaPagamento: String(body.formaPagamento),
      ...(String(body.observacaoEntrega ?? '').trim() ? { observacaoEntrega: String(body.observacaoEntrega).trim().slice(0, 500) } : {}),
      itensPedido: env.itens.map((i: any) => i.payload),
    }] } };
    let status = 0, txt = '', falhaRede: string | null = null;
    try {
      const r = await fetch(`${centralBase()}/api/v3/cart/finishOrders`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': centralChave() }, body: JSON.stringify(cart), signal: AbortSignal.timeout(45000) });
      status = r.status; txt = await r.text();
    } catch (e) { falhaRede = e instanceof Error ? e.message : String(e); }
    let resposta: any = txt; try { resposta = JSON.parse(txt); } catch { /* texto */ }
    const agora = new Date().toISOString();
    if (!falhaRede && status >= 200 && status < 300) {
      const codigos: number[] = [];
      (function achar(o: any, k = '') { if (o == null) return; if (typeof o === 'object') { for (const [kk, v] of Object.entries(o)) achar(v, kk); return; } if (k === 'codigo' && Number.isFinite(Number(o))) codigos.push(Number(o)); })(resposta);
      await s.from('pedidos_sugeridos').update({ status: 'lancado', lancado_em: agora, enviado_em: agora, codigo_pedido_central: codigos[0] ?? null, resposta_central: resposta,
        frete_id: String(body.tipoFrete), pagamento_id: String(body.formaPagamento), valor_total: valorAtual }).eq('id', ped.id);
      return { ok: true, codigoPedidoCentral: codigos[0] ?? null, valor: valorAtual, resposta };
    }
    // Falha: se foi erro de rede/timeout o pedido PODE ter sido criado; nao libera reenvio automatico.
    const msg = falhaRede ? `Sem resposta da Central (${falhaRede}). O pedido pode ter sido criado — confira na Central antes de reenviar.` : `Central recusou o pedido (HTTP ${status}): ${String(typeof resposta === 'string' ? resposta : JSON.stringify(resposta)).slice(0, 400)}`;
    await s.from('pedidos_sugeridos').update({ status: 'erro_envio', erro_envio: msg, resposta_central: falhaRede ? null : resposta, enviado_em: agora }).eq('id', ped.id);
    throw new Error(msg);
  }

  if (acao === 'listar') {
    let q = s.from('pedidos_sugeridos').select('*').order('criado_em', { ascending: false }).limit(Number(body.limite ?? 60));
    if (body.loja) q = q.eq('loja', body.loja);
    else if (Array.isArray(body.lojasPermitidas)) q = q.in('loja', body.lojasPermitidas);
    const { data, error } = await q;
    if (error) throw new Error(`Erro ao listar pedidos: ${error.message}. A tabela pedidos_sugeridos foi criada?`);
    const lista = data ?? [];
    // confirma automaticamente: pedido aprovado que ja apareceu na Central (mesma loja + fornecedor, criado depois da aprovacao, >= 50% dos codigos)
    const pend = lista.filter((p: any) => p.status === 'aprovado' || p.status === 'erro_envio' || p.status === 'enviando');
    let avisoCentral: string | undefined;
    if (pend.length) {
      const maisAntigo = Math.min(...pend.map((p: any) => Date.parse(p.criado_em)));
      const dias = Math.min(45, Math.max(1, Math.ceil((Date.now() - maisAntigo) / 86400000) + 1));
      const base = await buscarPedidosCentral(dias);
      avisoCentral = base.erro;
      const usados = new Set<number>((lista.filter((p: any) => p.codigo_pedido_central).map((p: any) => Number(p.codigo_pedido_central))));
      for (const p of pend) {
        const cods = new Set<string>((p.itens ?? []).map((i: any) => codNorm(i.codigo)));
        const t0 = Date.parse(p.criado_em) - 3600000;
        const achado = base.lista
          .filter((c) => !ehCancelado(c) && !usados.has(Number(c.codigo)) && String(c.fornecedor?.id) === p.fornecedor_id && lojaDoPedido(c) === normLoja(p.loja) && Date.parse(c.dataCriacao) >= t0)
          .map((c) => { const cc = new Set<string>((c.itensPedido ?? []).map((i: any) => codNorm(i.codigo))); let inter = 0; for (const x of cods) if (cc.has(x)) inter++; return { c, cob: cods.size ? inter / cods.size : 0 }; })
          .filter((x) => x.cob >= 0.5).sort((a, b) => b.cob - a.cob)[0];
        if (achado) {
          usados.add(Number(achado.c.codigo));
          const patch = { status: 'lancado', lancado_em: achado.c.dataCriacao, codigo_pedido_central: Number(achado.c.codigo) };
          await s.from('pedidos_sugeridos').update(patch).eq('id', p.id);
          Object.assign(p, patch, { situacao_central: achado.c.situacao?.descricao, cobertura: r2(achado.cob * 100) });
        }
      }
    }
    return { pedidos: lista, avisoCentral };
  }
  throw new Error('Acao invalida: use gerar, aprovar, status, listar, opcoesEnvio ou enviar.');
}


// ---- Cadastro de clientes: regras de completude (nome completo, telefone, CPF, CEP) ----
const soDigitos = (x: unknown) => String(x ?? '').replace(/\D/g, '');
function cpfValido(x: unknown) {
  const c = soDigitos(x);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (n: number) => { let s = 0; for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}
const nomeCompleto = (n: unknown) => limpa(n).split(' ').filter((p) => p.length >= 2 && !/^\d+$/.test(p)).length >= 2;
const telefoneOk = (t: any[] | undefined) => (t ?? []).some((f) => (soDigitos(f.ddd) + soDigitos(f.numero)).length >= 10 || soDigitos(f.numero).length >= 10);
const cepOk = (e: any[] | undefined) => (e ?? []).some((x) => soDigitos(x.cep).length === 8 && !/^0+$/.test(soDigitos(x.cep)));
const CONSUMIDOR_FINAL = /CONSUMIDOR|CLIENTE (FINAL|PADRAO|BALCAO|AVULSO)|NAO IDENTIFICADO|NAO INFORMADO|VENDA BALCAO/;
// Cliente identificado na venda = tem terceiro com CPF/CNPJ valido e nao e o cadastro generico de consumidor final.
function clienteIdentificado(t: any) {
  if (!t || t.id == null) return false;
  if (CONSUMIDOR_FINAL.test(limpa(t.nome))) return false;
  const d = soDigitos(t.documento);
  return d.length === 14 || cpfValido(d);
}
function avaliarCadastro(t: any) {
  const faltando: string[] = [];
  if (!nomeCompleto(t.nome)) faltando.push('nome completo');
  if (!telefoneOk(t.telefones)) faltando.push('telefone');
  if (!cpfValido(t.documento)) faltando.push('CPF');
  if (!cepOk(t.enderecos)) faltando.push('CEP');
  return faltando;
}

// Guarda so o que as analises usam de cada venda (o JSON completo da VarejOnline e grande).
const compactarSaida = (sd: any) => ({
  id: sd.id, numeroDocumento: sd.numeroDocumento, cancelado: sd.cancelado, tipoSaida: sd.tipoSaida,
  data: sd.data ?? sd.dataSaida ?? sd.dataEmissao, entidade: sd.entidade ? { id: sd.entidade.id } : undefined,
  terceiro: sd.terceiro ? { id: sd.terceiro.id, nome: sd.terceiro.nome, documento: sd.terceiro.documento } : undefined,
  mercadorias: (sd.mercadorias ?? []).map((it: any) => ({ quantidade: it.quantidade, valorTotal: it.valorTotal, valorTotalDesconto: it.valorTotalDesconto, valorDescontoItem: it.valorDescontoItem, idRepresentante: it.idRepresentante,
    produto: it.produto ? { id: it.produto.id, descricao: it.produto.descricao, codigoSistema: it.produto.codigoSistema } : null })),
});

// =====================================================================
// DESEMPENHO DE VENDEDORES — por loja, a partir das saidas da VarejOnline
// (cada item vendido traz idRepresentante = vendedor do item)
// =====================================================================
const ehVenda = (s: any) => !s.cancelado && (!s.tipoSaida || (/VENDA/.test(String(s.tipoSaida)) && !/DEVOLU/.test(String(s.tipoSaida))));

// Horários de pico: grade dia da semana × hora (só as horas com venda), os blocos de 2 horas mais fortes da loja
// (média por dia daquele dia da semana no período) e quem mais vende em cada um; para cada vendedor, seu dia e horário mais fortes.
const DIAS_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
function montarHorariosPico(gl: { at: number[][]; fat: number[][] }, gv: Map<string, { at: number[][]; fat: number[][] }>, vendedores: any[], dIni: Date, dFim: Date, semHora: number) {
  const ocorr = new Array(7).fill(0); // quantos domingos, segundas… no período
  for (let d = new Date(dIni); d <= dFim; d.setDate(d.getDate() + 1)) ocorr[d.getDay()]++;
  let hMin = 24, hMax = -1;
  for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) if (gl.at[w][h]) { hMin = Math.min(hMin, h); hMax = Math.max(hMax, h); }
  if (hMax < 0) return { semDados: true, semHora };
  const horas = Array.from({ length: hMax - hMin + 1 }, (_, i) => hMin + i);
  const corta = (g: number[][], dec = 0) => g.map((l) => horas.map((h) => dec ? r2(l[h]) : l[h]));
  // blocos de 2h (h e h+1) por dia da semana, pela média por dia
  const blocos: any[] = [];
  for (let w = 0; w < 7; w++) for (const h of horas) {
    if (h + 1 > hMax && horas.length > 1) continue;
    const fat = gl.fat[w][h] + (gl.fat[w][h + 1] ?? 0), at = gl.at[w][h] + (gl.at[w][h + 1] ?? 0);
    if (!at || !ocorr[w]) continue;
    blocos.push({ dow: w, h, fat, at, fatMedio: fat / ocorr[w] });
  }
  blocos.sort((x, y) => y.fatMedio - x.fatMedio);
  const escolhidos: any[] = [];
  for (const b of blocos) { if (escolhidos.length >= 3) break; if (escolhidos.some((e) => e.dow === b.dow && Math.abs(e.h - b.h) < 2)) continue; escolhidos.push(b); }
  const nomeDe = new Map(vendedores.map((v: any) => [v.id, v.nome]));
  const ativos = new Set(vendedores.filter((v: any) => v.ativo !== false).map((v: any) => v.id));
  const picos = escolhidos.map((b) => {
    const quem = [...gv.entries()].filter(([id]) => id !== 'sem' && ativos.has(id)).map(([id, g]) => ({ id, nome: nomeDe.get(id) ?? id, fat: g.fat[b.dow][b.h] + (g.fat[b.dow][b.h + 1] ?? 0), at: g.at[b.dow][b.h] + (g.at[b.dow][b.h + 1] ?? 0) }))
      .filter((x) => x.at > 0).sort((x, y) => y.fat - x.fat);
    const tot = quem.reduce((t, x) => t + x.fat, 0);
    return { dia: DIAS_SEMANA[b.dow], dow: b.dow, de: b.h, ate: b.h + 2, faturamentoMedioDia: r2(b.fatMedio), atendimentosMedioDia: r2(b.at / ocorr[b.dow]),
      quem: quem.slice(0, 4).map((x) => ({ nome: x.nome, faturamento: r2(x.fat), atendimentos: x.at, participacao: tot ? r2(x.fat / tot * 100) : 0 })), vendedoresNoHorario: quem.length };
  });
  // horários fortes da loja = blocos de 1h no quintil de cima (para medir quanto de cada vendedor cai no pico)
  const celulas: number[] = []; for (let w = 0; w < 7; w++) for (const h of horas) if (gl.at[w][h] && ocorr[w]) celulas.push(gl.fat[w][h] / ocorr[w]);
  celulas.sort((x, y) => y - x);
  const corte = celulas[Math.max(0, Math.ceil(celulas.length * 0.2) - 1)] ?? Infinity;
  const ehPico = (w: number, h: number) => ocorr[w] > 0 && gl.at[w][h] > 0 && gl.fat[w][h] / ocorr[w] >= corte;
  const porVendedor: Record<string, any> = {};
  for (const [id, g] of gv) {
    if (id === 'sem' || !ativos.has(id)) continue;
    let tot = 0, noPico = 0; const porDia = new Array(7).fill(0); let melhor = { h: -1, v: 0 };
    for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) { const v = g.fat[w][h]; tot += v; porDia[w] += v; if (ehPico(w, h)) noPico += v; }
    for (const h of horas) { const v = g.fat.reduce((t, l) => t + l[h] + (l[h + 1] ?? 0), 0); if (v > melhor.v) melhor = { h, v }; }
    const dMelhor = porDia.indexOf(Math.max(...porDia));
    porVendedor[id] = { at: corta(g.at), fat: corta(g.fat, 2), diaForte: tot ? DIAS_SEMANA[dMelhor] : null, horarioForte: melhor.h >= 0 ? { de: melhor.h, ate: melhor.h + 2 } : null,
      percentNoPicoDaLoja: tot ? r2(noPico / tot * 100) : 0 };
  }
  const celPico = horas.length ? Array.from({ length: 7 }, (_, w) => horas.map((h) => ehPico(w, h) ? 1 : 0)) : [];
  return { horas, ocorrencias: ocorr, loja: { at: corta(gl.at), fat: corta(gl.fat, 2) }, celulasPico: celPico, picos, porVendedor, semHora };
}

async function moduloVendedores(apiBase: string, lojasTokens: Record<string, string>, body: any) {
  // Periodo: datas exatas (desde/ate em aaaa-mm-dd) ou os ultimos N dias.
  const isoData = (x: unknown) => { const m = String(x ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  let dIni = isoData(body.desde), dFim = isoData(body.ate);
  if (!dIni || !dFim) {
    const n = Math.min(366, Math.max(1, Number(body.dias ?? 30)));
    dFim = new Date(); dIni = new Date(dFim); dIni.setDate(dIni.getDate() - (n - 1));
  }
  if (dIni > dFim) [dIni, dFim] = [dFim, dIni];
  const dias = Math.round((dFim.getTime() - dIni.getTime()) / 86400000) + 1;
  if (dias > 366) throw new Error('Periodo maximo de 1 ano.');
  const precoLimite = Number(body.precoLimite ?? 49.99);
  const percentAlerta = Number(body.percentAlerta ?? 60);
  const metaIdentificacao = Number(body.metaIdentificacao ?? 70);
  const filtro: string[] | null = body.lojas ?? null;
  const nomes = filtro && filtro.length ? filtro.filter((n) => lojasTokens[n]) : Object.keys(lojasTokens);
  const desde = fmtBR(dIni), ate = fmtBR(dFim);

  async function processar(nomeLoja: string) {
    const token = lojasTokens[nomeLoja];
    let saidas: any[] = [], reps: any[] = [], novosClientes: any[] = [], parceiros: any[] = [];
    let erroCadastros: string | null = null;
    try {
      [, reps, parceiros] = await Promise.all([
        buscarSaidasParalelo(apiBase, token, dIni!, dFim!, (sd) => { if (ehVenda(sd)) saidas.push(compactarSaida(sd)); }),
        fetchAllPages(`${apiBase}/representantes`, token).catch(() => []),
        // fornecedores e prestadores de servico: nao contam como cliente (nem cadastro nem venda identificada)
        fetchAllPages(`${apiBase}/terceiros?classes=FORNECEDOR,PRESTADOR_SERVICO`, token).catch(() => []),
      ]);
      try { novosClientes = await fetchAllPages(`${apiBase}/terceiros?classes=CLIENTE&filtroData=dataCriacao&desde=${desde.replace(/-/g, '/')}&ate=${ate.replace(/-/g, '/')}`, token); }
      catch (e) { erroCadastros = e instanceof Error ? e.message : String(e); }
    } catch (e) { return { nomeLoja, erro: e instanceof Error ? e.message : String(e), vendedores: [] }; }
    const repInfo = new Map<string, any>(reps.map((r: any) => [String(r.id), r]));
    const ehParceiro = (t: any) => (t?.classes ?? []).some((c: string) => /FORNECEDOR|PRESTADOR_SERVICO/.test(String(c)));
    const idsParceiros = new Set<string>(parceiros.filter(ehParceiro).map((t: any) => String(t.id)));

    type Acc = { id: string; atend: Set<string>; atend1: number; atend1Barata: number; pecas: number; fat: number; desc: number; pecasBaratas: number; fatBarato: number; baratasSozinhas: number; baratasAcrescimo: number; dias: Set<string>; atendCliente: Set<string>; atipAt: Set<string>; atipPecas: number; atipFat: number; prods: Map<string, any> };
    const acc = new Map<string, Acc>();
    const loja = { atipAt: 0, atipPecas: 0, atipFat: 0, atend: 0, pecas: 0, fat: 0, desc: 0, pecasBaratas: 0, fatBarato: 0, atendCliente: 0, atend1Barata: 0, baratasSozinhas: 0, baratasAcrescimo: 0, baratasSoBaratas: 0 };
    const entidadesLoja = new Set<string>();
    const pendente1Barata: string[] = [];
    // pecas abaixo do preco-limite, por produto (quais sao e quem vende)
    const baratos = new Map<string, { produtoId: any; descricao: string; codigoSistema: string | null; qtd: number; fat: number; vend: Map<string, number>; sozinha: number; acrescimo: number; soBaratas: number }>();
    // primeira venda de cada cliente no periodo -> vendedor principal dessa venda
    const primeiraVenda = new Map<string, { data: number; vendedor: string }>();
    const parseData = (x: unknown) => { const m = String(x ?? '').match(/(\d{2})[-/](\d{2})[-/](\d{4})(?:\s+(\d{2}):(\d{2}))?/); return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0)) : 0; };
    // ---- Horários de pico: dia da semana (0=dom) × hora, por loja e por vendedor ----
    const novaGrade = () => ({ at: Array.from({ length: 7 }, () => new Array(24).fill(0)), fat: Array.from({ length: 7 }, () => new Array(24).fill(0)) });
    const gradeLoja = novaGrade(), gradeVend = new Map<string, ReturnType<typeof novaGrade>>();
    const diaHora = (x: unknown) => { const t = String(x ?? ''); let m = t.match(/(\d{2})[-/](\d{2})[-/](\d{4})\D+(\d{2}):\d{2}/); if (m) return { dow: new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])).getUTCDay(), h: +m[4] };
      m = t.match(/(\d{4})-(\d{2})-(\d{2})\D+(\d{2}):\d{2}/); return m ? { dow: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay(), h: +m[4] } : null; };
    let semHora = 0;
    // ---- Venda atípica: atendimento muito acima do normal da loja (atacado, kit grande, venda para outra loja/evento).
    // Conta no faturamento, mas fica fora do PA, do ticket e da venda por dia usados para comparar vendedores —
    // senão um único atendimento de 1.700 peças vira "PA 66" e todo o resto da equipe aparece em vermelho.
    const totAt = (sd: any) => { let q = 0, v = 0; for (const it of sd.mercadorias ?? []) { const x = Number(it.quantidade ?? 0); if (x > 0) { q += x; v += Number(it.valorTotal ?? 0); } } return { q, v }; };
    const medianaN = (xs: number[]) => { if (!xs.length) return 0; const o = [...xs].sort((a, b) => a - b); return o[Math.floor(o.length / 2)]; };
    const tamanhos = saidas.filter(ehVenda).map(totAt).filter((t) => t.q > 0);
    const medQ = medianaN(tamanhos.map((t) => t.q)), medV = medianaN(tamanhos.map((t) => t.v));
    const limQ = Math.max(30, 15 * medQ), limV = Math.max(3000, 15 * medV);
    const ehAtipica = (sd: any) => { const t = totAt(sd); return t.q > limQ || t.v > limV; };
    for (const sd of saidas) {
      if (!ehVenda(sd)) continue;
      const idAt = String(sd.id ?? sd.numeroDocumento ?? Math.random());
      const atipica = ehAtipica(sd);
      const dia = String(sd.data ?? sd.dataSaida ?? sd.dataEmissao ?? '').slice(0, 10);
      const porVend = new Map<string, number>(); // pecas por vendedor neste atendimento
      const valPorVend = new Map<string, number>();
      if (sd.entidade?.id != null) entidadesLoja.add(String(sd.entidade.id));
      const comCliente = clienteIdentificado(sd.terceiro) && !idsParceiros.has(String(sd.terceiro?.id));
      let algum = false;
      // Contexto da peca barata neste atendimento: sozinha (1 peca so), acrescimo (junto de peca >= limite) ou so baratas
      const validos = (sd.mercadorias ?? []).filter((it: any) => Number(it.quantidade ?? 0) > 0);
      const pecasAt = validos.reduce((t: number, it: any) => t + Number(it.quantidade ?? 0), 0);
      const temCaro = validos.some((it: any) => Number(it.valorTotal ?? 0) / Number(it.quantidade) >= precoLimite);
      const contexto: 'sozinha' | 'acrescimo' | 'soBaratas' = pecasAt <= 1 ? 'sozinha' : temCaro ? 'acrescimo' : 'soBaratas';
      if (pecasAt <= 1 && validos.length && !temCaro) {
        loja.atend1Barata++;
        const v0 = validos[0].idRepresentante != null ? String(validos[0].idRepresentante) : 'sem';
        const a0 = acc.get(v0); if (a0) a0.atend1Barata++; else pendente1Barata.push(v0);
      }
      for (const it of sd.mercadorias ?? []) {
        const q = Number(it.quantidade ?? 0);
        if (!(q > 0)) continue;
        algum = true;
        const v = Number(it.valorTotal ?? 0);
        const d = Number(it.valorTotalDesconto ?? it.valorDescontoItem ?? 0);
        const unit = v / q;
        const vid = it.idRepresentante != null ? String(it.idRepresentante) : 'sem';
        const a = acc.get(vid) ?? { id: vid, atend: new Set(), atend1: 0, atend1Barata: 0, pecas: 0, fat: 0, desc: 0, pecasBaratas: 0, fatBarato: 0, baratasSozinhas: 0, baratasAcrescimo: 0, dias: new Set(), atendCliente: new Set(), atipAt: new Set(), atipPecas: 0, atipFat: 0, prods: new Map() };
        a.atend.add(idAt); a.pecas += q; a.fat += v; a.desc += d; if (dia) a.dias.add(dia);
        if (atipica) { a.atipAt.add(idAt); a.atipPecas += q; a.atipFat += v; loja.atipPecas += q; loja.atipFat += v; }
        // produtos de cada vendedor (top 10 na tela Equipe), sem as vendas atípicas
        else { const pr = it.produto, kp = pr?.id != null ? String(pr.id) : `d:${limpa(pr?.descricao)}`; const m = a.prods.get(kp) ?? { produtoId: pr?.id ?? null, descricao: String(pr?.descricao ?? ''), codigoSistema: pr?.codigoSistema ?? null, q: 0, v: 0 }; m.q += q; m.v += v; a.prods.set(kp, m); }
        if (unit < precoLimite) {
          a.pecasBaratas += q; a.fatBarato += v; loja.pecasBaratas += q; loja.fatBarato += v;
          const pr = it.produto, kb = pr?.id != null ? String(pr.id) : `d:${limpa(pr?.descricao)}`;
          const b = baratos.get(kb) ?? { produtoId: pr?.id ?? null, descricao: String(pr?.descricao ?? '(produto sem descrição)'), codigoSistema: pr?.codigoSistema ?? null, qtd: 0, fat: 0, vend: new Map(), sozinha: 0, acrescimo: 0, soBaratas: 0 };
          b.qtd += q; b.fat += v; b.vend.set(vid, (b.vend.get(vid) ?? 0) + q); b[contexto] += q; baratos.set(kb, b);
          if (contexto === 'sozinha') { loja.baratasSozinhas += q; a.baratasSozinhas += q; }
          else if (contexto === 'acrescimo') { loja.baratasAcrescimo += q; a.baratasAcrescimo += q; }
          else loja.baratasSoBaratas += q;
        }
        acc.set(vid, a);
        porVend.set(vid, (porVend.get(vid) ?? 0) + q);
        valPorVend.set(vid, (valPorVend.get(vid) ?? 0) + v);
        if (comCliente) a.atendCliente.add(idAt);
        loja.pecas += q; loja.fat += v; loja.desc += d;
      }
      if (algum) {
        loja.atend++; if (atipica) loja.atipAt++;
        if (comCliente) loja.atendCliente++;
        const tid = sd.terceiro?.id != null && !idsParceiros.has(String(sd.terceiro.id)) ? String(sd.terceiro.id) : null;
        if (tid) {
          const quando = parseData(sd.data ?? sd.dataSaida ?? sd.dataEmissao);
          const principal = [...valPorVend.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'sem';
          const atual = primeiraVenda.get(tid);
          if (!atual || quando < atual.data) primeiraVenda.set(tid, { data: quando, vendedor: principal });
        }
      }
      for (const [vid, q] of porVend) if (q <= 1) acc.get(vid)!.atend1++;
      if (algum) {
        const dh = diaHora(sd.data ?? sd.dataSaida ?? sd.dataEmissao);
        if (!dh) semHora++;
        else {
          let tot = 0; for (const v of valPorVend.values()) tot += v;
          gradeLoja.at[dh.dow][dh.h]++; gradeLoja.fat[dh.dow][dh.h] += tot;
          for (const [vid, v] of valPorVend) {
            const g = gradeVend.get(vid) ?? novaGrade(); gradeVend.set(vid, g);
            g.at[dh.dow][dh.h]++; g.fat[dh.dow][dh.h] += v;
          }
        }
      }
    }
    for (const v0 of pendente1Barata) { const a0 = acc.get(v0); if (a0) a0.atend1Barata++; }
    // ---- Cadastros novos no periodo (so os criados nesta loja, quando a VarejOnline informa) ----
    const cadPorVend = new Map<string, { novos: number; completos: number; falta: Record<string, number> }>();
    const incompletos: any[] = [];
    const cadLoja = { novos: 0, completos: 0, semVenda: 0, falta: { 'nome completo': 0, telefone: 0, CPF: 0, CEP: 0 } as Record<string, number> };
    for (const t of novosClientes) {
      if (t.excluido) continue;
      if (ehParceiro(t) || idsParceiros.has(String(t.id))) continue; // fornecedor/prestador nao e cadastro de cliente
      if (t.entidadeCadastro != null && entidadesLoja.size && !entidadesLoja.has(String(t.entidadeCadastro))) continue;
      if (CONSUMIDOR_FINAL.test(limpa(t.nome))) continue;
      const faltando = avaliarCadastro(t);
      const pv = primeiraVenda.get(String(t.id));
      const vid = pv?.vendedor ?? 'sem_venda';
      cadLoja.novos++; if (!faltando.length) cadLoja.completos++; if (!pv) cadLoja.semVenda++;
      for (const f of faltando) cadLoja.falta[f] = (cadLoja.falta[f] ?? 0) + 1;
      const c = cadPorVend.get(vid) ?? { novos: 0, completos: 0, falta: {} };
      c.novos++; if (!faltando.length) c.completos++;
      for (const f of faltando) c.falta[f] = (c.falta[f] ?? 0) + 1;
      cadPorVend.set(vid, c);
      if (faltando.length) incompletos.push({ clienteId: t.id, nome: String(t.nome ?? '').trim() || '(sem nome)', faltando, vendedorId: vid, criadoEm: t.dataCriacao ?? null });
    }
    // PA e ticket de referência SEM as vendas atípicas
    const atN = loja.atend - loja.atipAt;
    const paLoja = atN ? (loja.pecas - loja.atipPecas) / atN : 0;
    const ticketLoja = atN ? (loja.fat - loja.atipFat) / atN : 0;
    const vendedoresTodos = [...acc.values()].map((a) => {
      const r = repInfo.get(a.id);
      const at = a.atend.size, atT = at - a.atipAt.size, fatT = a.fat - a.atipFat;
      const pa = atT ? (a.pecas - a.atipPecas) / atT : 0, ticket = atT ? fatT / atT : 0;
      const pctBaratas = a.pecas ? a.pecasBaratas / a.pecas * 100 : 0;
      const pct1 = at ? a.atend1 / at * 100 : 0;
      const idxPA = paLoja ? pa / paLoja : null, idxTicket = ticketLoja ? ticket / ticketLoja : null;
      // Perfil indicativo (comparado com a propria loja). Precisa de volume minimo para nao julgar por poucos atendimentos.
      let perfil = 'sem_volume';
      if (a.id === 'sem') perfil = 'sem_vendedor';
      else if (atT >= 15 && idxPA != null && idxTicket != null) perfil = 'classificar'; // decidido abaixo, junto com o volume por dia
      return {
        id: a.id, nome: a.id === 'sem' ? 'Sem vendedor informado' : (r?.nome ?? `Vendedor ${a.id}`),
        perfilSistema: r?.perfilVendedor ?? null, ativo: r?.ativo ?? null,
        faturamento: r2(a.fat), participacao: loja.fat ? r2(a.fat / loja.fat * 100) : 0,
        atendimentos: at, pecas: r2(a.pecas), diasComVenda: a.dias.size,
        pecasPorAtendimento: r2(pa), ticketMedio: r2(ticket), precoMedioPeca: a.pecas ? r2(a.fat / a.pecas) : 0,
        percentPecasAbaixoLimite: r2(pctBaratas), percentAtendimentos1Peca: r2(pct1),
        atendimentos1PecaBarata: a.atend1Barata, percentAtendimentos1PecaBarata: at ? r2(a.atend1Barata / at * 100) : 0,
        percentBaratasSozinhas: a.pecasBaratas ? r2(a.baratasSozinhas / a.pecasBaratas * 100) : 0, percentBaratasAcrescimo: a.pecasBaratas ? r2(a.baratasAcrescimo / a.pecasBaratas * 100) : 0,
        descontoPercent: a.fat + a.desc ? r2(a.desc / (a.fat + a.desc) * 100) : 0,
        indicePA: idxPA != null ? r2(idxPA) : null, indiceTicket: idxTicket != null ? r2(idxTicket) : null,
        perfil, alertaMixBarato: a.pecas >= 20 && pctBaratas >= percentAlerta,
        atendimentosComCliente: a.atendCliente.size,
        percentClienteIdentificado: at ? r2(a.atendCliente.size / at * 100) : 0,
        cadastrosNovos: cadPorVend.get(a.id)?.novos ?? 0,
        cadastrosCompletos: cadPorVend.get(a.id)?.completos ?? 0,
        cadastrosFaltando: cadPorVend.get(a.id)?.falta ?? {},
        faturamentoPorDia: a.dias.size ? r2(fatT / a.dias.size) : 0, atendimentosPorDia: a.dias.size ? r2(atT / a.dias.size) : 0, pct1,
        vendasAtipicas: a.atipAt.size ? { atendimentos: a.atipAt.size, pecas: r2(a.atipPecas), faturamento: r2(a.atipFat) } : null,
        topProdutos: [...a.prods.values()].sort((x, y) => y.q - x.q || y.v - x.v).slice(0, 10).map((m) => ({ produtoId: m.produtoId, descricao: m.descricao, codigoSistema: m.codigoSistema, pecas: r2(m.q), faturamento: r2(m.v) })),
      };
    }).sort((x, y) => y.faturamento - x.faturamento);
    // ---- Perfil: COMO vende (PA e ticket) + QUANTO vende (venda por dia trabalhado) ----
    // Venda por dia = faturamento ÷ dias com venda: compara de forma justa quem trabalhou menos dias (folga, meio período, férias).
    // Referência = média da loja por vendedor por dia (soma do faturamento ÷ soma dos dias trabalhados dos vendedores com volume).
    const classificaveis = vendedoresTodos.filter((v: any) => v.perfil === 'classificar');
    const diasTot = classificaveis.reduce((t: number, v: any) => t + v.diasComVenda, 0);
    const refFatDia = diasTot ? classificaveis.reduce((t: number, v: any) => t + v.faturamentoPorDia * v.diasComVenda, 0) / diasTot : 0;
    const refAtendDia = diasTot ? classificaveis.reduce((t: number, v: any) => t + v.atendimentosPorDia * v.diasComVenda, 0) / diasTot : 0;
    for (const v of vendedoresTodos as any[]) {
      v.indiceVendaDia = refFatDia && v.diasComVenda ? r2(v.faturamentoPorDia / refFatDia) : null;
      v.indiceAtendDia = refAtendDia && v.diasComVenda ? r2(v.atendimentosPorDia / refAtendDia) : null;
      if (v.perfil === 'classificar') {
        const iPA = v.indicePA, iT = v.indiceTicket, iV = v.indiceVendaDia ?? 1;
        const qualidadeAlta = iPA >= 1.1 && iT >= 1.05, qualidadeBaixa = iPA < 0.9 || iT < 0.9;
        if (iPA < 0.8 && iT < 0.85 && v.pct1 >= 50) v.perfil = 'tirador_pedido';
        else if (qualidadeAlta && iV >= 1) v.perfil = 'destaque';
        else if (qualidadeAlta) v.perfil = 'atende_bem_pouco_volume';
        else if (!qualidadeBaixa && iV >= 1.15) v.perfil = 'puxa_vendas';
        else if (qualidadeBaixa && iV >= 1.15) v.perfil = 'volume_ticket_baixo';
        else if (qualidadeBaixa) v.perfil = 'atencao';
        else if (iV < 0.75) v.perfil = 'pouca_venda_dia';
        else v.perfil = 'na_media';
      }
      // leitura em uma frase (aparece ao passar o mouse no perfil)
      if (v.diasComVenda && v.id !== 'sem') v.leitura = `Vendeu em ${v.diasComVenda} dia(s): R$ ${v.faturamentoPorDia.toFixed(2).replace('.', ',')} e ${String(v.atendimentosPorDia).replace('.', ',')} atendimentos por dia`
        + (refFatDia ? ` (média da loja por vendedor: R$ ${refFatDia.toFixed(2).replace('.', ',')} e ${String(r2(refAtendDia)).replace('.', ',')} atendimentos/dia)` : '')
        + `. PA ${String(v.pecasPorAtendimento).replace('.', ',')} e ticket R$ ${v.ticketMedio.toFixed(2).replace('.', ',')} (loja: ${String(r2(paLoja)).replace('.', ',')} e R$ ${ticketLoja.toFixed(2).replace('.', ',')}).`;
      delete v.pct1;
    }
    // só vendedores ativos no cadastro da VarejOnline (os totais da loja continuam com todas as vendas)
    const inativos = vendedoresTodos.filter((v) => v.ativo === false);
    const vendedores = vendedoresTodos.filter((v) => v.ativo !== false);
    const pctLoja = loja.pecas ? loja.pecasBaratas / loja.pecas * 100 : 0;
    const horarios = montarHorariosPico(gradeLoja, gradeVend, vendedoresTodos, dIni!, dFim!, semHora);
    const referenciaDia = { faturamento: r2(refFatDia), atendimentos: r2(refAtendDia) };
    const nomeVend = (id: string) => id === 'sem_venda' ? 'Sem venda no período' : id === 'sem' ? 'Sem vendedor informado' : (repInfo.get(id)?.nome ?? `Vendedor ${id}`);
    return {
      nomeLoja, referenciaDia, horarios,
      cadastros: {
        erro: erroCadastros, novos: cadLoja.novos, completos: cadLoja.completos,
        percentCompletos: cadLoja.novos ? r2(cadLoja.completos / cadLoja.novos * 100) : null,
        semVendaNoPeriodo: cadLoja.semVenda, faltando: cadLoja.falta,
        incompletos: incompletos.slice(0, 200).map((x) => ({ ...x, vendedor: nomeVend(x.vendedorId) })),
      },
      loja: {
        faturamento: r2(loja.fat), atendimentos: loja.atend, pecas: r2(loja.pecas),
        pecasPorAtendimento: r2(paLoja), ticketMedio: r2(ticketLoja), precoMedioPeca: loja.pecas ? r2(loja.fat / loja.pecas) : 0,
        percentPecasAbaixoLimite: r2(pctLoja), percentFaturamentoAbaixoLimite: loja.fat ? r2(loja.fatBarato / loja.fat * 100) : 0,
        descontoPercent: loja.fat + loja.desc ? r2(loja.desc / (loja.fat + loja.desc) * 100) : 0,
        alertaMixBarato: loja.pecas > 0 && pctLoja >= percentAlerta,
        semVendedorPercent: loja.fat ? r2((acc.get('sem')?.fat ?? 0) / loja.fat * 100) : 0,
        atendimentosComCliente: loja.atendCliente, percentClienteIdentificado: loja.atend ? r2(loja.atendCliente / loja.atend * 100) : 0,
        atendimentos1PecaBarata: loja.atend1Barata, percentAtendimentos1PecaBarata: loja.atend ? r2(loja.atend1Barata / loja.atend * 100) : 0,
        pecasBaratasSozinhas: r2(loja.baratasSozinhas), pecasBaratasAcrescimo: r2(loja.baratasAcrescimo), pecasBaratasSoBaratas: r2(loja.baratasSoBaratas),
        vendasAtipicas: loja.atipAt ? { atendimentos: loja.atipAt, pecas: r2(loja.atipPecas), faturamento: r2(loja.atipFat), limitePecas: r2(limQ), limiteValor: r2(limV) } : null,
      },
      vendedores,
      inativosOcultos: inativos.length, faturamentoInativos: r2(inativos.reduce((t, v) => t + v.faturamento, 0)),
      pecasBaratas: {
        produtos: baratos.size,
        lista: [...baratos.values()].sort((x, y) => y.qtd - x.qtd).slice(0, 300).map((b) => {
          const [vp, qp] = [...b.vend.entries()].sort((x, y) => y[1] - x[1])[0] ?? ['sem', 0];
          return { produtoId: b.produtoId, descricao: b.descricao, codigoSistema: b.codigoSistema, pecas: r2(b.qtd), faturamento: r2(b.fat), precoMedio: b.qtd ? r2(b.fat / b.qtd) : 0,
            percentDasBaratas: loja.pecasBaratas ? r2(b.qtd / loja.pecasBaratas * 100) : 0, vendedores: b.vend.size,
            quemMaisVendeu: vp === 'sem' ? 'Sem vendedor informado' : (repInfo.get(vp)?.nome ?? `Vendedor ${vp}`), pecasQuemMaisVendeu: r2(qp),
            pecasSozinha: r2(b.sozinha), pecasAcrescimo: r2(b.acrescimo), pecasSoBaratas: r2(b.soBaratas),
            // papel do produto: entrada/acrescimo (sai junto de peca maior) x venda sozinha
            papel: b.qtd < 5 ? 'pouco_volume' : b.acrescimo / b.qtd >= 0.5 ? 'acrescimo' : b.sozinha / b.qtd >= 0.5 ? 'sozinha' : 'misto' };
        }),
      },
    };
  }

  const lojas: any[] = [];
  for (let i = 0; i < nomes.length; i += 6) lojas.push(...await Promise.all(nomes.slice(i, i + 6).map(processar)));
  const ok = lojas.filter((l) => !l.erro);
  const tot = ok.reduce((t, l) => ({ fat: t.fat + l.loja.faturamento, at: t.at + l.loja.atendimentos, pc: t.pc + l.loja.pecas, pb: t.pb + l.loja.pecas * l.loja.percentPecasAbaixoLimite / 100 }), { fat: 0, at: 0, pc: 0, pb: 0 });
  return {
    parametros: { dias, desde, ate, precoLimite, percentAlerta, metaIdentificacao },
    rede: { faturamento: r2(tot.fat), atendimentos: tot.at, pecas: r2(tot.pc), pecasPorAtendimento: tot.at ? r2(tot.pc / tot.at) : 0, ticketMedio: tot.at ? r2(tot.fat / tot.at) : 0, percentPecasAbaixoLimite: tot.pc ? r2(tot.pb / tot.pc * 100) : 0 },
    lojas: lojas.sort((a, b) => a.nomeLoja.localeCompare(b.nomeLoja)),
  };
}

// =====================================================================
// COMPATIBILIDADE ENTRE LOJAS — mix de produtos + perfil de compra
// Mix: soma, produto a produto, da menor participacao no faturamento das duas lojas
// (100% = mesma cesta nas mesmas proporcoes; independe do porte da loja).
// =====================================================================
function chaveProdutoRede(p: any): { k: string; porEan: boolean } {
  const ean = soDigitos(p?.codigoBarras);
  if (ean.length >= 8 && ean.length <= 14 && !/^(\d)\1+$/.test(ean)) return { k: 'E:' + ean, porEan: true };
  return { k: 'D:' + limpa(p?.descricao), porEan: false };
}

async function moduloCompatibilidade(apiBase: string, lojasTokens: Record<string, string>, body: any) {
  const isoData = (x: unknown) => { const m = String(x ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  let dIni = isoData(body.desde), dFim = isoData(body.ate);
  if (!dIni || !dFim) { const n = Math.min(366, Math.max(7, Number(body.dias ?? 90))); dFim = new Date(); dIni = new Date(dFim); dIni.setDate(dIni.getDate() - (n - 1)); }
  if (dIni > dFim) [dIni, dFim] = [dFim, dIni];
  const desde = fmtBR(dIni), ate = fmtBR(dFim);
  const precoLimite = Number(body.precoLimite ?? 49.99);
  const filtro: string[] | null = body.lojas ?? null;
  const nomes = filtro && filtro.length ? filtro.filter((n) => lojasTokens[n]) : Object.keys(lojasTokens);
  const minParticipacao = Number(body.minParticipacaoOportunidade ?? 0.4) / 100;

  type Loja = { nome: string; erro?: string; fat: number; pecas: number; atend: number; pecasBaratas: number; prod: Map<string, { desc: string; fat: number; qtd: number }>; fatEan: number };
  async function carregar(nome: string): Promise<Loja> {
    const L: Loja = { nome, fat: 0, pecas: 0, atend: 0, pecasBaratas: 0, prod: new Map(), fatEan: 0 };
    try {
      const processarVendas = (saidas: any[]) => { for (const sd of saidas) {
        if (!ehVenda(sd)) continue;
        let algum = false;
        for (const it of sd.mercadorias ?? []) {
          const q = Number(it.quantidade ?? 0), v = Number(it.valorTotal ?? 0);
          if (!(q > 0) || !(v > 0)) continue;
          algum = true;
          const { k, porEan } = chaveProdutoRede(it.produto);
          const cur = L.prod.get(k) ?? { desc: it.produto?.descricao ?? '', fat: 0, qtd: 0 };
          cur.fat += v; cur.qtd += q; L.prod.set(k, cur);
          L.fat += v; L.pecas += q; if (porEan) L.fatEan += v;
          if (v / q < precoLimite) L.pecasBaratas += q;
        }
        if (algum) L.atend++;
      } };
      await buscarSaidasParalelo(apiBase, lojasTokens[nome], dIni!, dFim!, (sd) => processarVendas([sd]));
    } catch (e) { L.erro = e instanceof Error ? e.message : String(e); }
    return L;
  }
  // Modo "loja": devolve so o agregado de UMA loja; o painel junta as lojas e calcula a compatibilidade.
  if (body.modo === 'loja') {
    const nome = nomes[0];
    if (!nome) throw new Error('Loja invalida.');
    const L = await carregar(nome);
    return { parametros: { desde, ate, precoLimite }, loja: nome, erro: L.erro ?? null, faturamento: r2(L.fat), pecas: r2(L.pecas), atendimentos: L.atend, pecasBaratas: r2(L.pecasBaratas), faturamentoEan: r2(L.fatEan),
      produtos: [...L.prod.entries()].map(([k, p]) => [k, p.desc, r2(p.fat)]) };
  }
  const todas: Loja[] = [];
  for (let i = 0; i < nomes.length; i += 6) todas.push(...await Promise.all(nomes.slice(i, i + 6).map(carregar)));
  const lojas = todas.filter((l) => !l.erro && l.fat > 0);

  // participacoes
  const share = new Map<string, Map<string, number>>();
  for (const l of lojas) { const m = new Map<string, number>(); for (const [k, p] of l.prod) m.set(k, p.fat / l.fat); share.set(l.nome, m); }
  const perfil = (l: Loja) => ({ precoMedioPeca: l.pecas ? l.fat / l.pecas : 0, ticket: l.atend ? l.fat / l.atend : 0, pa: l.atend ? l.pecas / l.atend : 0, pctBaratas: l.pecas ? l.pecasBaratas / l.pecas * 100 : 0 });
  const perfis = new Map(lojas.map((l) => [l.nome, perfil(l)]));
  const simNum = (a: number, b: number) => { const m = Math.max(Math.abs(a), Math.abs(b)); return m ? 1 - Math.abs(a - b) / m : 1; };
  const simPerfil = (a: any, b: any) => (simNum(a.precoMedioPeca, b.precoMedioPeca) + simNum(a.ticket, b.ticket) + simNum(a.pa, b.pa) + (1 - Math.abs(a.pctBaratas - b.pctBaratas) / 100)) / 4;

  const nomeProd = (k: string) => { for (const l of lojas) { const p = l.prod.get(k); if (p?.desc) return p.desc; } return k.slice(2); };
  const pares: any[] = [];
  const matriz: Record<string, Record<string, number>> = {};
  for (let i = 0; i < lojas.length; i++) for (let j = i + 1; j < lojas.length; j++) {
    const A = lojas[i], B = lojas[j], sa = share.get(A.nome)!, sb = share.get(B.nome)!;
    const [menor, maior] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
    let overlap = 0, comuns = 0;
    for (const [k, v] of menor) { const w = maior.get(k); if (w != null) { overlap += Math.min(v, w); comuns++; } }
    const uniao = sa.size + sb.size - comuns;
    const mix = r2(overlap * 100), perf = r2(simPerfil(perfis.get(A.nome), perfis.get(B.nome)) * 100);
    const geral = r2(mix * 0.7 + perf * 0.3);
    (matriz[A.nome] ??= {})[B.nome] = mix; (matriz[B.nome] ??= {})[A.nome] = mix;
    pares.push({ a: A.nome, b: B.nome, mix, perfil: perf, geral, produtosEmComum: comuns, percentSortimentoEmComum: uniao ? r2(comuns / uniao * 100) : 0 });
  }

  // detalhes para as 5 lojas mais compativeis de cada loja (gemeas)
  const detalhePar = (an: string, bn: string) => {
    const sa = share.get(an)!, sb = share.get(bn)!;
    const comum: any[] = [], soA: any[] = [], soB: any[] = [];
    for (const [k, v] of sa) { const w = sb.get(k) ?? 0; if (w > 0) comum.push({ k, a: v, b: w, peso: Math.min(v, w) }); if (v - w > 0.002) soA.push({ k, a: v, b: w, dif: v - w }); }
    for (const [k, w] of sb) { const v = sa.get(k) ?? 0; if (w - v > 0.002) soB.push({ k, a: v, b: w, dif: w - v }); }
    const fmt = (x: any) => ({ produto: nomeProd(x.k), participacaoA: r2(x.a * 100), participacaoB: r2(x.b * 100) });
    return {
      explicam: comum.sort((x, y) => y.peso - x.peso).slice(0, 12).map((x) => ({ ...fmt(x), contribuicao: r2(x.peso * 100) })),
      maisFortesEmA: soA.sort((x, y) => y.dif - x.dif).slice(0, 8).map(fmt),
      maisFortesEmB: soB.sort((x, y) => y.dif - x.dif).slice(0, 8).map(fmt),
    };
  };
  const corte = Number(body.corteGrupo ?? 60);
  const porLoja: any[] = [];
  const detalhes: Record<string, any> = {};
  for (const l of lojas) {
    const gemeas = pares.filter((p) => p.a === l.nome || p.b === l.nome)
      .map((p) => ({ loja: p.a === l.nome ? p.b : p.a, mix: p.mix, perfil: p.perfil, geral: p.geral, produtosEmComum: p.produtosEmComum, percentSortimentoEmComum: p.percentSortimentoEmComum }))
      .sort((x, y) => y.geral - x.geral);
    for (const g of gemeas.slice(0, 5)) { const key = [l.nome, g.loja].sort().join('||'); if (!detalhes[key]) { const [x, y] = key.split('||'); detalhes[key] = { a: x, b: y, ...detalhePar(x, y) }; } }
    // oportunidades: produtos fortes nas lojas gemeas de verdade (compatibilidade >= corte), ponderado pela compatibilidade
    const top = gemeas.filter((g) => g.geral >= corte).slice(0, 3);
    const sa = share.get(l.nome)!;
    const media = new Map<string, number>();
    const somaPeso = top.reduce((t, g) => t + g.geral, 0);
    for (const g of top) for (const [k, v] of share.get(g.loja)!) media.set(k, (media.get(k) ?? 0) + v * g.geral / somaPeso);
    const oportunidades = [...media.entries()]
      .filter(([k, m]) => m >= minParticipacao && (sa.get(k) ?? 0) < m * 0.25)
      .map(([k, m]) => ({ produto: nomeProd(k), participacaoGemeas: r2(m * 100), participacaoAqui: r2((sa.get(k) ?? 0) * 100), vendeAqui: (sa.get(k) ?? 0) > 0,
        lojasQueVendem: top.filter((g) => (share.get(g.loja)!.get(k) ?? 0) > 0).length, potencialPeriodo: r2((m - (sa.get(k) ?? 0)) * l.fat) }))
      .sort((x, y) => y.potencialPeriodo - x.potencialPeriodo).slice(0, 25);
    const pf = perfis.get(l.nome)!;
    porLoja.push({ loja: l.nome, faturamento: r2(l.fat), produtosVendidos: l.prod.size, percentFatPorEan: r2(l.fatEan / l.fat * 100),
      perfil: { precoMedioPeca: r2(pf.precoMedioPeca), ticket: r2(pf.ticket), pa: r2(pf.pa), pctBaratas: r2(pf.pctBaratas) },
      gemeas, gemeasUsadas: top.map((g) => g.loja), oportunidades, potencialTotal: r2(oportunidades.reduce((s, o) => s + o.potencialPeriodo, 0)) });
  }
  // grupos: liga lojas com compatibilidade geral >= corte (componentes conectados)
  const pai = new Map(lojas.map((l) => [l.nome, l.nome]));
  const raiz = (x: string): string => pai.get(x) === x ? x : raiz(pai.get(x)!);
  for (const p of pares) if (p.geral >= corte) pai.set(raiz(p.a), raiz(p.b));
  const gm = new Map<string, string[]>();
  for (const l of lojas) { const r = raiz(l.nome); if (!gm.has(r)) gm.set(r, []); gm.get(r)!.push(l.nome); }
  const grupos = [...gm.values()].filter((g) => g.length > 1).map((g) => ({ lojas: g.sort(), compatibilidadeMedia: r2(mediaDe(pares.filter((p) => g.includes(p.a) && g.includes(p.b)).map((p) => p.geral))) })).sort((a, b) => b.lojas.length - a.lojas.length);

  return {
    parametros: { desde, ate, precoLimite, corteGrupo: corte, pesos: { mix: 70, perfil: 30 } },
    lojas: porLoja.sort((a, b) => a.loja.localeCompare(b.loja)),
    matriz, pares: pares.sort((a, b) => b.geral - a.geral), detalhes, grupos,
    erros: todas.filter((l) => l.erro).map((l) => ({ loja: l.nome, erro: l.erro })),
    semVendas: todas.filter((l) => !l.erro && !(l.fat > 0)).map((l) => l.nome),
  };
}
const mediaDe = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

// =====================================================================
// EDITAR CADASTRO DA LOJA (lojas_config). Token em branco = mantem o atual.
// Renomear propaga o nome para as tabelas que guardam o nome da loja.
// =====================================================================
async function moduloLojaEditar(body: any) {
  const nomeAtual = String(body.nomeAtual ?? '').trim();
  if (!nomeAtual) throw new Error('Informe a loja a editar.');
  const s = sb();
  const { data: atual, error: e0 } = await s.from('lojas_config').select('nome').eq('nome', nomeAtual).maybeSingle();
  if (e0) throw new Error(`Erro ao ler a loja: ${e0.message}`);
  if (!atual) throw new Error(`Loja "${nomeAtual}" nao encontrada.`);

  const patch: Record<string, unknown> = {};
  const novoNome = String(body.nome ?? '').trim().replace(/\s+/g, ' ');
  if (novoNome && novoNome !== nomeAtual) {
    const { data: dup } = await s.from('lojas_config').select('nome').eq('nome', novoNome).maybeSingle();
    if (dup) throw new Error(`Ja existe uma loja chamada "${novoNome}".`);
    patch.nome = novoNome;
  }
  if (body.cnpj !== undefined) {
    const c = soDigitos(body.cnpj);
    if (c && c.length !== 14) throw new Error('CNPJ deve ter 14 digitos.');
    patch.cnpj = c ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : null;
  }
  const token = String(body.token ?? '').trim();
  if (token) {
    // valida o token antes de salvar: uma chamada leve na VarejOnline
    const base = Deno.env.get('VAREJONLINE_API_BASE');
    if (base) {
      const r = await fetch(`${base}/representantes?inicio=0&quantidade=1&token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (r && (r.status === 401 || r.status === 403)) throw new Error('A VarejOnline recusou este token (sem permissao ou invalido). Nada foi alterado.');
    }
    patch.token = token;
  }
  if (!Object.keys(patch).length) return { ok: true, alterado: false };

  const { error: e1 } = await s.from('lojas_config').update(patch).eq('nome', nomeAtual);
  if (e1) throw new Error(`Erro ao salvar: ${e1.message}`);

  const propagado: string[] = [], naoPropagado: string[] = [];
  if (patch.nome) {
    for (const [tabela, coluna] of [['metas_faturamento', 'loja'], ['perfil_lojas', 'loja'], ['pedidos_vinculos', 'loja'], ['pedidos_sugeridos', 'loja'], ['vendas_cache_dias', 'loja'], ['dre_importado', 'loja']]) {
      const { error, count } = await s.from(tabela).update({ [coluna]: patch.nome }, { count: 'exact' }).eq(coluna, nomeAtual);
      if (!error) { if (count) propagado.push(`${tabela} (${count})`); }
      else if (!/does not exist|could not find|schema cache/i.test(error.message)) naoPropagado.push(`${tabela}: ${error.message}`);
    }
  }
  if (patch.nome) {
    const { data: us } = await s.from('usuarios_painel').select('user_id, lojas').contains('lojas', [nomeAtual]);
    for (const u of us ?? []) await s.from('usuarios_painel').update({ lojas: (u.lojas ?? []).map((l: string) => l === nomeAtual ? patch.nome : l) }).eq('user_id', u.user_id);
    if (us?.length) propagado.push(`usuarios_painel (${us.length})`);
  }
  return { ok: true, alterado: true, campos: Object.keys(patch).filter((k) => k !== 'token').concat(patch.token ? ['token'] : []), propagado, naoPropagado };
}

// Fornecedores com grade de tamanhos no pedido (nome contendo os termos). Secret opcional FORNECEDORES_GRADE="EMPORIUM DA BIJUTERIA,OUTRO".
function fornecedorTemGrade(nome: unknown) {
  const termos = (Deno.env.get('FORNECEDORES_GRADE') ?? 'EMPORIUM DA BIJUTERIA').split(',').map((t: string) => limpa(t)).filter(Boolean);
  const n = limpa(nome).replace(/\bBIJOUTERIA\b/g, 'BIJUTERIA');
  return termos.some((t: string) => n.includes(t.replace(/\bBIJOUTERIA\b/g, 'BIJUTERIA')));
}

// =====================================================================
// LIGACAO PRODUTO DA LOJA -> ITEM DA CENTRAL (usada no pedido e na tela de vinculos)
// Ordem: vinculo manual exato (produto -> codigo+variacao) > vinculo antigo por codigo > codigo igual > descricao igual.
// =====================================================================
const TABELA_VINCULOS = 'vinculos_produto_rede';
// Os cadastros de produto sao iguais em todas as lojas: o vinculo vale para a rede inteira.
// Identidade do produto = codigo do sistema da VarejOnline (ou o id, se nao houver codigo).
const chaveProduto = (r: { codigoSistema?: unknown; produtoId?: unknown }) => {
  const c = codNorm(r.codigoSistema);
  return c ? `C:${c}` : `I:${String(r.produtoId ?? '')}`;
};
const resumoItemCentral = (c: any) => ({ chave: c.chave, codigo: c.codigo, descricao: c.descricao, variacao: c.variacao, variacaoDescricao: c.variacaoDescricao ?? c.variacao, corBase: c.corBase ?? corBase(c.variacaoDescricao ?? c.variacao), preco: c.preco, qtdMinima: c.qtdMinima, qtdMaxima: c.qtdMaxima, fatorConversao: c.fatorConversao, idProduto: c.idProduto, emEstoque: c.emEstoque, fornecedorId: c.fornecedorId, fornecedorNome: c.fornecedorNome, categoria: c.categoria, ultimaCompra: c.ultimaCompra, qtdRede: c.qtdTotal ?? 0 });

// Formas alternativas de um código da Central: "0972/8062" vale 0972 e 8062; código da loja escrito na
// descrição ("COLAR FIO ESPÍRITO SANTO 0104.0001") também vale.
function codigosAlternativos(it: any): string[] {
  const out = new Set<string>();
  const c = codNorm(it.codigo);
  if (c.includes('/')) for (const p of c.split('/')) if (p.length >= 3) out.add(p);
  for (const m of String(it.descricao ?? '').toUpperCase().matchAll(/\b(\d{3,6}\.\d{2,4})\b/g)) out.add(m[1]);
  out.delete(c);
  return [...out];
}
// "00003D-CA-001" na loja = "3D-CA-001" na Central: zeros à esquerda não mudam o código
const semZeros = (c: string) => { const z = c.replace(/^0+/, ''); return z.length >= 3 ? z : ''; };
const baseCodigo = (c: string) => { const b = c.split('.')[0]; return b.length >= 3 && b !== c ? b : ''; };
function indexarCatalogo(cat: any) {
  const porCodigo = new Map<string, any[]>(), porDesc = new Map<string, any[]>(), porChave = new Map<string, any>(), porFamilia = new Map<string, any[]>();
  const porCodigoAlt = new Map<string, any[]>(), porBase = new Map<string, any[]>(), porSemZeros = new Map<string, any[]>();
  const add = (m: Map<string, any[]>, k: string, it: any) => { if (!k) return; if (!m.has(k)) m.set(k, []); if (!m.get(k)!.includes(it)) m.get(k)!.push(it); };
  for (const it of cat.itens) {
    porChave.set(it.chave, it);
    const kf = familiaDoItem(it); if (kf) { if (!porFamilia.has(kf)) porFamilia.set(kf, []); porFamilia.get(kf)!.push(it); }
    const c = codNorm(it.codigo); if (c) { if (!porCodigo.has(c)) porCodigo.set(c, []); porCodigo.get(c)!.push(it); }
    for (const alt of codigosAlternativos(it)) { add(porCodigoAlt, alt, it); add(porBase, baseCodigo(alt), it); if (!alt.includes('.')) add(porBase, alt, it); }
    add(porBase, baseCodigo(c), it); if (!c.includes('.')) add(porBase, c, it);
    add(porSemZeros, semZeros(c), it); for (const alt of codigosAlternativos(it)) add(porSemZeros, semZeros(alt), it);
    for (const desc of it.descricoes?.length ? it.descricoes : [it.descricao]) {
      for (const d of [limpa(desc), limpa(`${desc} ${it.variacao}`)]) { if (!d) continue; if (!porDesc.has(d)) porDesc.set(d, []); if (!porDesc.get(d)!.includes(it)) porDesc.get(d)!.push(it); }
    }
    if (it.referencia) { const rf = codNorm(it.referencia); if (!porCodigo.has(rf)) porCodigo.set(rf, []); if (!porCodigo.get(rf)!.includes(it)) porCodigo.get(rf)!.push(it); }
  }
  return { porCodigo, porCodigoAlt, porBase, porSemZeros, porDesc, porChave, porFamilia, itens: cat.itens };
}

// Vinculos da propria loja (cada loja tem sua conta na VarejOnline e o id do produto pode coincidir entre contas).
// Lê a tabela inteira em páginas de 1000 (o Supabase devolve no máximo 1000 linhas por consulta).
async function lerTudo(tabela: string, campos: string, ordem: string, filtro?: (q: any) => any): Promise<{ data: any[]; error: any }> {
  const out: any[] = [];
  for (let de = 0; de < 500_000; de += 1000) {
    let q = sb().from(tabela).select(campos).order(ordem, { ascending: true }).range(de, de + 999);
    if (filtro) q = filtro(q);
    const r: any = await q;
    if (r.error) return { data: out, error: r.error };
    out.push(...(r.data ?? []));
    if ((r.data ?? []).length < 1000) break;
  }
  return { data: out, error: null };
}

let colunaChavesGrade: boolean | null = null; // a coluna chaves_grade já existe no banco?
async function carregarVinculosLoja(loja: string) {
  const novos = new Map<string, any>(), antigos = new Map<string, string>();
  let tabelaNova = true;
  let r1: any = await lerTudo(TABELA_VINCULOS, 'produto_chave, produto_id, chave_central, codigo_central, variacao, ignorar, grade, chaves_grade, motivo, loja_origem, atualizado_por, atualizado_em', 'produto_chave');
  if (r1.error && /chaves_grade/i.test(r1.error.message)) r1 = await lerTudo(TABELA_VINCULOS, 'produto_chave, produto_id, chave_central, codigo_central, variacao, ignorar, grade, motivo, loja_origem, atualizado_por, atualizado_em', 'produto_chave');
  // antes de rodar o SQL da grade a coluna nao existe: le sem ela
  if (r1.error && /grade/i.test(r1.error.message)) r1 = await lerTudo(TABELA_VINCULOS, 'produto_chave, produto_id, chave_central, codigo_central, variacao, ignorar, motivo, loja_origem, atualizado_por, atualizado_em', 'produto_chave');
  if (r1.error) tabelaNova = false; else for (const v of r1.data ?? []) novos.set(String(v.produto_chave), v);
  // vinculos antigos (por codigo da Central) continuam como reserva, so da propria loja
  const r2 = await lerTudo('pedidos_vinculos', 'loja, codigo_central, produto_id, ignorar', 'produto_id', (q) => q.eq('loja', loja));
  for (const v of r2.data ?? []) if (!v.ignorar && v.produto_id != null) antigos.set(String(v.produto_id), String(v.codigo_central));
  return { novos, antigos, tabelaNova };
}

function casarProduto(r: any, idx: ReturnType<typeof indexarCatalogo>, vinc: { novos: Map<string, any>; antigos: Map<string, string> }) {
  const pid = String(r.produtoId);
  const vn = vinc.novos.get(chaveProduto(r));
  if (vn?.ignorar) return { via: 'ignorado', item: null, variacaoIncerta: false, alternativas: [] as any[], motivo: vn.motivo ?? null };
  if (vn?.chave_central) {
    let it = idx.porChave.get(vn.chave_central);
    if (!it && vn.codigo_central) {
      const cs = (idx.porCodigo.get(codNorm(vn.codigo_central)) ?? []).filter((x: any) => codNorm(x.codigo) === codNorm(vn.codigo_central));
      it = cs.find((x: any) => limpa(x.variacaoDescricao ?? x.variacao) === limpa(vn.variacao)) ?? cs.find((x: any) => varNorm(x.variacaoDescricao ?? x.variacao) === varNorm(vn.variacao)) ?? (cs.length === 1 ? cs[0] : undefined);
    }
    const extras = (Array.isArray(vn.chaves_grade) ? vn.chaves_grade : []).map((ch: string) => idx.porChave.get(String(ch))).filter((x: any) => x && x !== it);
    if (it && extras.length) return { via: 'vínculo', item: it, variacaoIncerta: false, grade: true, gradeEscolhida: [it, ...extras], alternativas: (idx.porCodigo.get(codNorm(it.codigo)) ?? []).filter((x: any) => x !== it).slice(0, 5) };
    if (it) return { via: 'vínculo', item: it, variacaoIncerta: false, grade: !!vn.grade, alternativas: (idx.porCodigo.get(codNorm(it.codigo)) ?? []).filter((x: any) => x !== it).slice(0, 5) };
    // item vinculado sumiu do catalogo (sem pedidos no periodo): cai para as outras regras, avisando
  }
  let cands: any[] = [], via = '';
  const vc = vinc.antigos.get(pid);
  if (vc && idx.porCodigo.has(vc)) { cands = idx.porCodigo.get(vc)!; via = 'vínculo (código)'; }
  for (const cod of [r.codigoSistema, r.codigoInterno]) {
    if (!cands.length && cod && idx.porCodigo.has(codNorm(cod))) { cands = idx.porCodigo.get(codNorm(cod))!; via = 'código'; }
  }
  // código alternativo da Central ("0972/8062", código da loja escrito na descrição) e, por último,
  // a base do código da loja ("8062.0001" → 8062) contra a base dos códigos da Central
  for (const cod of [r.codigoSistema, r.codigoInterno]) {
    if (!cands.length && cod && idx.porCodigoAlt?.has(codNorm(cod))) { cands = idx.porCodigoAlt.get(codNorm(cod))!; via = 'código'; }
  }
  // mesmo código sem os zeros à esquerda; se o que sobra é só número, exige descrição parecida
  for (const cod of [r.codigoSistema, r.codigoInterno]) {
    const z = cod ? semZeros(codNorm(cod)) : '';
    if (cands.length || !z || !idx.porSemZeros?.has(z)) continue;
    const lista = idx.porSemZeros.get(z)!;
    const ok = /^[\d.]+$/.test(z) ? lista.filter((c: any) => jaccard(tokens(r.descricao), tokens(c.descricao)) >= 0.3) : lista;
    if (ok.length) { cands = ok; via = 'código'; }
  }
  for (const cod of [r.codigoSistema, r.codigoInterno]) {
    const b = cod ? baseCodigo(codNorm(cod)) || codNorm(cod) : '';
    // só aceita a base se a descrição for parecida (evita juntar produtos diferentes com o mesmo número)
    const parecidos = !cands.length && b && idx.porBase?.has(b) ? idx.porBase.get(b)!.filter((c: any) => jaccard(tokens(r.descricao), tokens(c.descricao)) >= 0.4) : [];
    if (parecidos.length) { cands = parecidos; via = 'código (base)'; }
  }
  if (!cands.length && idx.porDesc.has(limpa(r.descricao))) { cands = idx.porDesc.get(limpa(r.descricao))!; via = 'descrição'; }
  if (!cands.length) return { via: vn?.chave_central ? 'vínculo quebrado' : 'sem', item: null, variacaoIncerta: false, alternativas: [] as any[] };
  // escolhe a variacao: descricao identica = 1; senao similaridade + bonus se o nome da variacao aparece no produto da loja
  const tr = tokens(r.descricao);
  const trV = tokensVar(r.descricao);
  const tamLoja = tokensTamanho(r.descricao);
  const pontuar = (c: any) => {
    const descs: string[] = c.descricoes?.length ? c.descricoes : [c.descricao];
    if (descs.some((d) => limpa(d) === limpa(r.descricao) || limpa(`${d} ${c.variacao}`) === limpa(r.descricao))) return 1;
    // cor: todas as palavras da cor aparecem no produto da loja
    const tv = tokensVar(c.variacaoDescricao ?? c.variacao);
    const contemCor = tv.size > 0 && [...tv].every((t) => trV.has(t));
    // tamanho: compara so as medidas/tamanhos; tamanho diferente derruba a nota
    const tc = new Set<string>(c.tamanho ?? []);
    const temTam = tc.size > 0 && tamLoja.size > 0;
    const tamanhoOk = temTam && [...tc].every((t) => tamLoja.has(t));
    const tamanhoConflita = temTam && !tamanhoOk;
    const sim = Math.max(...descs.map((d) => jaccard(tr, tokens(`${d} ${c.variacao}`))));
    let nota = sim * 0.5 + (contemCor ? 0.3 : 0) + (tamanhoOk ? 0.2 : 0);
    if (tamanhoConflita) nota *= 0.3;
    return Math.min(0.99, nota);
  };
  const pont = cands.map((c) => ({ c, sc: pontuar(c) })).sort((a, b) => b.sc - a.sc || b.c.vezes - a.c.vezes);
  const variacaoIncerta = cands.length > 1 && pont[0].sc < 1 && (pont.length < 2 || pont[0].sc - pont[1].sc < 0.15);
  return { via, item: pont[0].c, variacaoIncerta, alternativas: pont.slice(1, 6).map((x) => x.c), vinculoQuebrado: !!vn?.chave_central };
}

// Tamanhos do mesmo codigo, fornecedor e cor (so para fornecedores com grade).
function tamanhosDaGrade(idx: ReturnType<typeof indexarCatalogo>, it: any): any[] {
  if (!it || !fornecedorTemGrade(it.fornecedorNome)) return [];
  const cb = it.corBase ?? corBase(it.variacaoDescricao ?? it.variacao);
  return (idx.porCodigo.get(codNorm(it.codigo)) ?? []).filter((x: any) => x.fornecedorId === it.fornecedorId && codNorm(x.codigo) === codNorm(it.codigo) && (x.corBase ?? corBase(x.variacaoDescricao ?? x.variacao)) === cb);
}

// Familia por letra: o mesmo produto de A a Z, cada letra com codigo proprio na Central
// (ex.: COLAR CHOKER DE CRISTAL 38CM E PINGENTE LETRA A ... LETRA Z). Vale para qualquer fornecedor.
const RE_LETRA = /\b(LETRA|INICIAL)\s+([A-Z])\b/;
function letraDe(desc: unknown): string | null { const m = limpa(desc).match(RE_LETRA); return m ? m[2] : null; }
function chaveFamiliaLetra(desc: unknown, variacao: unknown): string | null {
  const d = limpa(desc); if (!RE_LETRA.test(d)) return null;
  return `L:${d.replace(RE_LETRA, '$1 *')}|${limpa(variacao)}`;
}
const letraDaVariacao = (it: any): string | null => { const m = limpa(it.variacaoDescricao ?? it.variacao).match(/^([A-Z])( |$)/); return m ? m[1] : null; };
const letraDoItem = (it: any) => letraDe(it.descricao) ?? letraDaVariacao(it);
const familiaDoItem = (it: any) => { const k = chaveFamiliaLetra(it.descricao, String(it.chave ?? '').split('|')[1]); return k ? `${it.fornecedorId}|${k}` : null; };

// Grade do item: tamanhos do mesmo codigo/cor (fornecedores com grade) ou familia por letra.
// Tamanho no final do código da Central (4443.XPP, 4443.PP, 4443.P, 4443.M, 4443.G): cada tamanho é um código.
const ORDEM_TAM = ['XXPP', 'XPP', 'PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'EG', 'EGG', 'U', 'UN'];
function tamanhoDoCodigo(codigo: any): { base: string; tam: string } | null {
  const m = String(codigo ?? '').trim().toUpperCase().match(/^(.+)[.\-]([A-Z]{1,4})$/);
  return m && ORDEM_TAM.includes(m[2]) ? { base: m[1], tam: m[2] } : null;
}
const _porBaseTam = new WeakMap<any, Map<string, any[]>>();
function gradeTamanhoPorCodigo(idx: ReturnType<typeof indexarCatalogo>, it: any): any[] {
  const tc = tamanhoDoCodigo(it.codigo); if (!tc) return [];
  let mapa = _porBaseTam.get(idx);
  if (!mapa) { mapa = new Map(); for (const x of idx.itens) { const t = tamanhoDoCodigo(x.codigo); if (!t) continue; const k = `${x.fornecedorId}|${t.base}`; if (!mapa.has(k)) mapa.set(k, []); mapa.get(k)!.push(x); } _porBaseTam.set(idx, mapa); }
  const v = varNorm(it.variacaoDescricao ?? it.variacao ?? '');
  const mesmos = (mapa.get(`${it.fornecedorId}|${tc.base}`) ?? []).filter((x: any) => varNorm(x.variacaoDescricao ?? x.variacao ?? '') === v);
  const porTam = new Map<string, any>(); for (const x of mesmos) { const t = tamanhoDoCodigo(x.codigo)!.tam; if (!porTam.has(t)) porTam.set(t, x); }
  return [...porTam.entries()].sort((a, b) => ORDEM_TAM.indexOf(a[0]) - ORDEM_TAM.indexOf(b[0])).map(([, x]) => x);
}

function itensDaGrade(idx: ReturnType<typeof indexarCatalogo>, it: any): { tipo: 'tamanho' | 'letra' | 'cor'; itens: any[]; rotulos: string[] } | null {
  if (!it) return null;
  const t = tamanhosDaGrade(idx, it);
  if (t.length > 1) return { tipo: 'tamanho', itens: t, rotulos: t.map((x: any) => x.variacao) };
  const mesmos = (idx.porCodigo.get(codNorm(it.codigo)) ?? []).filter((x: any) => x.fornecedorId === it.fornecedorId && codNorm(x.codigo) === codNorm(it.codigo) && letraDaVariacao(x));
  if (mesmos.length >= 5 && letraDaVariacao(it)) {
    const ord = [...mesmos].sort((a: any, b: any) => String(letraDaVariacao(a)).localeCompare(String(letraDaVariacao(b))));
    return { tipo: 'letra', itens: ord, rotulos: ord.map((x: any) => letraDaVariacao(x)!) };
  }
  const kf = familiaDoItem(it);
  const fam = kf ? (idx.porFamilia.get(kf) ?? []) : [];
  if (fam.length > 1) {
    const ord = [...fam].sort((a: any, b: any) => String(letraDe(a.descricao)).localeCompare(String(letraDe(b.descricao))));
    return { tipo: 'letra', itens: ord, rotulos: ord.map((x: any) => letraDe(x.descricao) ?? '?') };
  }
  // Tamanhos em códigos diferentes, mesma cor (4443.PP|6, 4443.P|6, 4443.M|6…): vem antes da grade de cores
  const tcod = gradeTamanhoPorCodigo(idx, it);
  if (tcod.length > 1) return { tipo: 'tamanho', itens: tcod, rotulos: tcod.map((x: any) => tamanhoDoCodigo(x.codigo)!.tam) };
  // Grade de cores: o mesmo código e fornecedor em 2 ou mais cores (ex.: produto da loja "[ROSA, VERDE E AZUL]").
  const cores = (idx.porCodigo.get(codNorm(it.codigo)) ?? []).filter((x: any) => x.fornecedorId === it.fornecedorId && codNorm(x.codigo) === codNorm(it.codigo));
  if (new Set(cores.map((x: any) => x.corBase ?? corBase(x.variacaoDescricao ?? x.variacao))).size >= 2 && cores.length <= 40) {
    const ord = [...cores].sort((a: any, b: any) => String(a.variacao ?? '').localeCompare(String(b.variacao ?? ''), 'pt-BR', { numeric: true }));
    return { tipo: 'cor', itens: ord, rotulos: ord.map((x: any) => String(x.variacaoDescricao ?? x.variacao ?? '')) };
  }
  return null;
}

// =====================================================================
// CATALOGO FIXO DA CENTRAL (tabela catalogo_central)
// Itens vistos nos pedidos (origem 'pedido', com idProduto/unidade para envio pela API) + planilha "Peças da Central"
// (origem 'planilha'). Nada sai sozinho: um item sem pedido ha 180 dias continua no catalogo.
// =====================================================================
const TABELA_CATALOGO = 'catalogo_central';
let cacheFixo: { quando: number; itens: any[] } | null = null;
let ultimaGravacaoPedidos = 0;
async function carregarCatalogoFixo(forcar = false): Promise<any[]> {
  if (!forcar && cacheFixo && Date.now() - cacheFixo.quando < 10 * 60_000) return cacheFixo.itens;
  const out: any[] = [];
  for (let de = 0; de < 200_000; de += 1000) {
    const r: any = await sb().from(TABELA_CATALOGO).select('chave, codigo, descricao, variacao, fornecedor_id, fornecedor_nome, categoria, preco, qtd_minima, fator_conversao, id_produto, unidade, origem, ultima_compra').range(de, de + 999);
    if (r.error) { cacheFixo = { quando: Date.now(), itens: [] }; return []; } // SQL ainda nao rodado
    out.push(...(r.data ?? []));
    if ((r.data ?? []).length < 1000) break;
  }
  cacheFixo = { quando: Date.now(), itens: out };
  return out;
}
// Variacao sem numeracao e referencia: "1 - PRETO - 0382.0001" / "1-PRETO-5212" / "DOURADO - IV1009.0001" -> "PRETO" / "DOURADO"
const varNorm = (v: unknown) => limpa(String(v ?? '').trim().replace(/^\d{1,2}\s*-\s*/, '').replace(/\s*-\s*[A-Za-z]*\d[A-Za-z0-9.\/-]*\s*$/, ''));
const codVar = (codigo: unknown, variacao: unknown) => `${codNorm(codigo)}|${varNorm(variacao)}`;
// Acrescenta ao catalogo dos pedidos os itens do catalogo fixo que nao apareceram nos pedidos recentes.
function juntarCatalogoFixo<T extends { itens: any[]; fornecedores: any[] }>(cat: T, fixos: any[]): T {
  const temChave = new Set(cat.itens.map((i: any) => i.chave));
  const temCV = new Set(cat.itens.map((i: any) => codVar(i.codigo, i.variacaoDescricao ?? i.variacao)));
  const fornPorNome = new Map<string, string>(cat.fornecedores.map((f: any) => [limpa(f.nome), String(f.id)]));
  const ordem = [...fixos].sort((a, b) => Number(b.origem === 'pedido') - Number(a.origem === 'pedido'));
  for (const f of ordem) {
    const cv = codVar(f.codigo, f.variacao);
    if (temChave.has(f.chave) || temCV.has(cv)) continue;
    temChave.add(f.chave); temCV.add(cv);
    const fid = f.fornecedor_id ? String(f.fornecedor_id) : (fornPorNome.get(limpa(f.fornecedor_nome)) ?? `NOME:${limpa(f.fornecedor_nome)}`);
    const v = String(f.variacao ?? '');
    cat.itens.push({ chave: f.chave, codigo: String(f.codigo ?? ''), descricao: f.descricao, descricoes: [f.descricao], variacao: v, variacaoDescricao: v, corBase: corBase(v), tamanho: [...tokensTamanho(v)],
      referencia: null, categoria: f.categoria ?? null, fornecedorId: fid, fornecedorNome: f.fornecedor_nome ?? '', preco: Number(f.preco) || 0, qtdMinima: Number(f.qtd_minima) || 1, qtdMaxima: null,
      fatorConversao: Number(f.fator_conversao) || 1, idProduto: f.id_produto ?? null, unidade: f.unidade ?? null, ultimaCompra: f.ultima_compra ?? null, vezes: 0, qtdTotal: 0, lojas: 0, doCatalogoFixo: true });
  }
  return cat;
}
// Guarda no catalogo fixo os itens vistos nos pedidos (no maximo a cada 6 h por instancia).
async function gravarItensDosPedidos(cat: any) {
  if (Date.now() - ultimaGravacaoPedidos < 6 * 3600_000) return;
  ultimaGravacaoPedidos = Date.now();
  const agora = new Date().toISOString();
  const linhas = cat.itens.filter((i: any) => !i.doCatalogoFixo).map((i: any) => ({ chave: i.chave, codigo: i.codigo, descricao: i.descricao, variacao: i.variacaoDescricao ?? i.variacao ?? '',
    fornecedor_id: i.fornecedorId, fornecedor_nome: i.fornecedorNome, categoria: i.categoria ?? null, preco: i.preco, qtd_minima: i.qtdMinima, fator_conversao: i.fatorConversao,
    id_produto: i.idProduto ?? null, unidade: i.unidade ?? null, origem: 'pedido', ultima_compra: i.ultimaCompra ?? null, atualizado_em: agora }));
  for (let k = 0; k < linhas.length; k += 500) {
    const { error } = await sb().from(TABELA_CATALOGO).upsert(linhas.slice(k, k + 500), { onConflict: 'chave' });
    if (error) return; // tabela ainda nao existe
  }
  cacheFixo = null;
}

// Importacao da planilha "Peças da Central" (Fornecedor, Código, Nome, Variações, Custo): uma linha por variacao.
async function importarCatalogoPlanilha(itens: any[]) {
  if (!Array.isArray(itens) || !itens.length || itens.length > 3000) throw new Error('Envie de 1 a 3000 produtos por vez.');
  const t = await sb().from(TABELA_CATALOGO).select('chave').limit(1);
  if (t.error) throw new Error('Rode antes o SQL 20261105000003_catalogo_central.sql no Supabase.');
  const agora = new Date().toISOString();
  const linhas = new Map<string, any>();
  for (const p of itens) {
    const codigo = String(p.codigo ?? '').trim(), nome = String(p.nome ?? '').trim();
    if (!codigo || !nome) continue;
    const vars = String(p.variacoes ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    for (const v of vars.length ? vars : ['']) {
      const chave = chaveItem(codigo, v);
      linhas.set(chave, { chave, codigo, descricao: nome, variacao: v, fornecedor_nome: String(p.fornecedor ?? '').trim(), preco: Number(String(p.custo ?? '').replace(',', '.')) || null, origem: 'planilha', atualizado_em: agora });
    }
  }
  const todas = [...linhas.values()];
  // itens que ja vieram dos pedidos guardam idProduto/unidade: nao sobrescreve
  const dePedido = new Set<string>();
  for (let k = 0; k < todas.length; k += 300) {
    const r = await sb().from(TABELA_CATALOGO).select('chave, origem').in('chave', todas.slice(k, k + 300).map((x) => x.chave));
    for (const x of r.data ?? []) if (x.origem === 'pedido') dePedido.add(x.chave);
  }
  const gravar = todas.filter((x) => !dePedido.has(x.chave));
  for (let k = 0; k < gravar.length; k += 500) {
    const { error } = await sb().from(TABELA_CATALOGO).upsert(gravar.slice(k, k + 500), { onConflict: 'chave' });
    if (error) throw new Error(`Erro ao gravar o catálogo: ${error.message}`);
  }
  cacheFixo = null; cacheCatalogo = null;
  return { ok: true, produtos: itens.length, variacoes: todas.length, gravadas: gravar.length, jaVistasEmPedidos: dePedido.size };
}

// =====================================================================
// DRE IMPORTADO POR PLANILHA (tabela dre_importado)
// importar: { loja, arquivo, meses: [{ competencia:'AAAA-MM', linhas:[{ ordem, linha, tipo, valor }] }] }
//           substitui os meses enviados daquela loja
// listar:   { lojas?, desde:'AAAA-MM', ate:'AAAA-MM' } -> linhas por loja e mes
// =====================================================================
async function moduloDre(body: any, a: Acesso) {
  const acao = String(body.acao ?? '');
  const t = await sb().from('dre_importado').select('loja').limit(1);
  if (t.error) throw new Error('Rode antes o SQL 20261106000001_dre_importado.sql no Supabase.');
  if (acao === 'importar') {
    const loja = String(body.loja ?? '').trim();
    if (!loja) throw new Error('Escolha a loja do DRE.');
    exigirLoja(a, loja);
    const meses: any[] = Array.isArray(body.meses) ? body.meses : [];
    if (!meses.length || meses.length > 24) throw new Error('Nenhum mês com valores na planilha.');
    const agora = new Date().toISOString(), quem = a.nome || String(body.usuario ?? '') || null;
    const linhas: any[] = [];
    for (const m of meses) {
      const comp = String(m.competencia ?? '');
      if (!/^\d{4}-\d{2}$/.test(comp)) throw new Error(`Mês inválido: ${comp}`);
      const vistos = new Set<string>();
      for (const l of (m.linhas ?? []).slice(0, 300)) {
        const nome = String(l.linha ?? '').trim().slice(0, 120); const valor = Number(l.valor);
        if (!nome || !Number.isFinite(valor) || vistos.has(nome)) continue;
        vistos.add(nome);
        linhas.push({ loja, competencia: comp, ordem: Number(l.ordem) || 0, linha: nome, tipo: l.tipo === 'total' ? 'total' : 'item', valor: Math.round(valor * 100) / 100, arquivo: String(body.arquivo ?? '').slice(0, 200) || null, importado_por: quem, importado_em: agora });
      }
    }
    const comps = [...new Set(linhas.map((l) => l.competencia))];
    const del = await sb().from('dre_importado').delete().eq('loja', loja).in('competencia', comps);
    if (del.error) throw new Error(`Erro ao limpar meses: ${del.error.message}`);
    for (let k = 0; k < linhas.length; k += 500) {
      const { error } = await sb().from('dre_importado').insert(linhas.slice(k, k + 500));
      if (error) throw new Error(`Erro ao gravar o DRE: ${error.message}`);
    }
    return { ok: true, loja, meses: comps.sort(), linhas: linhas.length };
  }
  if (acao === 'listar') {
    const lojas = lojasDoAcesso(a, Array.isArray(body.lojas) && body.lojas.length ? body.lojas : undefined);
    let q = sb().from('dre_importado').select('loja, competencia, ordem, linha, tipo, valor, arquivo, importado_por, importado_em')
      .gte('competencia', String(body.desde ?? '0000-00')).lte('competencia', String(body.ate ?? '9999-99')).order('ordem').limit(5000);
    if (lojas) q = q.in('loja', lojas);
    const r = await q;
    if (r.error) throw new Error(r.error.message);
    return { linhas: r.data ?? [] };
  }
  throw new Error('Ação de DRE desconhecida.');
}

// Pre-aquecimento: para cada loja, garante no cache os ultimos N dias de vendas (so baixa o que falta)
// e atualiza o cache dos pedidos da Central. Para de comecar lojas novas perto do limite de tempo;
// a tarefa agendada chama de novo ate vir completo=true.
// Fotos dos produtos (cadastro da VarejOnline, campo urlsFotosProduto). Guardadas na memória por 6 h.
const cacheFotos = new Map<string, { url: string | null; quando: number }>();
async function moduloFotosProdutos(body: any, a: Acesso) {
  const loja = String(body.loja ?? '');
  exigirLoja(a, loja);
  const apiBase = Deno.env.get('VAREJONLINE_API_BASE');
  if (!apiBase) throw new Error('VAREJONLINE_API_BASE não configurado.');
  const tokens = await getLojasTokens();
  if (!tokens[loja]) throw new Error('Loja não encontrada.');
  const ids: string[] = [...new Set<string>((Array.isArray(body.ids) ? body.ids : []).map((x: any) => String(x)).filter((x: string) => /^\d+$/.test(x)))].slice(0, 400);
  const fotos: Record<string, string | null> = {}, faltam: string[] = [];
  for (const id of ids) { const c = cacheFotos.get(id); if (c && Date.now() - c.quando < 6 * 3600_000) fotos[id] = c.url; else faltam.push(id); }
  const lotes: string[][] = []; for (let i = 0; i < faltam.length; i += 50) lotes.push(faltam.slice(i, i + 50));
  await Promise.all(lotes.map(async (lote) => {
    try {
      await fetchAllPages(`${apiBase}/produtos?idsProdutos=${lote.join(',')}`, tokens[loja], (pg) => {
        for (const pr of pg) {
          const url = (Array.isArray(pr.urlsFotosProduto) ? pr.urlsFotosProduto : []).find((u: any) => typeof u === 'string' && /^https:\/\//.test(u)) ?? null;
          fotos[String(pr.id)] = url; cacheFotos.set(String(pr.id), { url, quando: Date.now() });
        }
      });
    } catch (_) { /* sem foto neste lote */ }
  }));
  for (const id of faltam) if (!(id in fotos)) { fotos[id] = null; cacheFotos.set(id, { url: null, quando: Date.now() }); }
  return { fotos };
}

async function aquecerCaches(body: any) {
  if (body.hoje) return aquecerHoje();
  if (body.clientesRede) return aquecerClientesRede();
  if (body.vinculosRede) return aquecerVinculosRede();
  if (body.painel) { // recalcula o Início da rede e guarda (moduloPainel grava painel_cache)
    const t0 = Date.now();
    const r: any = await moduloPainel({ recalcular: true }, { tipo: 'senha', nome: 'aquecimento', papel: 'admin', lojas: [], todas: true } as Acesso);
    const comErro = r.lojas.filter((l: any) => l.erro).map((l: any) => l.loja);
    return { ok: comErro.length === 0, lojas: r.lojas.length, comErro, ms: Date.now() - t0 };
  }
  const t0 = Date.now(), limite = 90_000;
  const apiBase = Deno.env.get('VAREJONLINE_API_BASE');
  if (!apiBase) throw new Error('VAREJONLINE_API_BASE não configurado.');
  const dias = Math.min(400, Math.max(7, Number(body.dias ?? 400))); // 400 dias: cobre o comparativo com o ano anterior
  const lojasTokens = await getLojasTokens();
  const fim = new Date(), ini = new Date(fim); ini.setDate(ini.getDate() - (dias - 1));
  const prontas: string[] = [], erros: any[] = [], pendentes: string[] = [];
  // 3 lojas ao mesmo tempo (tokens diferentes), cada uma com 3 janelas; ninguem comeca janela nova depois do prazo
  const prazo = t0 + limite, nomes = Object.keys(lojasTokens);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(3, nomes.length) }, async () => {
    while (i < nomes.length) {
      const nome = nomes[i++];
      if (Date.now() > prazo) { pendentes.push(nome); continue; }
      try {
        const ok = await saidasComCache({ sb, buscarPaginas: fetchAllPages, apiBase, token: lojasTokens[nome], loja: nome, dIni: ini, dFim: fim, onSaida: () => {}, janelaDias: 15, conc: 3, prazo, soAquecer: true });
        (ok ? prontas : pendentes).push(nome);
      } catch (e) { erros.push({ loja: nome, erro: e instanceof Error ? e.message : String(e) }); }
    }
  }));
  let central: any = null;
  if (Date.now() - t0 < 120_000) { try { const r = await sincronizarCentralDias(180, Math.max(5_000, 140_000 - (Date.now() - t0))); central = { completo: !r.pendentes, pendentes: r.pendentes ?? 0, falhas: r.falhas }; } catch (e) { central = { erro: String(e) }; } }
  return { completo: !pendentes.length && !!central?.completo, dias, prontas, pendentes, erros, central, ms: Date.now() - t0 };
}

// Aquecimento rápido durante o expediente: lê ontem e hoje de todas as lojas e guarda no cache
// (hoje vale 5 min, ontem 1 h). Assim quem abre o Início encontra as vendas do dia já prontas.
async function aquecerHoje() {
  const t0 = Date.now(), prazo = t0 + 100_000;
  const apiBase = Deno.env.get('VAREJONLINE_API_BASE');
  if (!apiBase) throw new Error('VAREJONLINE_API_BASE não configurado.');
  const tokens = await getLojasTokens(), nomes = Object.keys(tokens);
  const agora = new Date(Date.now() - 3 * 3600_000);
  const hoje = new Date(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()), ontem = new Date(hoje.getTime() - 86400_000);
  const prontas: string[] = [], pendentes: string[] = [], erros: any[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(6, nomes.length) }, async () => {
    while (i < nomes.length) {
      const nome = nomes[i++];
      if (Date.now() > prazo) { pendentes.push(nome); continue; }
      try {
        await saidasComCache({ sb, buscarPaginas: fetchAllPages, apiBase, token: tokens[nome], loja: nome, dIni: ontem, dFim: hoje, onSaida: () => {}, janelaDias: 2, conc: 1, prazo });
        prontas.push(nome);
      } catch (e) { erros.push({ loja: nome, erro: e instanceof Error ? e.message : String(e) }); }
    }
  }));
  return { completo: !pendentes.length, hoje: true, prontas, pendentes, erros, ms: Date.now() - t0 };
}

// =====================================================================
// TELA INICIAL (painel): mes corrente por loja -- faturado x meta, ritmo, ontem/hoje, compras na Central,
// pedidos aprovados no Insight sem envio e ultimo acesso dos franqueados (so admin/equipe).
// Vendas vem do cache por dia (so ontem/hoje sao lidos ao vivo), entao a rede inteira cabe numa chamada.
// =====================================================================
async function moduloPainel(body: any, a: Acesso) {
  const apiBase = Deno.env.get('VAREJONLINE_API_BASE');
  if (!apiBase) throw new Error('VAREJONLINE_API_BASE não configurado.');
  const tokens = await getLojasTokens();
  const permitidas = lojasDoAcesso(a, Array.isArray(body.lojas) && body.lojas.length ? body.lojas : undefined);
  const nomes = Object.keys(tokens).filter((n) => !permitidas || permitidas.includes(n)).sort();
  const agoraBR = new Date(Date.now() - 3 * 3600_000);
  const ano = agoraBR.getUTCFullYear(), mes = agoraBR.getUTCMonth() + 1, dia = agoraBR.getUTCDate();
  const diasNoMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const hojeIso = agoraBR.toISOString().slice(0, 10), ontemIso = new Date(agoraBR.getTime() - 86400_000).toISOString().slice(0, 10);
  const ini = new Date(ano, mes - 1, 1), fim = new Date(ano, mes - 1, dia);
  // Mês anterior (referência do ticket): o mês inteiro e o mesmo período (dia 1 até o dia de hoje)
  const iniAnt = new Date(ano, mes - 2, 1), diasMesAnt = new Date(ano, mes - 1, 0).getDate(), diaRefAnt = Math.min(dia, diasMesAnt);
  const ehAdmin = a.papel !== 'franqueado';

  // Resultado pré-calculado pelo aquecimento (a cada 15 min): lê pronto em vez de recalcular as 29 lojas.
  if (!body.recalcular) {
    try {
      const { data: c } = await sb().from('painel_cache').select('dados, atualizado_em').eq('chave', 'rede').maybeSingle();
      const idade = c ? Date.now() - Date.parse(c.atualizado_em) : Infinity;
      if (c && c.dados?.hoje === hojeIso && idade < 20 * 60_000) {
        const d = c.dados;
        let lojasC = (d.lojas ?? []).filter((l: any) => nomes.includes(l.loja));
        if (!ehAdmin) lojasC = lojasC.map(({ franqueados: _f, ultimoAcesso: _u, ...resto }: any) => resto);
        // pedidos aprovados no Insight mudam a qualquer hora: lidos na hora (consulta leve)
        const { data: pend } = await sb().from('pedidos_sugeridos').select('loja, valor_total').in('status', ['aprovado', 'erro_envio', 'enviando']);
        const pm = new Map<string, any[]>(); for (const p of pend ?? []) { if (!pm.has(p.loja)) pm.set(p.loja, []); pm.get(p.loja)!.push(p); }
        lojasC = lojasC.map((l: any) => { const ped = pm.get(l.loja) ?? []; return { ...l, pedidosInsightPendentes: ped.length, valorInsightPendente: r2(ped.reduce((t, p) => t + Number(p.valor_total ?? 0), 0)) }; });
        return { ...d, lojas: lojasC, rede: montarRedePainel(lojasC), calculadoEm: c.atualizado_em };
      }
    } catch { /* sem a tabela ou erro: calcula na hora */ }
  }

  // ano anterior: mesmo dia da semana (364 dias antes) — compara sábado com sábado
  const diaAAiso = new Date(Date.parse(hojeIso) - 364 * 86400_000).toISOString().slice(0, 10);
  const diaAA = new Date(+diaAAiso.slice(0, 4), +diaAAiso.slice(5, 7) - 1, +diaAAiso.slice(8, 10));
  const horaAgora = agoraBR.toISOString().slice(11, 16); // HH:MM em Brasília
  const metasQ = async () => {
    const r = await sb().from('metas_faturamento').select('loja, meta, considerar_domingo').eq('ano', ano).eq('mes', mes);
    return r.error ? await sb().from('metas_faturamento').select('loja, meta').eq('ano', ano).eq('mes', mes) : r; // sem a coluna nova: segue sem domingo
  };
  const [metasR, pendR, central, usuarios] = await Promise.all([
    metasQ(),
    sb().from('pedidos_sugeridos').select('loja, status, valor_total, criado_em, fornecedor_nome').in('status', ['aprovado', 'erro_envio', 'enviando']),
    buscarPedidosCentral(60, 35000).catch((e) => ({ lista: [], falhas: 1, erro: String(e) } as ResultadoCentral)),
    ehAdmin ? acessosPorLoja().catch(() => null) : Promise.resolve(null),
  ]);
  const metas = new Map<string, number>((metasR.data ?? []).map((m: any) => [m.loja, Number(m.meta)]));
  const comDomingo = new Map<string, boolean>((metasR.data ?? []).map((m: any) => [m.loja, !!m.considerar_domingo]));
  // dias de venda do mês (segunda a sábado; domingo só se a loja marcou "considerar domingo")
  const ehDiaDeVenda = (d: number, domingo: boolean) => domingo || new Date(Date.UTC(ano, mes - 1, d)).getUTCDay() !== 0;
  const contarDias = (de: number, ate: number, domingo: boolean) => { let n = 0; for (let d = de; d <= ate; d++) if (ehDiaDeVenda(d, domingo)) n++; return n; };
  const pend = new Map<string, any[]>();
  for (const p of pendR.data ?? []) { if (!pend.has(p.loja)) pend.set(p.loja, []); pend.get(p.loja)!.push(p); }
  // compras na Central por loja (ultimos 60 dias)
  const comp = new Map<string, { ultima: string | null; mes: number; pedidosMes: number; emAndamento: number }>();
  const inicioMesIso = `${ano}-${String(mes).padStart(2, '0')}-01`;
  for (const p of central.lista ?? []) {
    if (p.situacao?.isCancelamento) continue;
    const k = lojaDoPedido(p); const c = comp.get(k) ?? { ultima: null, mes: 0, pedidosMes: 0, emAndamento: 0 };
    const d = String(p.dataCriacao ?? '').slice(0, 10);
    if (d && (!c.ultima || d > c.ultima)) c.ultima = d;
    if (d >= inicioMesIso) { c.pedidosMes++; c.mes += (p.itensPedido ?? []).reduce((t: number, i: any) => t + Number(i.quantidadeProdutos ?? 0) * Number(i.valorUnitario ?? 0), 0); }
    if (!p.situacao?.isSituacaoFinal) c.emAndamento++;
    comp.set(k, c);
  }

  const lojas: any[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(6, nomes.length) }, async () => {
    while (i < nomes.length) {
      const nome = nomes[i++];
      const v = { fat: 0, atend: 0, pecas: 0, hoje: 0, ontem: 0, hojeAtend: 0 };
      const ant = { fat: 0, atend: 0, fatMes: 0, atendMes: 0 };
      const aa = { dia: 0, ateAgora: 0, atend: 0 };
      let erro: string | null = null;
      try {
        // mesmo dia da semana do ano passado: dia inteiro e até este horário
        const aaP = buscarSaidasParalelo(apiBase, tokens[nome], diaAA, diaAA, (sd) => {
          if (!ehVenda(sd) || diaDaVenda(sd) !== diaAAiso) return;
          let f = 0; for (const it of sd.mercadorias ?? []) f += Number(it.valorTotal ?? 0);
          aa.dia += f; aa.atend++;
          const hm = String(sd.data ?? '').match(/(\d{2}):(\d{2})/);
          if (!hm || `${hm[1]}:${hm[2]}` <= horaAgora) aa.ateAgora += f;
        }, 15, 1).catch(() => {});
        await buscarSaidasParalelo(apiBase, tokens[nome], iniAnt, fim, (sd) => {
          if (!ehVenda(sd)) return;
          let f = 0, q = 0;
          for (const it of sd.mercadorias ?? []) { f += Number(it.valorTotal ?? 0); q += Math.max(0, Number(it.quantidade ?? 0)); }
          if (q <= 0) return;
          const d = diaDaVenda(sd);
          if (d && d < inicioMesIso) { // mês anterior
            ant.fatMes += f; ant.atendMes++;
            if (Number(d.slice(8, 10)) <= diaRefAnt) { ant.fat += f; ant.atend++; }
            return;
          }
          v.fat += f; v.atend++; v.pecas += q;
          if (d === hojeIso) { v.hoje += f; v.hojeAtend++; } else if (d === ontemIso) v.ontem += f;
        }, 15, 3);
        await aaP;
      } catch (e) { erro = e instanceof Error ? e.message : String(e); }
      const meta = metas.get(nome) ?? null;
      const domingo = comDomingo.get(nome) ?? false;
      // meta do dia: o que falta da meta (até ontem) ÷ dias de venda que sobram, contando hoje
      const fatAteOntem = v.fat - v.hoje;
      const hojeConta = ehDiaDeVenda(dia, domingo);
      const restantes = contarDias(dia, diasNoMes, domingo), fechados = contarDias(1, dia - 1, domingo), diasVendaMes = contarDias(1, diasNoMes, domingo);
      const metaHoje = meta ? (hojeConta ? Math.max(0, meta - fatAteOntem) / Math.max(1, restantes) : 0) : null;
      // projeção: média por dia de venda já fechado × dias de venda que faltam (hoje incluído)
      const projecao = fechados > 0 ? fatAteOntem + fatAteOntem / fechados * restantes : null;
      const c = comp.get(normLoja(nome));
      const ped = pend.get(nome) ?? [];
      const acc = usuarios?.get(nome);
      lojas.push({
        loja: nome, erro,
        faturadoMes: r2(v.fat), faturadoHoje: r2(v.hoje), faturadoOntem: r2(v.ontem), atendimentos: v.atend,
        ticketMedio: v.atend ? r2(v.fat / v.atend) : 0,
        // referência do mês anterior: mesmo período (1 até o dia de hoje) e mês fechado
        faturadoMesAnteriorMesmoPeriodo: r2(ant.fat), atendimentosMesAnteriorMesmoPeriodo: ant.atend,
        ticketMedioMesAnterior: ant.atend ? r2(ant.fat / ant.atend) : null,
        faturadoMesAnterior: r2(ant.fatMes), ticketMedioMesAnteriorFechado: ant.atendMes ? r2(ant.fatMes / ant.atendMes) : null,
        pecasPorAtendimento: v.atend ? r2(v.pecas / v.atend) : 0,
        meta, percentMeta: meta ? r2(v.fat / meta * 100) : null, projecao: projecao != null ? r2(projecao) : null,
        percentProjecao: meta && projecao != null ? r2(projecao / meta * 100) : null,
        faltaPorDia: meta ? r2(Math.max(0, meta - fatAteOntem) / Math.max(1, restantes)) : null,
        ritmoNecessario: meta ? r2(meta / Math.max(1, diasVendaMes)) : null,
        metaHoje: metaHoje != null ? r2(metaHoje) : null, faltaHoje: metaHoje != null ? r2(Math.max(0, metaHoje - v.hoje)) : null,
        hojeContaNaMeta: hojeConta, considerarDomingo: domingo, diasDeVendaRestantes: restantes, atendimentosHoje: v.hojeAtend,
        anoAnteriorDia: r2(aa.dia), anoAnteriorAteAgora: r2(aa.ateAgora), anoAnteriorAtendimentos: aa.atend,
        ultimaCompraCentral: c?.ultima ?? null,
        diasSemComprar: c?.ultima ? Math.round((Date.parse(hojeIso) - Date.parse(c.ultima)) / 86400_000) : null,
        comprasCentralMes: r2(c?.mes ?? 0), pedidosCentralMes: c?.pedidosMes ?? 0, pedidosCentralEmAndamento: c?.emAndamento ?? 0,
        pedidosInsightPendentes: ped.length, valorInsightPendente: r2(ped.reduce((t, p) => t + Number(p.valor_total ?? 0), 0)),
        ...(ehAdmin ? { franqueados: acc?.nomes ?? [], ultimoAcesso: acc?.ultimo ?? null } : {}),
      });
    }
  }));
  lojas.sort((x, y) => x.loja.localeCompare(y.loja));
  const resultado = {
    ano, mes, dia, diasNoMes, hoje: hojeIso, horaAgora, diaAnoAnterior: diaAAiso, diaRefMesAnterior: diaRefAnt, centralIncompleta: !!(central.falhas || central.pendentes || central.erro),
    rede: montarRedePainel(lojas), lojas, calculadoEm: new Date().toISOString(),
  };
  // visão completa (franqueadora, todas as lojas, sem erro): guarda para as próximas aberturas
  if (ehAdmin && nomes.length === Object.keys(tokens).length && !lojas.some((l) => l.erro)) {
    try { await sb().from('painel_cache').upsert({ chave: 'rede', dados: resultado, atualizado_em: resultado.calculadoEm }, { onConflict: 'chave' }); } catch { /* sem a tabela */ }
  }
  return resultado;
}

// Totais da rede a partir das lojas (serve tanto o cálculo na hora quanto o resultado guardado)
function montarRedePainel(lojas: any[]) {
  const soma = (k: string) => r2(lojas.reduce((t, l) => t + (Number(l[k]) || 0), 0));
  const metaRede = lojas.reduce((t, l) => t + (l.meta || 0), 0);
  return { faturadoMes: soma('faturadoMes'), faturadoOntem: soma('faturadoOntem'), faturadoHoje: soma('faturadoHoje'), meta: r2(metaRede),
    metaHoje: soma('metaHoje'), faturadoHojeComMeta: r2(lojas.filter((l) => l.meta).reduce((t, l) => t + (l.faturadoHoje || 0), 0)), lojasComMeta: lojas.filter((l) => l.meta).length,
    anoAnteriorDia: soma('anoAnteriorDia'), anoAnteriorAteAgora: soma('anoAnteriorAteAgora'), atendimentosHoje: soma('atendimentosHoje'),
    percentMeta: metaRede ? r2(soma('faturadoMes') / metaRede * 100) : null, projecao: soma('projecao'), comprasCentralMes: soma('comprasCentralMes'),
    atendimentos: soma('atendimentos'), ticketMedio: soma('atendimentos') ? r2(soma('faturadoMes') / soma('atendimentos')) : 0,
    faturadoMesAnteriorMesmoPeriodo: soma('faturadoMesAnteriorMesmoPeriodo'),
    ticketMedioMesAnterior: soma('atendimentosMesAnteriorMesmoPeriodo') ? r2(soma('faturadoMesAnteriorMesmoPeriodo') / soma('atendimentosMesAnteriorMesmoPeriodo')) : null };
}

// =====================================================================
// COMPARATIVO dia a dia: período escolhido x mesmo período do mês anterior x mesmo período do ano anterior.
// body: { lojas?: string[] (vazio = todas as liberadas), de: 'AAAA-MM-DD', ate: 'AAAA-MM-DD', alinhamento?: 'data' | 'semana' }
// alinhamento 'semana' compara o ano anterior pelo mesmo dia da semana (364 dias antes) em vez da mesma data.
// =====================================================================
async function moduloComparativo(body: any, a: Acesso) {
  const apiBase = Deno.env.get('VAREJONLINE_API_BASE');
  if (!apiBase) throw new Error('VAREJONLINE_API_BASE não configurado.');
  const t0 = Date.now();
  const iso = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const ler = (s: unknown) => { const m = String(s ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
  const hojeIso = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  let de = ler(body.de) ?? ler(hojeIso.slice(0, 8) + '01')!, ate = ler(body.ate) ?? ler(hojeIso)!;
  if (iso(ate) > hojeIso) ate = ler(hojeIso)!;
  if (de > ate) [de, ate] = [ate, de];
  const nDias = Math.round((ate.getTime() - de.getTime()) / 86400_000) + 1;
  if (nDias > 93) throw new Error('Escolha um período de até 3 meses.');
  const semana = body.alinhamento === 'semana';
  // mesma data no mês anterior / ano anterior (dia 31 -> último dia do mês, 29/02 -> 28/02)
  const mesmoDia = (d: Date, meses: number) => {
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + meses, ult = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), ult)));
  };
  const menos = (d: Date, n: number) => new Date(d.getTime() - n * 86400_000);
  const refMes = (d: Date) => mesmoDia(d, -1);
  const refAno = (d: Date) => semana ? menos(d, 364) : mesmoDia(d, -12);
  const periodos = {
    atual: { de, ate },
    mesAnterior: { de: refMes(de), ate: refMes(ate) },
    anoAnterior: { de: refAno(de), ate: refAno(ate) },
  };

  const tokens = await getLojasTokens();
  const permitidas = lojasDoAcesso(a, Array.isArray(body.lojas) && body.lojas.length ? body.lojas : undefined);
  const nomes = Object.keys(tokens).filter((n) => !permitidas || permitidas.includes(n)).sort();
  if (!nomes.length) throw new Error('Nenhuma loja liberada para este usuário.');

  // fat = valor cobrado (soma do valor total dos itens); desc = descontos dos itens; dev = devoluções de clientes (entradas DEVOLUCAO_VENDA)
  // bruto = cobrado + descontos (preço cheio); líquido = cobrado - devoluções
  type Acum = { fat: number; desc: number; dev: number; atend: number; pecas: number };
  const novo = (): Acum => ({ fat: 0, desc: 0, dev: 0, atend: 0, pecas: 0 });
  let devolucoesIncompletas = false;
  const porDia: Record<string, Map<string, Acum>> = { atual: new Map(), mesAnterior: new Map(), anoAnterior: new Map() };
  const porLoja = new Map<string, Record<string, Acum>>();
  const erros: { loja: string; erro: string }[] = [], pendentes: string[] = [];
  const prazo = t0 + 100_000;
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(4, nomes.length) }, async () => {
    while (i < nomes.length) {
      const nome = nomes[i++];
      if (Date.now() > prazo) { pendentes.push(nome); continue; }
      const tot: Record<string, Acum> = { atual: novo(), mesAnterior: novo(), anoAnterior: novo() };
      try {
        for (const [k, p] of Object.entries(periodos)) {
          const ini = new Date(p.de.getUTCFullYear(), p.de.getUTCMonth(), p.de.getUTCDate());
          const fim = new Date(p.ate.getUTCFullYear(), p.ate.getUTCMonth(), p.ate.getUTCDate());
          const deIso = iso(p.de), ateIso = iso(p.ate);
          await buscarSaidasParalelo(apiBase, tokens[nome], ini, fim, (sd) => {
            if (!ehVenda(sd)) return;
            const d = diaDaVenda(sd); if (!d || d < deIso || d > ateIso) return;
            let f = 0, q = 0, ds = 0;
            for (const it of sd.mercadorias ?? []) { f += Number(it.valorTotal ?? 0); q += Math.max(0, Number(it.quantidade ?? 0)); ds += Math.max(0, Number(it.valorTotalDesconto ?? it.valorDescontoItem ?? 0)); }
            if (q <= 0) return;
            const m = porDia[k]; const x = m.get(d) ?? novo(); x.fat += f; x.desc += ds; x.atend++; x.pecas += q; m.set(d, x);
            tot[k].fat += f; tot[k].desc += ds; tot[k].atend++; tot[k].pecas += q;
          }, 15, 3);
          // devoluções/trocas de clientes no período (entram como entrada na VarejOnline)
          if (Date.now() < prazo) {
            try {
              await fetchAllPages(`${apiBase}/entradas?desde=${fmtBR(ini)}&ate=${fmtBR(fim)}`, tokens[nome], (pg) => {
                for (const en of pg) {
                  if (en?.cancelado || !/DEVOLUCAO_VENDA/.test(String(en?.tipoEntrada ?? ''))) continue;
                  const d = diaDaVenda(en); if (!d || d < deIso || d > ateIso) continue;
                  const v = Math.max(0, Number(en.valorTotal ?? 0));
                  const m = porDia[k]; const x = m.get(d) ?? novo(); x.dev += v; m.set(d, x); tot[k].dev += v;
                }
              });
            } catch (_) { devolucoesIncompletas = true; }
          } else devolucoesIncompletas = true;
        }
        porLoja.set(nome, tot);
      } catch (e) { erros.push({ loja: nome, erro: e instanceof Error ? e.message : String(e) }); }
    }
  }));

  const resumo = (x: Acum) => {
    const bruto = x.fat + x.desc, liquido = x.fat - x.dev;
    return {
      faturadoBruto: r2(bruto), faturadoLiquido: r2(liquido), cobrado: r2(x.fat), descontos: r2(x.desc), devolucoes: r2(x.dev),
      faturado: r2(liquido), atendimentos: x.atend, pecas: r2(x.pecas),
      ticketBruto: x.atend ? r2(bruto / x.atend) : null, ticketLiquido: x.atend ? r2(liquido / x.atend) : null,
      ticketMedio: x.atend ? r2(liquido / x.atend) : null, pecasPorAtendimento: x.atend ? r2(x.pecas / x.atend) : null,
    };
  };
  const somar = (k: string) => { const t = novo(); for (const v of porDia[k].values()) { t.fat += v.fat; t.desc += v.desc; t.dev += v.dev; t.atend += v.atend; t.pecas += v.pecas; } return t; };
  const dias: any[] = [];
  for (let n = 0; n < nDias; n++) {
    const d = new Date(de.getTime() + n * 86400_000), dm = refMes(d), da = refAno(d);
    const A = porDia.atual.get(iso(d)), M = porDia.mesAnterior.get(iso(dm)), Y = porDia.anoAnterior.get(iso(da));
    dias.push({
      dia: iso(d), diaSemana: d.getUTCDay(), futuro: iso(d) > hojeIso,
      atual: A ? resumo(A) : resumo(novo()),
      mesAnterior: { dia: iso(dm), ...(M ? resumo(M) : resumo(novo())) },
      anoAnterior: { dia: iso(da), diaSemana: da.getUTCDay(), ...(Y ? resumo(Y) : resumo(novo())) },
    });
  }
  return {
    parametros: { de: iso(de), ate: iso(ate), dias: nDias, alinhamento: semana ? 'semana' : 'data', lojas: [...porLoja.keys()].sort(), hoje: hojeIso },
    periodos: Object.fromEntries(Object.entries(periodos).map(([k, p]) => [k, { de: iso(p.de), ate: iso(p.ate) }])),
    totais: { atual: resumo(somar('atual')), mesAnterior: resumo(somar('mesAnterior')), anoAnterior: resumo(somar('anoAnterior')) },
    dias,
    lojas: [...porLoja.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([loja, t]) => ({ loja, atual: resumo(t.atual), mesAnterior: resumo(t.mesAnterior), anoAnterior: resumo(t.anoAnterior) })),
    erros, pendentes, devolucoesIncompletas,
  };
}

// =====================================================================
// CLIENTES: base ativa, recompra, tempo até voltar, clientes que sumiram, VIPs e
// "para quem oferecer" um produto, pelo perfil de compra de cada cliente.
// body: { loja, meses?: 6..24 (padrão 12), sumidoDias?: 60|90|120|180 (padrão 90), produto?: texto ou código }
// Uma loja por vez. Só entram vendas com cliente identificado (CPF/CNPJ válido, fora consumidor final,
// fornecedores e prestadores).
// =====================================================================
const CATEGORIA_SINONIMO: Record<string, string> = { COLARES: 'COLAR', BRINCOS: 'BRINCO', ANEIS: 'ANEL', PULSEIRAS: 'PULSEIRA', CORRENTES: 'CORRENTE', TORNOZELEIRAS: 'TORNOZELEIRA', PINGENTES: 'PINGENTE', BRACELETES: 'BRACELETE', CONJUNTOS: 'CONJUNTO', KITS: 'KIT', PIERCINGS: 'PIERCING', CHOKERS: 'CHOKER', ARGOLAS: 'ARGOLA', ALIANCAS: 'ALIANCA', RELOGIOS: 'RELOGIO' };
const categoriaDe = (desc: unknown) => { const w = limpa(desc).split(' ')[0] || 'OUTROS'; return CATEGORIA_SINONIMO[w] ?? w; };
const modeloDe = (desc: unknown) => String(desc ?? '').split(/\s+-\s+/)[0].trim().toUpperCase() || '(sem descrição)';
const faixaPrecoDe = (v: number) => v < 50 ? 'até R$ 49,99' : v < 100 ? 'R$ 50 a 99' : v < 200 ? 'R$ 100 a 199' : 'R$ 200 ou mais';

// Cadastro dos clientes (contato + endereço) por id: lê da tabela clientes_cadastro e busca na VarejOnline
// só quem falta (ou foi lido há mais de 60 dias), um a um, até o prazo. Sem a tabela, usa a memória da função.
const cacheCadastros = new Map<string, any>();
async function contaDoToken(chave: string) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(abrirChave(chave).token)));
  return [...d.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const enderecoDe = (t: any) => {
  const e = (t?.enderecos ?? []).find((x: any) => soDigitos(x?.cep).length === 8 || x?.cidade) ?? null;
  const tx = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ') || null;
  return e ? { cep: soDigitos(e.cep) || null, bairro: tx(e.bairro), cidade: tx(e.cidade), uf: tx(e.siglaEstado)?.toUpperCase() ?? null } : { cep: null, bairro: null, cidade: null, uf: null };
};
async function cadastrosClientes(apiBase: string, chave: string, ids: string[], prazo: number): Promise<{ mapa: Map<string, any>; faltando: number }> {
  const conta = await contaDoToken(chave), mapa = new Map<string, any>();
  const velho = new Date(Date.now() - 60 * 86400_000).toISOString();
  let tabelaOk = true;
  for (const id of ids) { const c = cacheCadastros.get(`${conta}|${id}`); if (c) mapa.set(id, c); }
  const buscar = ids.filter((id) => !mapa.has(id));
  for (let i = 0; i < buscar.length && tabelaOk; i += 300) {
    const { data, error } = await sb().from('clientes_cadastro').select('*').eq('conta', conta).in('cliente_id', buscar.slice(i, i + 300));
    if (error) { tabelaOk = false; break; }
    for (const r of data ?? []) if (r.atualizado_em > velho) { mapa.set(r.cliente_id, r); cacheCadastros.set(`${conta}|${r.cliente_id}`, r); }
  }
  const falta = ids.filter((id) => !mapa.has(id));
  const { token } = abrirChave(chave);
  const novos: any[] = []; let k = 0; const diag: Record<string, number> = {}; const amostra: any[] = [];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (k < falta.length && Date.now() < prazo) {
      const id = falta[k++];
      try {
        const r = await fetch(`${apiBase}/terceiros/${encodeURIComponent(id)}?token=${token}`, { signal: AbortSignal.timeout(12000) });
        diag[r.status] = (diag[r.status] ?? 0) + 1;
        if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1500)); falta.push(id); continue; } // devagar e tenta de novo
        if (!r.ok && r.status !== 404) continue; // erro passageiro: não guarda, tenta na próxima consulta
        let t: any = r.ok ? await r.json() : null;
        if (Array.isArray(t)) t = t[0] ?? null;
        const reg = { conta, cliente_id: id, ...(contatoDe(t) ?? { telefone: null, whatsapp: null, email: null, aniversario: null }), ...enderecoDe(t), encontrado: !!t, atualizado_em: new Date().toISOString() };
        mapa.set(id, reg); cacheCadastros.set(`${conta}|${id}`, reg); novos.push(reg);
        if (amostra.length < 2 && t) amostra.push({ chaves: Object.keys(t).slice(0, 40), enderecos: (t.enderecos ?? []).length });
      } catch (e) { diag['erro'] = (diag['erro'] ?? 0) + 1; }
    }
  }));
  if (tabelaOk && novos.length) for (let i = 0; i < novos.length; i += 500) await sb().from('clientes_cadastro').upsert(novos.slice(i, i + 500), { onConflict: 'conta,cliente_id' });
  ultimoDiagCadastro = { status: diag, amostra, tabelaOk };
  return { mapa, faltando: ids.filter((id) => !mapa.has(id)).length };
}
let ultimoDiagCadastro: any = null;
const contatoDoCadastro = (r: any) => r && r.encontrado !== false ? { telefone: r.telefone ?? null, whatsapp: r.whatsapp ?? null, email: r.email ?? null, aniversario: r.aniversario ?? null } : null;

function contatoDe(t: any) {
  if (!t) return null;
  const tels = (t.telefones ?? []).map((f: any) => ({ tipo: f.tipoTelefone, num: soDigitos(f.ddd) + soDigitos(f.numero) })).filter((f: any) => f.num.length >= 10)
    .sort((a: any, b: any) => (a.tipo === 'CELULAR' ? 0 : 1) - (b.tipo === 'CELULAR' ? 0 : 1));
  const tel = tels[0]?.num ?? null;
  const nasc = String(t.dataNascimento ?? '').match(/^(\d{2})-(\d{2})-(\d{4})/);
  return {
    telefone: tel ? (tel.length === 11 ? `(${tel.slice(0, 2)}) ${tel.slice(2, 7)}-${tel.slice(7)}` : `(${tel.slice(0, 2)}) ${tel.slice(2, 6)}-${tel.slice(6)}`) : null,
    whatsapp: tel && tels[0].tipo !== 'RESIDENCIAL' && tel.length === 11 ? `55${tel}` : null,
    email: (t.emails ?? [])[0] ?? null,
    aniversario: nasc ? `${nasc[1]}/${nasc[2]}` : null,
  };
}

// =====================================================================
// CLIENTES › ONDE MORAM: cidade, bairro e distância da casa (CEP) até a loja.
// Endereço vem do cadastro do cliente na VarejOnline; coordenadas do CEP pela AwesomeAPI
// (cep.awesomeapi.com.br), guardadas em cep_geo. A loja é localizada pelo CNPJ (BrasilAPI).
// =====================================================================
const distKm = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const R = 6371, rad = (x: number) => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
async function geoDeCep(cep: string): Promise<any> {
  try {
    const r = await fetch(`https://cep.awesomeapi.com.br/json/${cep}`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) { const j: any = await r.json(); const lat = Number(j.lat), lng = Number(j.lng); if (isFinite(lat) && isFinite(lng) && lat && lng) return { cep, lat, lng, cidade: j.city ?? null, bairro: j.district ?? null, uf: j.state ?? null, fonte: 'awesomeapi' }; }
  } catch (_) { /* tenta a outra */ }
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${cep}`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) { const j: any = await r.json(); const c = j.location?.coordinates ?? {}; const lat = Number(c.latitude), lng = Number(c.longitude);
      if (isFinite(lat) && isFinite(lng) && lat && lng) return { cep, lat, lng, cidade: j.city ?? null, bairro: j.neighborhood ?? null, uf: j.state ?? null, fonte: 'brasilapi' }; }
  } catch (_) { /* sem coordenada */ }
  return { cep, lat: null, lng: null, fonte: 'nao_encontrado' };
}
// lê do cache e completa os que faltam (até o prazo); devolve Map cep -> {lat,lng} e quantos ficaram faltando
async function coordenadasCeps(ceps: string[], prazo: number): Promise<{ mapa: Map<string, any>; faltando: number; tabelaOk: boolean }> {
  const mapa = new Map<string, any>(); let tabelaOk = true;
  const velho = new Date(Date.now() - 30 * 86400_000).toISOString();
  for (let i = 0; i < ceps.length; i += 400) {
    const { data, error } = await sb().from('cep_geo').select('cep, lat, lng, fonte, atualizado_em').in('cep', ceps.slice(i, i + 400));
    if (error) { tabelaOk = false; break; }
    for (const r of data ?? []) if (r.lat != null || r.atualizado_em > velho) mapa.set(r.cep, r);
  }
  const falta = ceps.filter((c) => !mapa.has(c));
  let k = 0; const novos: any[] = [];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (k < falta.length && Date.now() < prazo) { const g = await geoDeCep(falta[k++]); mapa.set(g.cep, g); novos.push({ ...g, atualizado_em: new Date().toISOString() }); }
  }));
  if (tabelaOk && novos.length) for (let i = 0; i < novos.length; i += 500) await sb().from('cep_geo').upsert(novos.slice(i, i + 500), { onConflict: 'cep' });
  return { mapa, faltando: falta.length - novos.length, tabelaOk };
}
async function localDaLoja(loja: string, apiBase?: string, chaveLoja?: string): Promise<any> {
  const { data } = await sb().from('lojas_config').select('cnpj').eq('nome', loja).maybeSingle();
  let cnpj = soDigitos(data?.cnpj);
  if (cnpj.length !== 14 && apiBase && chaveLoja) { // sem CNPJ em Lojas: pega o CNPJ da unidade numa venda recente
    try {
      const hojeD = new Date(Date.now() - 3 * 3600_000), de = new Date(hojeD.getTime() - 30 * 86400_000);
      const pc = await prepararChamada(`${apiBase}/saidas?desde=${fmtBR(de)}&ate=${fmtBR(hojeD)}&inicio=0`, chaveLoja);
      const r = await fetch(`${pc.url}&quantidade=5&token=${pc.token}`, { signal: AbortSignal.timeout(15000) });
      const j: any = r.ok ? await r.json() : [];
      const sd = (Array.isArray(j) ? j : []).find((x: any) => soDigitos(x?.entidade?.documento).length === 14);
      if (sd) cnpj = soDigitos(sd.entidade.documento);
    } catch (_) { /* sem CNPJ */ }
  }
  if (cnpj.length !== 14) return null;
  const chave = 'CNPJ' + cnpj;
  const { data: c } = await sb().from('cep_geo').select('lat, lng, bairro, cidade, fonte').eq('cep', chave).maybeSingle();
  if (c?.lat != null && String(c.fonte ?? '').includes('|')) return { ...c, cep: String(c.fonte).split('|')[1] || null }; // registro antigo sem o CEP: busca de novo
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j: any = await r.json(); const cep = soDigitos(j.cep);
    if (cep.length !== 8) return null;
    const g = await geoDeCep(cep);
    if (g.lat == null) return null;
    const reg = { cep: chave, lat: g.lat, lng: g.lng, bairro: j.bairro ?? g.bairro, cidade: j.municipio ?? g.cidade, uf: j.uf ?? g.uf, fonte: `${g.fonte}|${cep}`, atualizado_em: new Date().toISOString() };
    await sb().from('cep_geo').upsert(reg, { onConflict: 'cep' });
    return { lat: reg.lat, lng: reg.lng, bairro: reg.bairro, cidade: reg.cidade, cep };
  } catch (_) { return null; }
}

async function clientesLocalizacao(apiBase: string, chave: string, loja: string, lista: { id: string; fat: number; dias: Set<string> }[], prazoFinal: number) {
  // primeiro os clientes que mais gastaram: se o tempo acabar, o que falta é completado na próxima consulta
  const ordem = [...lista].sort((x, y) => y.fat - x.fat).map((c) => c.id);
  const cad = await cadastrosClientes(apiBase, chave, ordem, Math.min(prazoFinal - 35_000, Date.now() + 70_000));
  const prazo = Math.min(prazoFinal, Date.now() + 30_000);
  const end = new Map<string, { cep: string; bairro: string; cidade: string; uf: string }>();
  for (const [id, r] of cad.mapa) if (r && (r.cep || r.cidade)) end.set(id, { cep: r.cep ?? '', bairro: r.bairro ?? '', cidade: r.cidade ?? '', uf: r.uf ?? '' });
  const lidos = cad.mapa.size;
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const fatDe = new Map(lista.map((c) => [c.id, c.fat]));
  const porCidade = new Map<string, { cidade: string; clientes: number; fat: number }>();
  const porBairro = new Map<string, { bairro: string; cidade: string; clientes: number; fat: number }>();
  const lojaGeo = await localDaLoja(loja, apiBase, chave);
  const lojaCepPre = lojaGeo?.cep ?? null;
  for (const [id, e] of end) {
    if (lojaCepPre && e.cep === lojaCepPre) continue; // endereço da própria loja não conta como bairro do cliente
    if (e.cidade) { const k = norm(e.cidade) + '|' + e.uf; const x = porCidade.get(k) ?? { cidade: `${e.cidade}${e.uf ? ' - ' + e.uf : ''}`, clientes: 0, fat: 0 }; x.clientes++; x.fat += fatDe.get(id) ?? 0; porCidade.set(k, x); }
    if (e.bairro) { const k = norm(e.bairro) + '|' + norm(e.cidade); const x = porBairro.get(k) ?? { bairro: e.bairro, cidade: e.cidade, clientes: 0, fat: 0 }; x.clientes++; x.fat += fatDe.get(id) ?? 0; porBairro.set(k, x); }
  }
  // Distância. O serviço de CEP muitas vezes só conhece o centro da cidade: entre cidades isso basta;
  // dentro da cidade da loja, só mede km quando o CEP tem posição própria (senão, vale o bairro).
  const ceps = [...new Set([...end.values()].map((e) => e.cep).filter((c) => c.length === 8))];
  const { mapa, faltando, tabelaOk } = await coordenadasCeps(ceps, prazo);
  const cepLoja = lojaGeo?.cep ?? null;
  const kp = (g: any) => `${Number(g.lat).toFixed(4)},${Number(g.lng).toFixed(4)}`;
  const freq = new Map<string, number>();
  for (const c of ceps) { const g = mapa.get(c); if (g?.lat != null) freq.set(kp(g), (freq.get(kp(g)) ?? 0) + 1); }
  const imprecisa = (cep: string, g: any) => /000$/.test(cep) || (freq.get(kp(g)) ?? 0) >= 3;
  const normC = (x: unknown) => norm(String(x ?? '')).replace(/\s+/g, ' ').trim();
  const cidadeTop = [...porCidade.entries()].sort((x, y) => y[1].clientes - x[1].clientes)[0]?.[1]?.cidade ?? '';
  const cidadeLoja = normC(lojaGeo?.cidade ?? cidadeTop.replace(/ - [A-Z]{2}$/, ''));
  const lojaAproximada = !!lojaGeo && (freq.get(kp(lojaGeo)) ?? 0) >= 3;
  let centro: any = lojaGeo, centroEstimado = false;
  if (!centro) { // sem a loja: centro da cidade principal pelos CEPs dos clientes de lá
    const gs = [...end.values()].filter((e) => normC(e.cidade) === cidadeLoja).map((e) => mapa.get(e.cep)).filter((g) => g?.lat != null);
    if (gs.length) { const med = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)]; centro = { lat: med(gs.map((g) => g.lat)), lng: med(gs.map((g) => g.lng)) }; centroEstimado = true; }
  }
  let comCepDaLoja = 0, semPosicao = 0;
  const mesma: string[] = [], dentro: { id: string; d: number }[] = [], fora: { id: string; d: number; cidade: string }[] = [];
  const agg = new Map<string, { lat: number; lng: number; n: number }>();
  const marcar = (g: any) => { const k = `${g.lat.toFixed(3)},${g.lng.toFixed(3)}`; const x = agg.get(k) ?? { lat: +g.lat.toFixed(3), lng: +g.lng.toFixed(3), n: 0 }; x.n++; agg.set(k, x); };
  for (const [id, e] of end) {
    if (cepLoja && e.cep === cepLoja) { comCepDaLoja++; continue; }
    const g = mapa.get(e.cep);
    if (normC(e.cidade) === cidadeLoja || (!e.cidade && g && centro && distKm(centro, g) < 3)) {
      mesma.push(id);
      if (g?.lat != null && centro && !lojaAproximada && !imprecisa(e.cep, g)) { dentro.push({ id, d: distKm(centro, g) }); marcar(g); }
      continue;
    }
    if (g?.lat != null && centro) { fora.push({ id, d: distKm(centro, g), cidade: e.cidade ? `${e.cidade}${e.uf ? ' - ' + e.uf : ''}` : '(sem cidade)' }); marcar(g); }
    else semPosicao++;
  }
  const soma = (ids: string[]) => r2(ids.reduce((s, id) => s + (fatDe.get(id) ?? 0), 0));
  const faixa = (lista: { id: string; d: number }[], lims: readonly (readonly [number, string])[]) => lims.map(([lim, nome], i) => {
    const de = i ? lims[i - 1][0] : -1; const g = lista.filter((x) => x.d > de && x.d <= lim);
    return { faixa: nome, clientes: g.length, faturamento: soma(g.map((x) => x.id)) };
  });
  const base = mesma.length + fora.length;
  let distancias: any = null;
  if (centro && base) {
    // todos em ordem de distância (mesma cidade conta como 0 km) para "8 de cada 10 moram até X km"
    const todasD = [...mesma.map(() => 0), ...fora.map((x) => x.d)].sort((a, b) => a - b);
    const q = (f: number) => r2(todasD[Math.min(todasD.length - 1, Math.floor(todasD.length * f))]);
    const porCidFora = new Map<string, { cidade: string; clientes: number; ds: number[] }>();
    for (const x of fora) { const c = porCidFora.get(x.cidade) ?? { cidade: x.cidade, clientes: 0, ds: [] }; c.clientes++; c.ds.push(x.d); porCidFora.set(x.cidade, c); }
    const dentroOk = dentro.length >= Math.max(10, mesma.length * 0.3);
    distancias = {
      base, mesmaCidade: { cidade: lojaGeo?.cidade ?? cidadeTop, clientes: mesma.length, faturamento: soma(mesma), percent: r2(mesma.length / base * 100) },
      foraFaixas: faixa(fora, [[20, 'até 20 km'], [50, '20 a 50 km'], [100, '50 a 100 km'], [1e9, 'mais de 100 km']] as const),
      cidadesFora: [...porCidFora.values()].sort((a, b) => b.clientes - a.clientes).slice(0, 10).map((c) => ({ cidade: c.cidade, clientes: c.clientes, km: r2(c.ds.sort((a, b) => a - b)[Math.floor(c.ds.length / 2)]) })),
      raio80: q(0.8), raio90: q(0.9),
      dentro: dentroOk ? { base: dentro.length, mediana: r2(dentro.map((x) => x.d).sort((a, b) => a - b)[Math.floor(dentro.length / 2)]), faixas: faixa(dentro, [[2, 'até 2 km'], [5, '2 a 5 km'], [1e9, 'mais de 5 km']] as const) } : null,
    };
  }
  return {
    clientes: lista.length, cadastrosLidos: lidos, cadastrosFaltando: cad.faltando, comEndereco: end.size, semEndereco: lidos - end.size,
    cidades: [...porCidade.values()].sort((a, b) => b.clientes - a.clientes).slice(0, 15).map((x) => ({ ...x, fat: r2(x.fat) })),
    bairros: [...porBairro.values()].sort((a, b) => b.clientes - a.clientes).slice(0, 20).map((x) => ({ ...x, fat: r2(x.fat) })),
    loja: centro ? { lat: centro.lat, lng: centro.lng, bairro: centro.bairro ?? null, cidade: centro.cidade ?? null, estimado: centroEstimado } : null,
    distancias, pontos: [...agg.values()].sort((a, b) => b.n - a.n).slice(0, 1500), mesmaCidadeSemPosicao: mesma.length - dentro.length,
    cepsSemCoordenada: faltando, semPosicao, comCepDaLoja, lojaAproximada, tabelaCepOk: tabelaOk, tabelaCadastroOk: ultimoDiagCadastro?.tabelaOk !== false,
  };
}

async function moduloClientes(body: any, a: Acesso) {
  const t0Clientes = Date.now();
  const apiBase = Deno.env.get('VAREJONLINE_API_BASE');
  if (!apiBase) throw new Error('VAREJONLINE_API_BASE não configurado.');
  if (body.acao === 'contatosRede') return contatosRede(a);
  const tokens = await getLojasTokens();
  const loja = String(body.loja ?? '') || (a.todas ? '' : a.lojas[0] ?? '');
  if (!loja || !tokens[loja]) throw new Error('Escolha uma loja.');
  exigirLoja(a, loja);
  if (body.acao === 'registrarContato' || body.acao === 'desfazerContato') return registrarContato(body, loja, a);
  const chave = tokens[loja];
  const meses = Math.min(24, Math.max(6, Number(body.meses ?? 12)));
  const sumidoDias = Math.min(365, Math.max(30, Number(body.sumidoDias ?? 90)));
  const hojeIso = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const hoje = new Date(+hojeIso.slice(0, 4), +hojeIso.slice(5, 7) - 1, +hojeIso.slice(8, 10));
  const ini = new Date(hoje); ini.setMonth(ini.getMonth() - meses); ini.setDate(ini.getDate() + 1);
  const dias = (iso: string) => Math.round((Date.parse(hojeIso) - Date.parse(iso)) / 86400_000);

  type Cli = { id: string; nome: string; documento: string; dias: Set<string>; vendas: number; fat: number; pecas: number; cats: Map<string, number>; modelos: Set<string>; prods: Set<string>; maxPeca: number; ultimoProduto: string; ultima: string; primeira: string; meses: Set<number>; fatDia: Map<string, number> };
  const clientes = new Map<string, Cli>();
  const vendasModelos: { cid: string | null; modelos: string[] }[] = [];
  const produtos = new Map<string, { modelo: string; codigo: string | null; qtd: number; qtd60: number; fat: number; ids: Set<string>; cat: string }>();
  const recente60 = (() => { const d = new Date(Date.parse(hojeIso) - 60 * 86400_000); return d.toISOString().slice(0, 10); })();
  let vendas = 0, vendasIdent = 0, fat = 0, fatIdent = 0;
  // sazonalidade da loja (ação comercial): faturamento por mês do ano e o que mais vende em cada mês
  const fatPorMes = new Array(12).fill(0);
  const modelosPorMes: Map<string, number>[] = Array.from({ length: 12 }, () => new Map());
  let primeiraVendaLoja = '9999';

  const parceiros = await fetchAllPages(`${apiBase}/terceiros?classes=FORNECEDOR,PRESTADOR_SERVICO`, chave).catch(() => []);
  const idsParceiros = new Set<string>(parceiros.filter((t: any) => (t?.classes ?? []).some((c: string) => /FORNECEDOR|PRESTADOR_SERVICO/.test(String(c)))).map((t: any) => String(t.id)));

  await buscarSaidasParalelo(apiBase, chave, ini, hoje, (sd) => {
    if (!ehVenda(sd)) return;
    const dia = diaDaVenda(sd); if (!dia) return;
    let f = 0, q = 0; const mods = new Set<string>();
    const itens: { modelo: string; pid: string; cat: string; v: number; q: number; desc: string }[] = [];
    for (const it of sd.mercadorias ?? []) {
      const qt = Math.max(0, Number(it.quantidade ?? 0)), v = Number(it.valorTotal ?? 0);
      if (qt <= 0) continue;
      f += v; q += qt;
      const desc = String(it.produto?.descricao ?? ''), modelo = modeloDe(desc), cat = categoriaDe(desc), pid = String(it.produto?.id ?? desc);
      mods.add(modelo); itens.push({ modelo, pid, cat, v, q: qt, desc });
      const p = produtos.get(modelo) ?? { modelo, codigo: it.produto?.codigoSistema ?? null, qtd: 0, qtd60: 0, fat: 0, ids: new Set<string>(), cat };
      p.qtd += qt; p.fat += v; p.ids.add(pid); if (dia >= recente60) p.qtd60 += qt; produtos.set(modelo, p);
    }
    if (q <= 0) return;
    vendas++; fat += f;
    const mesIdx = Number(dia.slice(5, 7)) - 1;
    fatPorMes[mesIdx] += f; if (dia < primeiraVendaLoja) primeiraVendaLoja = dia;
    for (const it of itens) modelosPorMes[mesIdx].set(it.modelo, (modelosPorMes[mesIdx].get(it.modelo) ?? 0) + it.q);
    const t = sd.terceiro;
    const ok = clienteIdentificado(t) && !idsParceiros.has(String(t?.id));
    const cid = ok ? String(t.id) : null;
    vendasModelos.push({ cid, modelos: [...mods] });
    if (!cid) return;
    vendasIdent++; fatIdent += f;
    const c = clientes.get(cid) ?? { id: cid, nome: String(t.nome ?? '').trim(), documento: String(t.documento ?? ''), dias: new Set<string>(), vendas: 0, fat: 0, pecas: 0, cats: new Map(), modelos: new Set<string>(), prods: new Set<string>(), maxPeca: 0, ultimoProduto: '', ultima: '', primeira: '9999', meses: new Set<number>(), fatDia: new Map<string, number>() };
    c.fatDia.set(dia, (c.fatDia.get(dia) ?? 0) + f);
    c.dias.add(dia); c.meses.add(mesIdx); c.vendas++; c.fat += f; c.pecas += q;
    for (const it of itens) {
      c.cats.set(it.cat, (c.cats.get(it.cat) ?? 0) + it.q); c.modelos.add(it.modelo); c.prods.add(it.pid);
      c.maxPeca = Math.max(c.maxPeca, it.v / it.q);
    }
    if (dia >= c.ultima) { c.ultima = dia; c.ultimoProduto = itens[0]?.desc ?? ''; }
    if (dia < c.primeira) c.primeira = dia;
    clientes.set(cid, c);
  }, 15, 3);

  const lista = [...clientes.values()];
  if (body.acao === 'localizacao') return { parametros: { loja, meses }, ...(await clientesLocalizacao(apiBase, chave, loja, lista, t0Clientes + 115_000)) };
  // o que está vendendo agora (últimos 60 dias), por categoria — base da sugestão de peça para cada cliente
  const emAlta = [...produtos.values()].filter((p) => p.qtd60 > 0).sort((x, y) => y.qtd60 - x.qtd60);
  const emAltaPorCat = new Map<string, string[]>();
  for (const p of emAlta) { const l = emAltaPorCat.get(p.cat) ?? []; if (l.length < 15) l.push(p.modelo); emAltaPorCat.set(p.cat, l); }
  const sugestaoPara = (c: Cli) => {
    const cats = [...c.cats.entries()].sort((x, y) => y[1] - x[1]).map((x) => x[0]);
    for (const cat of cats) { const m = (emAltaPorCat.get(cat) ?? []).find((mm) => !c.modelos.has(mm)); if (m) return m; }
    return emAlta.find((p) => !c.modelos.has(p.modelo))?.modelo ?? null;
  };
  // prazo ideal de volta: o ritmo de cada cliente (mediana dos dias entre as visitas dele); quem voltou poucas vezes
  // usa o ritmo da loja (mediana de todas as voltas). Calculado mais abaixo, junto com os indicadores.
  let prazoLoja = 60;
  const mediaDe = (xs: number[]) => { const o = [...xs].sort((x, y) => x - y); return o.length ? (o.length % 2 ? o[(o.length - 1) / 2] : (o[o.length / 2 - 1] + o[o.length / 2]) / 2) : null; };
  const prazoDe = (c: Cli) => {
    const ds = [...c.dias].sort(), ints: number[] = [];
    for (let i = 1; i < ds.length; i++) ints.push(Math.round((Date.parse(ds[i]) - Date.parse(ds[i - 1])) / 86400_000));
    const p = ints.length >= 2 ? mediaDe(ints)! : ints.length === 1 ? (ints[0] + prazoLoja) / 2 : prazoLoja;
    return Math.round(Math.min(365, Math.max(15, p)));
  };
  const statusVolta = (d: number, p: number) => d > sumidoDias ? 'sumido' : d < p * 0.8 ? 'em_dia' : d <= p * 1.3 ? 'hora' : 'atrasado';
  const perfil = (c: Cli) => {
    const prazo = prazoDe(c), d = dias(c.ultima);
    const volta = new Date(Date.parse(c.ultima) + prazo * 86400_000).toISOString().slice(0, 10);
    const cats = [...c.cats.entries()].sort((x, y) => y[1] - x[1]);
    const totPecas = cats.reduce((s, x) => s + x[1], 0) || 1;
    const precoPeca = c.pecas ? c.fat / c.pecas : 0;
    return {
      id: c.id, nome: c.nome || '(sem nome)', visitas: c.dias.size, compras: c.vendas, total: r2(c.fat), ticket: r2(c.fat / Math.max(1, c.vendas)),
      pecas: r2(c.pecas), precoMedioPeca: r2(precoPeca), faixaPreco: faixaPrecoDe(precoPeca),
      categoriaPreferida: cats[0]?.[0] ?? null, categorias: cats.slice(0, 3).map(([k, n]) => `${k} ${Math.round(n / totPecas * 100)}%`),
      primeiraCompra: c.primeira, ultimaCompra: c.ultima, diasSemComprar: dias(c.ultima), ultimoProduto: c.ultimoProduto,
      sugestao: sugestaoPara(c),
      prazoVoltaDias: prazo, voltaIdeal: volta, diasParaVolta: prazo - d, statusVolta: statusVolta(d, prazo),
    };
  };

  // ---- indicadores ----
  const ativos = lista.filter((c) => dias(c.ultima) <= 90).length;
  const recorrentes = lista.filter((c) => c.dias.size >= 2);
  const fatRec = recorrentes.reduce((s, c) => s + c.fat, 0);
  const intervalos: number[] = [];
  for (const c of lista) {
    const ds = [...c.dias].sort();
    for (let i = 1; i < ds.length; i++) intervalos.push(Math.round((Date.parse(ds[i]) - Date.parse(ds[i - 1])) / 86400_000));
  }
  intervalos.sort((x, y) => x - y);
  const mediana = intervalos.length ? intervalos[Math.floor(intervalos.length / 2)] : null;
  if (mediana != null) prazoLoja = Math.round(Math.min(180, Math.max(15, mediana)));
  const contVolta = { em_dia: 0, hora: 0, atrasado: 0, sumido: 0 } as Record<string, number>;
  for (const c of lista) contVolta[statusVolta(dias(c.ultima), prazoDe(c))]++;
  const noPrazoPct = lista.length ? r2((contVolta.em_dia + contVolta.hora) / lista.length * 100) : null;
  // ---- contatos feitos ("Hora de chamar" e outras listas): quem foi chamado e quem voltou depois ----
  const contatosFeitos = await lerContatosLoja(loja);
  const porId = new Map(lista.map((c) => [c.id, c]));
  const contato = resumoContatos(contatosFeitos, porId, hojeIso);
  // referência da rede: guarda o indicador desta loja (só na régua padrão: 12 meses, sumido = 90 dias)
  const recompraLoja = lista.length ? r2(lista.filter((c) => c.dias.size >= 2).length / lista.length * 100) : null;
  if (meses === 12 && sumidoDias === 90 && mediana != null && lista.length >= 30) {
    try {
      const linha: any = { loja, prazo_dias: prazoLoja, no_prazo_pct: noPrazoPct, recompra_pct: recompraLoja, clientes: lista.length, atualizado_em: new Date().toISOString() };
      const extra = contatosFeitos ? { contatados_90: contato.contatados, voltaram_90: contato.voltaram, retorno_contato_pct: contato.retornoPct, fat_apos_contato: contato.faturamento } : {};
      const r = await sb().from('clientes_indicadores').upsert({ ...linha, ...extra }, { onConflict: 'loja' });
      if (r?.error && contatosFeitos) await sb().from('clientes_indicadores').upsert(linha, { onConflict: 'loja' }); // colunas novas ainda não criadas
    } catch { /* sem a tabela: segue sem referência */ }
  }
  if (body.soIndicadores) return { loja, prazoDias: mediana != null ? prazoLoja : null, noPrazoPct, clientes: lista.length };
  const rede = await referenciaRedeClientes(loja, mediana != null ? prazoLoja : null);
  // posição entre as lojas: só para a franqueadora (admin/equipe); o franqueado vê a média e a situação
  if (rede && a.papel === 'franqueado') { rede.posicao = null; (rede as any).lojas = null; }
  // voltou em até 90 dias: entre quem fez a 1ª compra do período há mais de 90 dias (e depois do 1º mês, para não pegar quem já era cliente antes)
  const corteIni = new Date(ini); corteIni.setMonth(corteIni.getMonth() + 1);
  const corteIniIso = `${corteIni.getFullYear()}-${String(corteIni.getMonth() + 1).padStart(2, '0')}-${String(corteIni.getDate()).padStart(2, '0')}`;
  const coorte = lista.filter((c) => c.primeira >= corteIniIso && dias(c.primeira) > 90);
  const voltou90 = coorte.filter((c) => [...c.dias].some((d) => d > c.primeira && (Date.parse(d) - Date.parse(c.primeira)) / 86400_000 <= 90)).length;
  const novos30 = lista.filter((c) => c.primeira >= corteIniIso && dias(c.primeira) <= 30).length;

  const faixasRec = [[30, 'até 30 dias'], [60, '31 a 60 dias'], [90, '61 a 90 dias'], [180, '91 a 180 dias'], [100000, 'mais de 180 dias']] as const;
  const recencia = faixasRec.map(([lim, nome], i) => {
    const de = i ? faixasRec[i - 1][0] : -1;
    const g = lista.filter((c) => { const d = dias(c.ultima); return d > de && d <= lim; });
    return { faixa: nome, clientes: g.length, faturamento: r2(g.reduce((s, c) => s + c.fat, 0)) };
  });
  const faixasInt = [[15, 'até 15 dias'], [30, '16 a 30 dias'], [60, '31 a 60 dias'], [90, '61 a 90 dias'], [180, '91 a 180 dias'], [100000, 'mais de 180 dias']] as const;
  const intervalosFaixa = faixasInt.map(([lim, nome], i) => { const de = i ? faixasInt[i - 1][0] : -1; return { faixa: nome, voltas: intervalos.filter((d) => d > de && d <= lim).length }; });
  const frequencia = [['1 visita', 1, 1], ['2 visitas', 2, 2], ['3 a 5 visitas', 3, 5], ['6 ou mais', 6, 1e9]].map(([nome, mn, mx]) => {
    const g = lista.filter((c) => c.dias.size >= (mn as number) && c.dias.size <= (mx as number));
    return { faixa: nome, clientes: g.length, faturamento: r2(g.reduce((s, c) => s + c.fat, 0)) };
  });
  const porCat = new Map<string, { clientes: number; pecas: number }>();
  for (const c of lista) for (const [k, n] of c.cats) { const x = porCat.get(k) ?? { clientes: 0, pecas: 0 }; x.clientes++; x.pecas += n; porCat.set(k, x); }

  // ---- listas ----
  const sumidos = lista.filter((c) => dias(c.ultima) > sumidoDias).sort((x, y) => y.fat - x.fat).slice(0, 300).map(perfil);
  const horaDeChamar = lista.map((c) => ({ c, st: statusVolta(dias(c.ultima), prazoDe(c)) })).filter((x) => x.st === 'hora' || x.st === 'atrasado')
    .sort((x, y) => (x.st === 'hora' ? 0 : 1) - (y.st === 'hora' ? 0 : 1) || y.c.fat - x.c.fat).slice(0, 300).map((x) => perfil(x.c));
  const vip = [...lista].sort((x, y) => y.fat - x.fat).slice(0, 50).map((c) => ({ ...perfil(c), status: dias(c.ultima) <= 90 ? 'ativo' : dias(c.ultima) <= sumidoDias ? 'esfriando' : 'sumido' }));

  // ---- ação comercial: meses de alta e de baixa da loja ----
  const acaoComercial = (() => {
    const anoCheio = meses >= 12 && primeiraVendaLoja <= new Date(ini.getTime() + 31 * 86400_000).toISOString().slice(0, 10);
    if (!anoCheio) return { disponivel: false, motivo: meses < 12 ? 'Escolha 12 ou 24 meses em Ajustes para ver os meses de alta e de baixa.' : 'A loja ainda não tem 12 meses de vendas.' };
    const media = fatPorMes.reduce((x, y) => x + y, 0) / 12;
    if (media <= 0) return { disponivel: false, motivo: 'Sem vendas no período.' };
    const indice = fatPorMes.map((v) => Math.round(v / media * 100));
    const mesHoje = Number(hojeIso.slice(5, 7)) - 1;
    const tipoMes = (i: number) => indice[i] >= 115 ? 'alta' : indice[i] <= 85 ? 'baixa' : 'normal';
    const proximo = (tipo: string) => { for (let k = 0; k < 12; k++) { const i = (mesHoje + k) % 12; if (tipoMes(i) === tipo) return { mes: i, emMeses: k }; } return null; };
    const topDoMes = (i: number) => [...modelosPorMes[i].entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([modelo, qtd]) => ({ modelo, qtd: r2(qtd / (meses / 12)) }));
    const alta = proximo('alta'), baixa = proximo('baixa');
    // quem comprou no mês de alta: chamar antes de a alta começar
    const daAlta = alta ? lista.filter((c) => c.meses.has(alta.mes)).sort((x, y) => y.fat - x.fat) : [];
    const clientesDaAlta = daAlta.slice(0, 100).map(perfil);
    return {
      disponivel: true, indicePorMes: indice, mesAtual: mesHoje, tipoMesAtual: tipoMes(mesHoje),
      mesesAlta: indice.map((_, i) => i).filter((i) => tipoMes(i) === 'alta'), mesesBaixa: indice.map((_, i) => i).filter((i) => tipoMes(i) === 'baixa'),
      proximaAlta: alta ? { ...alta, indice: indice[alta.mes], maisVendidos: topDoMes(alta.mes), clientes: daAlta.length } : null,
      proximaBaixa: baixa ? { ...baixa, indice: indice[baixa.mes] } : null,
      clientesDaAlta,
    };
  })();

  // ---- para quem oferecer ----
  let oferecer: any = null;
  const busca = limpa(body.produto ?? '');
  if (busca) {
    const alvo = [...produtos.values()].filter((p) => limpa(p.modelo).includes(busca) || (p.codigo && limpa(p.codigo) === busca));
    if (!alvo.length) oferecer = { busca: body.produto, encontrado: false };
    else {
      const modelosAlvo = new Set(alvo.map((p) => p.modelo));
      const qtdAlvo = alvo.reduce((s, p) => s + p.qtd, 0), fatAlvo = alvo.reduce((s, p) => s + p.fat, 0);
      const preco = qtdAlvo ? fatAlvo / qtdAlvo : 0;
      const catCont = new Map<string, number>(); for (const p of alvo) catCont.set(p.cat, (catCont.get(p.cat) ?? 0) + p.qtd);
      const categoria = [...catCont.entries()].sort((x, y) => y[1] - x[1])[0][0];
      // o que costuma sair junto no mesmo atendimento
      const junto = new Map<string, number>(); let vendasComAlvo = 0;
      for (const v of vendasModelos) {
        if (!v.modelos.some((m) => modelosAlvo.has(m))) continue;
        vendasComAlvo++;
        for (const m of v.modelos) if (!modelosAlvo.has(m)) junto.set(m, (junto.get(m) ?? 0) + 1);
      }
      const coCompra = [...junto.entries()].filter(([, n]) => n >= 2).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([m, n]) => ({ modelo: m, vezes: n }));
      const coSet = new Set(coCompra.map((x) => x.modelo));
      const jaCompraram = lista.filter((c) => [...c.modelos].some((m) => modelosAlvo.has(m)));
      const candidatos: any[] = [];
      for (const c of lista) {
        if ([...c.modelos].some((m) => modelosAlvo.has(m))) continue;
        const totP = [...c.cats.values()].reduce((s, n) => s + n, 0) || 1;
        const naCat = c.cats.get(categoria) ?? 0;
        const juntoDele = [...c.modelos].filter((m) => coSet.has(m));
        if (!naCat && !juntoDele.length) continue; // sem relação com o produto
        let score = 0; const motivos: string[] = [];
        if (naCat) { score += 3 + 2 * (naCat / totP); motivos.push(`compra ${categoria.toLowerCase()} (${Math.round(naCat / totP * 100)}% das peças)`); }
        const pm = c.pecas ? c.fat / c.pecas : 0;
        if (preco && pm >= preco * 0.6 && pm <= preco * 1.5) { score += 2; motivos.push(`gasta ~${fmtBRL(pm)} por peça`); }
        else if (preco && c.maxPeca >= preco) { score += 1; motivos.push(`já levou peça de ${fmtBRL(c.maxPeca)}`); }
        if (juntoDele.length) { score += 2; motivos.push(`comprou ${juntoDele[0].toLowerCase()}, que costuma sair junto`); }
        const d = dias(c.ultima);
        if (d <= 60) score += 2; else if (d <= 120) score += 1; else if (d > 240) score -= 1;
        if (c.dias.size >= 3) { score += 1; motivos.push(`${c.dias.size} visitas no período`); }
        candidatos.push({ ...perfil(c), score: r2(score), motivo: motivos.join(' · ') });
      }
      candidatos.sort((x, y) => y.score - x.score || y.total - x.total);
      oferecer = {
        busca: body.produto, encontrado: true,
        alvo: { modelos: alvo.slice(0, 6).map((p) => p.modelo), nModelos: alvo.length, categoria, precoMedio: r2(preco), vendidos: r2(qtdAlvo), vendasComAlvo, coCompra },
        jaCompraram: jaCompraram.length, candidatos: candidatos.length, clientes: candidatos.slice(0, 150),
      };
    }
  }

  // ---- contatos (telefone/WhatsApp/aniversário) só de quem aparece nas listas + os 200 que mais gastam (aniversariantes) ----
  const top200 = [...lista].sort((x, y) => y.fat - x.fat).slice(0, 200);
  const ids = [...new Set([...(oferecer?.clientes ?? []).slice(0, 60), ...vip, ...horaDeChamar.slice(0, 80), ...sumidos.slice(0, 120), ...((acaoComercial as any).clientesDaAlta ?? []).slice(0, 40), ...top200].map((c: any) => c.id))];
  // Planilha: todos os clientes do período (o que faltar fica para a próxima vez — o que já foi lido fica guardado)
  const idsCad = body.exportar ? [...new Set([...ids, ...[...lista].sort((x, y) => y.fat - x.fat).map((c) => c.id)])] : ids;
  const cad = await cadastrosClientes(apiBase, chave, idsCad, Math.min(t0Clientes + 110_000, Date.now() + (body.exportar ? 95_000 : 40_000)));
  const contatos = new Map<string, any>([...cad.mapa].map(([id, r]) => [id, contatoDoCadastro(r)]));
  let todos: any[] | undefined;
  if (body.exportar) todos = [...lista].sort((x, y) => y.fat - x.fat).map((c) => ({ ...perfil(c), contato: contatos.get(c.id) ?? null }));
  const chamadoEm = new Map<string, string>();
  for (const r of contatosFeitos ?? []) if (!chamadoEm.has(r.cliente_id)) chamadoEm.set(r.cliente_id, r.contatado_em); // lista vem da mais nova para a mais antiga
  const comContato = (c: any) => ({ ...c, contato: contatos.get(c.id) ?? null, chamadoEm: chamadoEm.get(c.id) ?? null });
  const mesAtual = hojeIso.slice(5, 7), diaAtual = hojeIso.slice(8, 10);
  const aniversariantes = top200.concat(lista.filter((c) => dias(c.ultima) > sumidoDias))
    .filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i)
    .map((c) => ({ c, k: contatos.get(c.id) })).filter((x) => x.k?.aniversario?.slice(3, 5) === mesAtual)
    .sort((x, y) => x.k.aniversario.localeCompare(y.k.aniversario))
    .map((x) => ({ ...perfil(x.c), contato: x.k, jaPassou: x.k.aniversario.slice(0, 2) < diaAtual, hoje: x.k.aniversario.slice(0, 2) === diaAtual }));

  return {
    parametros: { loja, desde: `${ini.getFullYear()}-${String(ini.getMonth() + 1).padStart(2, '0')}-${String(ini.getDate()).padStart(2, '0')}`, ate: hojeIso, meses, sumidoDias },
    resumo: {
      vendas, vendasIdentificadas: vendasIdent, pctIdentificadas: vendas ? r2(vendasIdent / vendas * 100) : null,
      faturamento: r2(fat), faturamentoIdentificado: r2(fatIdent),
      clientes: lista.length, ativos90: ativos, novos30, recorrentes: recorrentes.length,
      recompraPct: lista.length ? r2(recorrentes.length / lista.length * 100) : null,
      voltou90Pct: coorte.length ? r2(voltou90 / coorte.length * 100) : null, voltou90Base: coorte.length,
      intervaloMedianoDias: mediana,
      prazoIdealDias: prazoLoja, voltaEmDia: contVolta.em_dia, voltaHora: contVolta.hora, voltaAtrasado: contVolta.atrasado, voltaSumido: contVolta.sumido,
      noPrazoPct, situacaoPrazo: noPrazoPct == null ? null : noPrazoPct >= 50 ? 'perto' : noPrazoPct >= 30 ? 'atencao' : 'longe',
      horaDeChamar: contVolta.hora + contVolta.atrasado,
      contatos: contatosFeitos ? contato : null,
      rede,
      fatRecorrentesPct: fatIdent ? r2(fatRec / fatIdent * 100) : null,
      ticketRecorrente: recorrentes.length ? r2(fatRec / recorrentes.reduce((s, c) => s + c.vendas, 0)) : null,
      ticketUmaVisita: lista.length - recorrentes.length ? r2((fatIdent - fatRec) / lista.filter((c) => c.dias.size < 2).reduce((s, c) => s + c.vendas, 0)) : null,
      sumidos: lista.filter((c) => dias(c.ultima) > sumidoDias).length,
      fatSumidos: r2(lista.filter((c) => dias(c.ultima) > sumidoDias).reduce((s, c) => s + c.fat, 0)),
    },
    recencia, intervalos: intervalosFaixa, frequencia,
    categorias: [...porCat.entries()].sort((x, y) => y[1].clientes - x[1].clientes).slice(0, 12).map(([categoria, v]) => ({ categoria, clientes: v.clientes, pecas: r2(v.pecas) })),
    sumidos: sumidos.map(comContato), vip: vip.map(comContato), horaDeChamar: horaDeChamar.map(comContato),
    acaoComercial: (acaoComercial as any).disponivel ? { ...acaoComercial, clientesDaAlta: (acaoComercial as any).clientesDaAlta.map(comContato) } : acaoComercial,
    oferecer: oferecer?.clientes ? { ...oferecer, clientes: oferecer.clientes.map(comContato) } : oferecer,
    produtos: [...produtos.values()].sort((x, y) => y.qtd - x.qtd).slice(0, 500).map((p) => p.modelo),
    todos,
    maisVendidos: emAlta.slice(0, 12).map((p) => ({ modelo: p.modelo, categoria: p.cat, vendidos60: r2(p.qtd60) })),
    aniversariantes,
    contatosIncompletos: cad.faltando > 0, contatosFaltando: cad.faltando,
  };
}
// ---- Contatos com clientes (acompanhamento do "Hora de chamar") ----
const diaBR = (ts: string) => new Date(Date.parse(ts) - 3 * 3600_000).toISOString().slice(0, 10);
// Contatos da loja nos últimos 120 dias (mais novo primeiro). null = tabela ainda não criada.
async function lerContatosLoja(loja: string): Promise<any[] | null> {
  try {
    const desde = new Date(Date.now() - 120 * 86400_000).toISOString();
    const { data, error } = await sb().from('contatos_clientes').select('cliente_id, contatado_em').eq('loja', loja).gte('contatado_em', desde).order('contatado_em', { ascending: false }).limit(5000);
    return error ? null : (data ?? []);
  } catch { return null; }
}
// Para cada cliente chamado nos últimos 90 dias (conta o 1º contato da janela): voltou = comprou do dia do contato
// até 30 dias depois. Quem foi chamado há menos de 30 dias e ainda não voltou fica "aguardando" (fora da taxa).
function resumoContatos(contatos: any[] | null, porId: Map<string, any>, hojeIso: string) {
  const vazio = { contatados: 0, voltaram: 0, aguardando: 0, retornoPct: null as number | null, faturamento: 0, ultimos30: 0, voltaramLista: [] as any[] };
  if (!contatos) return vazio;
  const lim90 = new Date(Date.parse(hojeIso) - 89 * 86400_000).toISOString().slice(0, 10);
  const lim30 = new Date(Date.parse(hojeIso) - 29 * 86400_000).toISOString().slice(0, 10);
  const primeiro = new Map<string, string>();
  for (const r of contatos) { const d = diaBR(r.contatado_em); if (d >= lim90) primeiro.set(r.cliente_id, d); } // mais novo → mais antigo: fica o mais antigo
  const ult30 = new Set(contatos.filter((r) => diaBR(r.contatado_em) >= lim30).map((r) => r.cliente_id));
  let voltaram = 0, aguardando = 0, fat = 0; const lista: any[] = [];
  for (const [id, d] of primeiro) {
    const c = porId.get(id);
    const fim = new Date(Date.parse(d) + 30 * 86400_000).toISOString().slice(0, 10);
    const dias = c ? [...c.dias].filter((x: string) => x >= d && x <= fim).sort() : [];
    if (dias.length) {
      voltaram++; const v = dias.reduce((s: number, x: string) => s + (c.fatDia.get(x) ?? 0), 0); fat += v;
      lista.push({ id, nome: c.nome || '(sem nome)', chamadoEm: d, voltouEm: dias[0], valor: r2(v) });
    } else if (d >= lim30) aguardando++;
  }
  const base = primeiro.size - aguardando;
  return { contatados: primeiro.size, voltaram, aguardando, retornoPct: base > 0 ? r2(voltaram / base * 100) : null, faturamento: r2(fat), ultimos30: ult30.size,
    voltaramLista: lista.sort((x, y) => y.voltouEm.localeCompare(x.voltouEm)).slice(0, 30) };
}
async function registrarContato(body: any, loja: string, a: Acesso) {
  const cid = String(body.clienteId ?? '').trim();
  if (!cid) throw new Error('Cliente não informado.');
  const t = await sb().from('contatos_clientes').select('id').limit(1);
  if (t.error) throw new Error('Rode antes o SQL 20261117000002_contatos_clientes.sql no Supabase.');
  const hoje0 = new Date(Date.parse(diaBR(new Date().toISOString()) + 'T03:00:00Z')).toISOString(); // meia-noite de Brasília
  if (body.acao === 'desfazerContato') { // apaga só o contato de hoje desse cliente (desfazer um clique errado)
    const { error } = await sb().from('contatos_clientes').delete().eq('loja', loja).eq('cliente_id', cid).gte('contatado_em', hoje0);
    if (error) throw new Error(error.message);
    return { ok: true, chamadoEm: null };
  }
  const agora = new Date().toISOString();
  // um registro por cliente por dia: clicar de novo no WhatsApp no mesmo dia não conta duas vezes
  const { data: ja } = await sb().from('contatos_clientes').select('contatado_em').eq('loja', loja).eq('cliente_id', cid).gte('contatado_em', hoje0).limit(1);
  if (ja?.length) return { ok: true, chamadoEm: ja[0].contatado_em, jaRegistrado: true };
  const { error } = await sb().from('contatos_clientes').insert({ loja, cliente_id: cid, cliente_nome: String(body.clienteNome ?? '').slice(0, 120) || null, motivo: String(body.motivo ?? '').slice(0, 20) || null, usuario: a.nome, contatado_em: agora });
  if (error) throw new Error(error.message);
  return { ok: true, chamadoEm: agora };
}
// Franqueadora: contatos e retorno de cada loja (retorno vem do último cálculo da tela Clientes / aquecimento)
async function contatosRede(a: Acesso) {
  if (a.papel === 'franqueado') throw new Error('Disponível só para a franqueadora.');
  const tokens = await getLojasTokens();
  const permitidas = lojasDoAcesso(a, undefined);
  const nomes = Object.keys(tokens).filter((n) => !permitidas || permitidas.includes(n)).sort();
  const desde30 = new Date(Date.now() - 30 * 86400_000).toISOString();
  const [cont, ind] = await Promise.all([
    lerTudo('contatos_clientes', 'loja, cliente_id', 'id', (q: any) => q.gte('contatado_em', desde30)),
    sb().from('clientes_indicadores').select('loja, contatados_90, voltaram_90, retorno_contato_pct, fat_apos_contato, atualizado_em'),
  ]);
  if (cont.error) throw new Error('Rode antes o SQL 20261117000002_contatos_clientes.sql no Supabase.');
  const c30 = new Map<string, Set<string>>();
  for (const r of cont.data) { if (!c30.has(r.loja)) c30.set(r.loja, new Set()); c30.get(r.loja)!.add(r.cliente_id); }
  const im = new Map((ind.data ?? []).map((r: any) => [r.loja, r]));
  const lojas = nomes.map((n) => { const i: any = im.get(n) ?? {}; return {
    loja: n, chamados30: c30.get(n)?.size ?? 0, contatados90: i.contatados_90 ?? null, voltaram90: i.voltaram_90 ?? null,
    retornoPct: i.retorno_contato_pct != null ? Number(i.retorno_contato_pct) : null, faturamento: i.fat_apos_contato != null ? Number(i.fat_apos_contato) : null, atualizadoEm: i.atualizado_em ?? null }; });
  const tc = lojas.reduce((s, l) => s + (l.contatados90 ?? 0), 0), tv = lojas.reduce((s, l) => s + (l.voltaram90 ?? 0), 0);
  return { lojas: lojas.sort((x, y) => y.chamados30 - x.chamados30 || x.loja.localeCompare(y.loja)),
    rede: { chamados30: lojas.reduce((s, l) => s + l.chamados30, 0), lojasQueChamaram: lojas.filter((l) => l.chamados30 > 0).length, contatados90: tc, voltaram90: tv,
      faturamento: r2(lojas.reduce((s, l) => s + (l.faturamento ?? 0), 0)) } };
}

// Média da rede do prazo de volta (lojas atualizadas nos últimos 10 dias) e onde esta loja fica.
async function referenciaRedeClientes(loja: string, prazoLoja: number | null) {
  try {
    const desde = new Date(Date.now() - 10 * 86400_000).toISOString();
    const { data, error } = await sb().from('clientes_indicadores').select('loja, prazo_dias, no_prazo_pct').gte('atualizado_em', desde);
    if (error || !data) return null;
    const outras = data.filter((r: any) => r.prazo_dias != null);
    if (outras.filter((r: any) => r.loja !== loja).length < 3) return null; // poucas lojas: a média ainda não diz nada
    const media = Math.round(outras.reduce((s: number, r: any) => s + Number(r.prazo_dias), 0) / outras.length);
    const comPct = outras.filter((r: any) => r.no_prazo_pct != null);
    const mediaNoPrazo = comPct.length ? r2(comPct.reduce((s: number, r: any) => s + Number(r.no_prazo_pct), 0) / comPct.length) : null;
    let situacao: string | null = null, posicao: number | null = null;
    if (prazoLoja != null) {
      situacao = prazoLoja <= media * 0.9 ? 'melhor' : prazoLoja <= media * 1.15 ? 'em_dia' : 'longe';
      const lista = outras.filter((r: any) => r.loja !== loja).map((r: any) => Number(r.prazo_dias)).concat(prazoLoja).sort((x: number, y: number) => x - y);
      posicao = lista.indexOf(prazoLoja) + 1; // 1 = loja onde o cliente volta mais rápido
    }
    return { prazoMedioDias: media, noPrazoMedioPct: mediaNoPrazo, lojas: Math.max(outras.length, outras.filter((r: any) => r.loja !== loja).length + (prazoLoja != null ? 1 : 0)), situacao, posicao };
  } catch { return null; }
}

// Aquecimento: calcula o prazo de volta de cada loja (régua padrão) para a média da rede ficar pronta.
async function aquecerClientesRede() {
  const t0 = Date.now(), prazo = t0 + 110_000;
  const tokens = await getLojasTokens(), nomes = Object.keys(tokens);
  const ontem = new Date(Date.now() - 20 * 3600_000).toISOString();
  let feitas = new Set<string>();
  try { const { data } = await sb().from('clientes_indicadores').select('loja').gte('atualizado_em', ontem); feitas = new Set((data ?? []).map((r: any) => r.loja)); } catch { /* sem tabela */ }
  const fila = nomes.filter((n) => !feitas.has(n)), prontas: string[] = [], pendentes: string[] = [], erros: any[] = [];
  const todas: Acesso = { tipo: 'senha', nome: 'aquecimento', papel: 'admin', lojas: [], todas: true };
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(3, fila.length) }, async () => {
    while (i < fila.length) {
      const nome = fila[i++];
      if (Date.now() > prazo - 30_000) { pendentes.push(nome); continue; }
      try { await moduloClientes({ loja: nome, meses: 12, sumidoDias: 90, soIndicadores: true }, todas); prontas.push(nome); }
      catch (e) { erros.push({ loja: nome, erro: e instanceof Error ? e.message : String(e) }); }
    }
  }));
  return { completo: !pendentes.length, prontas, pendentes, erros, jaEstavam: feitas.size, ms: Date.now() - t0 };
}
const fmtBRL = (v: number) => `R$ ${v.toFixed(2).replace('.', ',')}`;

// =====================================================================
// PRODUTOS (Início): top 10 mais vendidos nos últimos 30 dias e oportunidades —
// produtos com estoque na loja e nenhuma venda há 90 dias ou mais.
// body: { loja?: string }  ('' = rede/todas as lojas liberadas: só o top 10; oportunidades precisam de uma loja)
// =====================================================================
async function moduloProdutos(body: any, a: Acesso) {
  const apiBase = Deno.env.get('VAREJONLINE_API_BASE');
  if (!apiBase) throw new Error('VAREJONLINE_API_BASE não configurado.');
  const tokens = await getLojasTokens();
  let loja = String(body.loja ?? '');
  if (loja) exigirLoja(a, loja);
  const permitidas = lojasDoAcesso(a, undefined);
  const nomes = loja ? [loja] : Object.keys(tokens).filter((n) => !permitidas || permitidas.includes(n));
  if (!nomes.length || nomes.some((n) => !tokens[n])) throw new Error('Loja não encontrada.');
  if (!loja && nomes.length === 1) loja = nomes[0];

  const hojeIso = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const hoje = new Date(+hojeIso.slice(0, 4), +hojeIso.slice(5, 7) - 1, +hojeIso.slice(8, 10));
  const isoMenos = (n: number) => new Date(Date.parse(hojeIso) - n * 86400_000).toISOString().slice(0, 10);
  const d30 = isoMenos(29), d60 = isoMenos(59), d90 = isoMenos(89);
  // loja: 12 meses (para dizer quando foi a última venda do parado); rede: 60 dias (top 10 + mês anterior)
  const ini = new Date(hoje); if (loja) { ini.setFullYear(ini.getFullYear() - 1); ini.setDate(ini.getDate() + 1); } else ini.setDate(ini.getDate() - 59);

  const modelos = new Map<string, { modelo: string; qtd: number; fat: number; qtdAnt: number; variacoes: Set<string>; lojas: Set<string>; ids: Set<string> }>();
  const porProduto = new Map<string, { ultima: string; qtd: number; custo: number; fat: number }>();
  const entVenda = new Set<string>();
  const erros: { loja: string; erro: string }[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(4, nomes.length) }, async () => {
    while (i < nomes.length) {
      const nome = nomes[i++];
      try {
        await buscarSaidasParalelo(apiBase, tokens[nome], ini, hoje, (sd) => {
          if (!ehVenda(sd)) return;
          const dia = diaDaVenda(sd); if (!dia) return;
          if (loja && sd.entidade?.id != null && dia >= d90) entVenda.add(String(sd.entidade.id));
          for (const it of sd.mercadorias ?? []) {
            const q = Number(it.quantidade ?? 0); if (q <= 0) continue;
            const v = Number(it.valorTotal ?? 0), desc = String(it.produto?.descricao ?? ''), pid = String(it.produto?.id ?? desc);
            if (loja) {
              const p = porProduto.get(pid) ?? { ultima: '', qtd: 0, custo: 0, fat: 0 };
              if (dia > p.ultima) p.ultima = dia; p.qtd += q; p.custo += Number(it.valorCusto ?? 0); p.fat += v; porProduto.set(pid, p);
            }
            if (dia < d60) continue;
            const mod = modeloDe(desc);
            const m = modelos.get(mod) ?? { modelo: mod, qtd: 0, fat: 0, qtdAnt: 0, variacoes: new Set<string>(), lojas: new Set<string>(), ids: new Set<string>() };
            if (dia >= d30) { m.qtd += q; m.fat += v; m.variacoes.add(desc); m.lojas.add(nome); m.ids.add(pid); } else m.qtdAnt += q;
            modelos.set(mod, m);
          }
        }, 15, 3);
      } catch (e) { erros.push({ loja: nome, erro: e instanceof Error ? e.message : String(e) }); }
    }
  }));

  // estoque da loja (só a unidade que vende, como na compra recorrente)
  let estoque: Map<string, { qtd: number; desc: string; codigo: string | null }> | null = null;
  let erroEstoque: string | null = null;
  if (loja && !erros.length) {
    try {
      let saldos: any[] = await saldosComCache(fetchAllPages, `${apiBase}/saldos-mercadorias`, tokens[loja], () => {});
      if (!saldos.length && entVenda.size) saldos = await saldosComCache(fetchAllPages, `${apiBase}/saldos-mercadorias?entidades=${[...entVenda].join(',')}`, tokens[loja], () => {});
      const ents = new Set(saldos.map((s: any) => String(s.entidade?.id ?? '?')));
      if (ents.size > 1 && entVenda.size && [...entVenda].some((e) => ents.has(e))) saldos = saldos.filter((s: any) => entVenda.has(String(s.entidade?.id)));
      estoque = new Map();
      for (const s of saldos) {
        const id = s.produto?.id; if (id == null) continue;
        const k = String(id), cur = estoque.get(k) ?? { qtd: 0, desc: String(s.produto?.descricao ?? ''), codigo: s.produto?.codigoSistema ?? null };
        cur.qtd += Number(s.quantidade ?? 0); estoque.set(k, cur);
      }
    } catch (e) { erroEstoque = e instanceof Error ? e.message : String(e); }
  }

  const top10 = [...modelos.values()].filter((m) => m.qtd > 0).sort((x, y) => y.qtd - x.qtd || y.fat - x.fat).slice(0, 10).map((m, pos) => ({
    posicao: pos + 1, modelo: m.modelo, pecas: r2(m.qtd), faturado: r2(m.fat), precoMedio: m.qtd ? r2(m.fat / m.qtd) : null,
    pecasMesAnterior: r2(m.qtdAnt), variacao: m.qtdAnt ? r2((m.qtd / m.qtdAnt - 1) * 100) : null,
    variacoes: m.variacoes.size, lojas: m.lojas.size,
    estoque: estoque ? r2([...m.ids].reduce((s, id) => s + Math.max(0, estoque!.get(id)?.qtd ?? 0), 0)) : null,
  }));

  let oportunidades: any[] | null = null, totalParados = 0, pecasParadas = 0, valorParado = 0;
  if (estoque) {
    const parados = [...estoque.entries()].filter(([id, e]) => e.qtd > 0 && !((porProduto.get(id)?.ultima ?? '') >= d90)).map(([id, e]) => {
      const v = porProduto.get(id);
      const custoUnit = v && v.qtd ? v.custo / v.qtd : null, precoUnit = v && v.qtd ? v.fat / v.qtd : null;
      return {
        produtoId: id, produto: e.desc, codigo: e.codigo, estoque: r2(e.qtd),
        ultimaVenda: v?.ultima || null, diasSemVender: v?.ultima ? Math.round((Date.parse(hojeIso) - Date.parse(v.ultima)) / 86400_000) : null,
        vendidos12m: r2(v?.qtd ?? 0), precoMedio: precoUnit != null ? r2(precoUnit) : null,
        valorParado: custoUnit != null ? r2(custoUnit * e.qtd) : null, valorVendaParado: precoUnit != null ? r2(precoUnit * e.qtd) : null,
      };
    });
    // parados que não venderam em 12 meses: custo e preço do cadastro do produto (custo referencial / tabela padrão)
    const semValor = parados.filter((p) => p.valorParado == null).map((p) => p.produtoId);
    if (semValor.length) {
      const cad = new Map<string, any>(); const lotes: string[][] = [];
      for (let k = 0; k < semValor.length; k += 100) lotes.push(semValor.slice(k, k + 100));
      const prazo = Date.now() + 25_000; let li = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (li < lotes.length && Date.now() < prazo) {
          const lote = lotes[li++];
          try { await fetchAllPages(`${apiBase}/produtos?idsProdutos=${lote.join(',')}`, tokens[loja], (pg) => { for (const pr of pg) cad.set(String(pr.id), { custo: Number(pr.custoReferencial ?? 0), preco: Number(pr.preco ?? 0) }); }); } catch (_) { /* fica sem valor */ }
        }
      }));
      for (const p of parados) {
        const c = cad.get(p.produtoId); if (!c) continue;
        if (p.valorParado == null && c.custo > 0) p.valorParado = r2(c.custo * p.estoque);
        if (p.valorVendaParado == null && c.preco > 0) { p.valorVendaParado = r2(c.preco * p.estoque); p.precoMedio = r2(c.preco); }
      }
    }
    totalParados = parados.length; pecasParadas = r2(parados.reduce((s, p) => s + p.estoque, 0));
    valorParado = r2(parados.reduce((s, p) => s + (p.valorParado ?? 0), 0));
    // primeiro o que tem mais dinheiro parado (custo); sem custo conhecido, pela quantidade
    oportunidades = parados.sort((x, y) => (y.valorParado ?? -1) - (x.valorParado ?? -1) || y.estoque - x.estoque).slice(0, 10);
  }
  return {
    parametros: { loja: loja || null, lojas: nomes.length, hoje: hojeIso, de30: d30, sem90Desde: d90 },
    top10, oportunidades, totalParados, pecasParadas, valorParado, erroEstoque, erros,
  };
}

// Metas do mes por vendedor: listar { loja, ano, mes } / salvar { loja, ano, mes, metas:[{ vendedorId, vendedorNome, meta }] }
// Franqueado define a meta da equipe das proprias lojas; admin/equipe de qualquer loja.
async function moduloMetasVendedores(body: any, a: Acesso) {
  const loja = String(body.loja ?? '').trim(), ano = Number(body.ano), mes = Number(body.mes);
  if (!loja || !(ano > 2000) || !(mes >= 1 && mes <= 12)) throw new Error('Informe loja, ano e mês.');
  exigirLoja(a, loja);
  const t = await sb().from('metas_vendedores').select('vendedor_id').limit(1);
  if (t.error) throw new Error('Rode antes o SQL 20261109000001_metas_vendedores.sql no Supabase.');
  if (body.acao === 'salvar') {
    const agora = new Date().toISOString();
    const linhas = (Array.isArray(body.metas) ? body.metas : []).slice(0, 200).filter((m: any) => m.vendedorId != null && Number(m.meta) >= 0)
      .map((m: any) => ({ loja, ano, mes, vendedor_id: String(m.vendedorId), vendedor_nome: String(m.vendedorNome ?? '').slice(0, 120) || null, meta: Math.round(Number(m.meta) * 100) / 100, atualizado_por: a.nome, atualizado_em: agora }));
    const zerar = linhas.filter((l: any) => !l.meta).map((l: any) => l.vendedor_id);
    const gravar = linhas.filter((l: any) => l.meta > 0);
    if (zerar.length) await sb().from('metas_vendedores').delete().eq('loja', loja).eq('ano', ano).eq('mes', mes).in('vendedor_id', zerar);
    if (gravar.length) { const { error } = await sb().from('metas_vendedores').upsert(gravar, { onConflict: 'loja,ano,mes,vendedor_id' }); if (error) throw new Error(error.message); }
    return { ok: true, salvas: gravar.length, removidas: zerar.length };
  }
  const { data, error } = await sb().from('metas_vendedores').select('vendedor_id, vendedor_nome, meta, atualizado_por, atualizado_em').eq('loja', loja).eq('ano', ano).eq('mes', mes);
  if (error) throw new Error(error.message);
  return { metas: data ?? [] };
}

// Ultimo acesso dos franqueados por loja (Supabase Auth)
async function acessosPorLoja() {
  const { data: perfis } = await sb().from('usuarios_painel').select('user_id, nome, papel, lojas, ativo').eq('papel', 'franqueado').eq('ativo', true);
  const ultimo = new Map<string, string | null>();
  for (let pg = 1; pg <= 5; pg++) {
    const { data, error } = await sb().auth.admin.listUsers({ page: pg, perPage: 1000 });
    if (error) break;
    for (const u of data?.users ?? []) ultimo.set(u.id, u.last_sign_in_at ?? null);
    if ((data?.users ?? []).length < 1000) break;
  }
  const m = new Map<string, { nomes: string[]; ultimo: string | null }>();
  for (const p of perfis ?? []) for (const l of p.lojas ?? []) {
    const x = m.get(l) ?? { nomes: [], ultimo: null }; x.nomes.push(p.nome);
    const u = ultimo.get(p.user_id) ?? null; if (u && (!x.ultimo || u > x.ultimo)) x.ultimo = u;
    m.set(l, x);
  }
  return m;
}

// ---- Tela de vinculos ----
let cacheCatalogo: { quando: number; idx: ReturnType<typeof indexarCatalogo>; cat: any } | null = null;
async function catalogoIndexado() {
  if (cacheCatalogo && cacheCentral && cacheCatalogo.quando === cacheCentral.quando && cacheFixo) return cacheCatalogo;
  const base = await buscarPedidosCentral(DIAS_CATALOGO);
  if (base.erro && !base.lista.length) throw new Error(base.erro);
  const cat = montarCatalogo(base.lista);
  // grava os itens novos no catálogo fixo sem segurar a resposta (antes isso deixava a 1ª chamada bem mais lenta)
  const grav = gravarItensDosPedidos(cat).catch(() => {}); (globalThis as any).EdgeRuntime?.waitUntil?.(grav);
  juntarCatalogoFixo(cat, await carregarCatalogoFixo());
  cacheCatalogo = { quando: cacheCentral?.quando ?? Date.now(), idx: indexarCatalogo(cat), cat };
  return cacheCatalogo;
}

async function moduloVinculos(body: any, apiBase?: string, lojasTokens?: Record<string, string>) {
  const acao = String(body.acao ?? '');

  // Produtos vendidos por UMA loja (leve: so vendas, sem estoque nem Central). O painel chama loja a loja para montar a visao da rede.
  if (acao === 'produtosVendidos') {
    const lj = String(body.loja ?? '');
    if (!apiBase || !lojasTokens?.[lj]) throw new Error('Loja invalida.');
    const dias = Math.min(180, Math.max(7, Number(body.dias ?? 90)));
    const fim = new Date(), ini = new Date(fim); ini.setDate(ini.getDate() - (dias - 1));
    const agg = new Map<string, any>();
    await buscarSaidasParalelo(apiBase, lojasTokens[lj], ini, fim, (sd) => {
      if (!ehVenda(sd)) return;
      for (const it of sd.mercadorias ?? []) {
        const pr = it.produto; if (!pr) continue;
        const k = String(pr.id);
        const a = agg.get(k) ?? { produtoId: pr.id, descricao: pr.descricao, codigoSistema: pr.codigoSistema ?? null, qtd: 0 };
        a.qtd += Number(it.quantidade ?? 0); agg.set(k, a);
      }
    });
    const produtos = [...agg.values()].map((a) => [a.produtoId, a.descricao, a.codigoSistema, r2(a.qtd / dias)]);
    // guarda na lista fixa da loja (sem segurar a resposta): quem vendeu uma vez fica na lista mesmo se parar de vender
    const g = guardarListaVinculosLoja(lj, produtos).catch(() => {}); (globalThis as any).EdgeRuntime?.waitUntil?.(g);
    if (body.aguardarLista) await g;
    return { loja: lj, dias, produtos };
  }
  // Lista fixa (já guardada): abre a tela na hora, sem ler as vendas das lojas de novo
  if (acao === 'listaFixa') {
    const { data, error } = await sb().from('painel_cache').select('chave, dados, atualizado_em').like('chave', 'vinc_loja:%');
    if (error) throw new Error('Rode antes o SQL 20261117000001_painel_cache.sql no Supabase.');
    const escolha = String(body.loja ?? '__REDE__');
    const linhasCache = (data ?? []).filter((r: any) => escolha === '__REDE__' || r.dados?.loja === escolha);
    const porProduto = new Map<string, any>();
    for (const r of linhasCache) for (const [produtoId, descricao, codigoSistema, venda, visto] of r.dados?.produtos ?? []) {
      const k = codigoSistema ? 'C:' + String(codigoSistema).trim().toUpperCase().replace(/\s+/g, '') : `I:${r.dados.loja}:${produtoId}`;
      const x = porProduto.get(k) ?? { produtoId, descricao, codigoSistema, vendaMediaDiaria: 0, lojas: 0, vistoEm: '' };
      x.vendaMediaDiaria += Number(venda) || 0; if (Number(venda) > 0) x.lojas++; if (visto > x.vistoEm) x.vistoEm = visto;
      porProduto.set(k, x);
    }
    const produtos = [...porProduto.values()].map((x) => ({ ...x, vendaMediaDiaria: r2(x.vendaMediaDiaria) }));
    const atualizados = linhasCache.map((r: any) => r.atualizado_em).sort();
    const base = { lojasNaLista: linhasCache.length, atualizadoDe: atualizados[0] ?? null, atualizadoAte: atualizados[atualizados.length - 1] ?? null, lojasLista: linhasCache.map((r: any) => r.dados?.loja).filter(Boolean) };
    if (!produtos.length) return { ...base, linhas: [], vazia: true };
    const r: any = await moduloVinculos({ acao: 'listar', loja: escolha === '__REDE__' ? 'TODA A REDE' : escolha, produtos });
    const visto = new Map(produtos.map((p) => [String(p.produtoId), { lojas: p.lojas, vistoEm: p.vistoEm }]));
    for (const l of r.linhas) { const v = visto.get(String(l.produtoId)); l.lojasQueVendem = v?.lojas ?? null; l.vistoEm = v?.vistoEm ?? null; }
    return { ...r, ...base };
  }
  const loja = String(body.loja ?? '').trim();
  const s = sb();

  if (acao === 'itensFornecedor') {
    const { idx } = await catalogoIndexado();
    const fid = String(body.fornecedorId ?? '');
    const itens = idx.itens.filter((x: any) => x.fornecedorId === fid)
      .sort((a: any, b: any) => String(b.ultimaCompra ?? '').localeCompare(String(a.ultimaCompra ?? '')) || String(a.descricao).localeCompare(String(b.descricao), 'pt-BR'))
      .slice(0, 600).map(resumoItemCentral);
    return { itens };
  }
  if (acao === 'buscar') {
    const q = limpa(body.q);
    if (q.length < 2) return { itens: [] };
    const { idx } = await catalogoIndexado();
    const termos = q.split(' ').filter(Boolean);
    const cod = codNorm(body.q);
    const res = idx.itens.map((it: any) => {
      const alvo = limpa(`${it.codigo} ${it.descricao} ${it.variacao} ${it.referencia ?? ''} ${it.fornecedorNome} ${it.categoria ?? ''} ${(it.descricoes ?? []).join(' ')}`);
      if (!termos.every((t) => alvo.includes(t))) return null;
      const sc = (codNorm(it.codigo) === cod ? 100 : 0) + (codNorm(it.codigo).startsWith(cod) ? 20 : 0) + Math.min(it.vezes, 20);
      return { it, sc };
    }).filter(Boolean).sort((a: any, b: any) => b.sc - a.sc).slice(0, 40).map((x: any) => { const g = itensDaGrade(idx, x.it); return { ...resumoItemCentral(x.it), tamanhosGrade: g?.itens.length ?? 0, tipoGrade: g?.tipo ?? null }; });
    return { itens: res };
  }

  if (acao === 'importarCatalogo') return await importarCatalogoPlanilha(body.itens);

  // Vinculos conferidos na planilha: { itens: [{ codigoSistema, produtoId, descricao, codigo, variacao, todasLetras }] }
  if (acao === 'importarVinculos') {
    const lista: any[] = Array.isArray(body.itens) ? body.itens : [];
    if (!lista.length || lista.length > 3000) throw new Error('Envie de 1 a 3000 vínculos por vez.');
    const { idx } = await catalogoIndexado();
    const quemImp = String(body.usuario ?? '').trim() || null, agora = new Date().toISOString();
    const linhas: any[] = [], erros: any[] = [];
    for (const v of lista) {
      const codigo = String(v.codigo ?? '').trim(), varTxt = String(v.variacao ?? '').trim();
      if (!codigo || (!v.codigoSistema && v.produtoId == null)) { erros.push({ produto: v.descricao, motivo: 'sem código da Central ou do sistema' }); continue; }
      let it = idx.porChave.get(chaveItem(codigo, varTxt));
      if (!it || it.doCatalogoFixo) {
        const cs = (idx.porCodigo.get(codNorm(codigo)) ?? []).filter((x: any) => codNorm(x.codigo) === codNorm(codigo));
        it = cs.find((x: any) => limpa(x.variacaoDescricao ?? x.variacao) === limpa(varTxt)) ?? cs.find((x: any) => !x.doCatalogoFixo && varNorm(x.variacaoDescricao ?? x.variacao) === varNorm(varTxt)) ?? cs.find((x: any) => varNorm(x.variacaoDescricao ?? x.variacao) === varNorm(varTxt)) ?? (!varTxt && cs.length === 1 ? cs[0] : undefined);
      }
      if (!it) {
        const nCod = (idx.porCodigo.get(codNorm(codigo)) ?? []).filter((x: any) => codNorm(x.codigo) === codNorm(codigo));
        erros.push({ produto: v.descricao, codigo, variacao: varTxt, motivo: !nCod.length ? 'código não está no catálogo da Central' : `escolha a variação (${nCod.slice(0, 6).map((x: any) => x.variacaoDescricao || x.variacao).join(', ')}${nCod.length > 6 ? '…' : ''})` });
        continue;
      }
      const grade = v.todasLetras === true && !!itensDaGrade(idx, it);
      linhas.push({ produto_chave: chaveProduto({ codigoSistema: v.codigoSistema, produtoId: v.produtoId }), produto_id: v.produtoId != null ? String(v.produtoId) : null,
        codigo_sistema: v.codigoSistema ? String(v.codigoSistema) : null, descricao_produto: v.descricao ?? null, chave_central: it.chave, codigo_central: it.codigo, variacao: it.variacaoDescricao ?? it.variacao ?? null,
        fornecedor_id: it.fornecedorId, descricao_central: it.descricao, ignorar: false, motivo: null, loja_origem: 'planilha', atualizado_por: quemImp, atualizado_em: agora, grade });
    }
    const unicos = [...new Map(linhas.map((l) => [l.produto_chave, l])).values()];
    for (let i = 0; i < unicos.length; i += 300) {
      const { error } = await s.from(TABELA_VINCULOS).upsert(unicos.slice(i, i + 300), { onConflict: 'produto_chave' });
      if (error) throw new Error(`Erro ao salvar vínculos: ${error.message}`);
    }
    return { ok: true, salvos: unicos.length, erros: erros.slice(0, 200), totalErros: erros.length };
  }

  if (!loja) throw new Error('Informe a loja.');

  if (acao === 'listar') {
    const produtos: any[] = Array.isArray(body.produtos) ? body.produtos : [];
    const { idx } = await catalogoIndexado();
    const vinc = await carregarVinculosLoja(loja);
    const linhas = produtos.map((r) => {
      const m = casarProduto(r, idx, vinc);
      const vn = vinc.novos.get(chaveProduto(r));
      return {
        produtoId: r.produtoId, descricao: r.descricao, codigoSistema: r.codigoSistema ?? null, codigoInterno: r.codigoInterno ?? null,
        vendaMediaDiaria: r.vendaMediaDiaria ?? 0, estoqueAtual: r.estoqueAtual ?? null,
        via: m.via, variacaoIncerta: m.variacaoIncerta, vinculoQuebrado: !!(m as any).vinculoQuebrado, motivo: (m as any).motivo ?? null,
        grade: !!(m as any).grade,
        gradeEscolhida: (m as any).gradeEscolhida ? (m as any).gradeEscolhida.map(resumoItemCentral) : null,
        gradeDisponivel: (() => { const g = itensDaGrade(idx, m.item); return g ? { chave: m.item.chave, codigo: m.item.codigo, tipo: g.tipo, tamanhos: g.rotulos, codigos: g.tipo === 'letra' ? g.itens.map((x: any) => x.codigo) : [m.item.codigo] } : null; })(),
        central: m.item ? resumoItemCentral(m.item) : null,
        alternativas: m.alternativas.map(resumoItemCentral),
        atualizadoPor: vn?.atualizado_por ?? null, atualizadoEm: vn?.atualizado_em ?? null, lojaOrigem: vn?.loja_origem ?? null,
      };
    });
    return { loja, tabelaNova: vinc.tabelaNova, catalogoItens: idx.itens.length, linhas };
  }

  if (!vincTabelaOk) { const t = await s.from(TABELA_VINCULOS).select('produto_chave').limit(1); if (t.error) throw new Error('Tabela vinculos_produto_rede nao encontrada. Rode o SQL vinculos_produto_rede.sql no Supabase.'); vincTabelaOk = true; }
  const quem = String(body.usuario ?? '').trim() || null;

  if (acao === 'salvar' || acao === 'salvarLote') {
    if (colunaChavesGrade !== true) colunaChavesGrade = !(await s.from(TABELA_VINCULOS).select('chaves_grade').limit(1)).error; // só guarda quando a coluna já existe
    const lista: any[] = acao === 'salvar' ? [body] : (Array.isArray(body.itens) ? body.itens : []);
    if (!lista.length || lista.length > 1000) throw new Error('Envie de 1 a 1000 vinculos.');
    const { idx } = await catalogoIndexado();
    const linhas = lista.map((v) => {
      if (v.produtoId == null || !v.chave) throw new Error('Cada vinculo precisa de produtoId e chave do item da Central.');
      const it = idx.porChave.get(String(v.chave));
      if (!it) throw new Error(`Item da Central "${v.chave}" nao existe no catalogo.`);
      const extras = [...new Set<string>((Array.isArray(v.chaves) ? v.chaves : []).map((x: any) => String(x)))].filter((ch) => ch !== it.chave);
      for (const ch of extras) { const x = idx.porChave.get(ch); if (!x) throw new Error(`Item da Central "${ch}" nao existe no catalogo.`); if (x.fornecedorId !== it.fornecedorId) throw new Error('Todos os itens marcados precisam ser do mesmo fornecedor (o pedido é separado por fornecedor).'); }
      return {
        ...(extras.length ? { chaves_grade: extras.slice(0, 60), grade: true } : (colunaChavesGrade ? { chaves_grade: null } : {})), produto_chave: chaveProduto(v), produto_id: String(v.produtoId), codigo_sistema: v.codigoSistema ? String(v.codigoSistema) : null, descricao_produto: v.descricaoLoja ?? null,
        chave_central: it.chave, codigo_central: it.codigo, variacao: it.variacao || null, fornecedor_id: it.fornecedorId, descricao_central: it.descricao,
        ignorar: false, motivo: null, loja_origem: loja, atualizado_por: quem, atualizado_em: new Date().toISOString(),
        ...(v.grade === true ? { grade: !!itensDaGrade(idx, it) } : (v.grade === false ? { grade: false } : {})) };
    });
    if (linhas.some((l: any) => l.chaves_grade?.length) && !colunaChavesGrade) throw new Error('Para vincular vários itens da Central, rode antes o SQL 20261116000001_vinculos_varios_itens.sql no Supabase.');
    if (linhas.some((l: any) => l.grade === true)) {
      const t = await s.from(TABELA_VINCULOS).select('grade').limit(1);
      if (t.error) throw new Error('Para vincular a grade, rode antes o SQL 20261105000001_vinculos_grade.sql no Supabase.');
    }
    for (let i = 0; i < linhas.length; i += 200) {
      const { error } = await s.from(TABELA_VINCULOS).upsert(linhas.slice(i, i + 200), { onConflict: 'produto_chave' });
      if (error) throw new Error(`Erro ao salvar vinculos: ${error.message}`);
    }
    // devolve a linha já atualizada (o painel não precisa de uma segunda chamada para redesenhar)
    if (acao === 'salvar' && body.produto) { const r: any = await moduloVinculos({ acao: 'listar', loja, produtos: [body.produto] }); return { ok: true, salvos: linhas.length, linha: r.linhas?.[0] ?? null }; }
    return { ok: true, salvos: linhas.length };
  }
  if (acao === 'ignorar') {
    if (body.produtoId == null) throw new Error('Informe o produto.');
    const { error } = await s.from(TABELA_VINCULOS).upsert({ produto_chave: chaveProduto(body), produto_id: String(body.produtoId), codigo_sistema: body.codigoSistema ? String(body.codigoSistema) : null,
      descricao_produto: body.descricaoLoja ?? null, chave_central: null, codigo_central: null, variacao: null, fornecedor_id: null, descricao_central: null,
      ignorar: true, motivo: String(body.motivo ?? '').slice(0, 200) || null, loja_origem: loja, atualizado_por: quem, atualizado_em: new Date().toISOString() }, { onConflict: 'produto_chave' });
    if (error) throw new Error(`Erro ao salvar: ${error.message}`);
    return { ok: true };
  }
  if (acao === 'remover') {
    if (body.produtoId == null) throw new Error('Informe o produto.');
    const { error } = await s.from(TABELA_VINCULOS).delete().eq('produto_chave', chaveProduto(body));
    if (error) throw new Error(`Erro ao remover: ${error.message}`);
    return { ok: true };
  }
  throw new Error('Acao invalida: use listar, buscar, salvar, salvarLote, ignorar ou remover.');
}
let vincTabelaOk = false;

// Lista fixa de produtos de cada loja (painel_cache, chave vinc_loja:<loja>): junta a leitura nova com a guardada.
// [produtoId, descricao, codigoSistema, vendaMediaDiaria, vistoEm]. Sai da lista só quem não vende há mais de 1 ano.
async function guardarListaVinculosLoja(loja: string, produtos: any[][]) {
  const chave = `vinc_loja:${loja}`, hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const corte = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
  const { data, error } = await sb().from('painel_cache').select('dados').eq('chave', chave).maybeSingle();
  if (error) return; // sem a tabela
  const m = new Map<string, any[]>();
  for (const p of data?.dados?.produtos ?? []) if (p[4] >= corte) m.set(String(p[0]), [p[0], p[1], p[2], 0, p[4]]); // não apareceu agora: venda 0
  for (const [id, desc, cod, venda] of produtos) m.set(String(id), [id, desc, cod, venda, hoje]);
  await sb().from('painel_cache').upsert({ chave, dados: { loja, produtos: [...m.values()] }, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' });
}
// Aquecimento diário: lê as vendas de 90 dias de cada loja e atualiza a lista fixa (continua de onde parou)
async function aquecerVinculosRede() {
  const t0 = Date.now(), prazo = t0 + 110_000;
  const apiBase = Deno.env.get('VAREJONLINE_API_BASE')!, tokens = await getLojasTokens(), nomes = Object.keys(tokens);
  const ontem = new Date(Date.now() - 20 * 3600_000).toISOString();
  const { data, error } = await sb().from('painel_cache').select('chave').like('chave', 'vinc_loja:%').gte('atualizado_em', ontem);
  if (error) return { completo: true, erro: 'Rode o SQL 20261117000001_painel_cache.sql' };
  const feitas = new Set((data ?? []).map((r: any) => String(r.chave).slice('vinc_loja:'.length)));
  const fila = nomes.filter((n) => !feitas.has(n)), prontas: string[] = [], pendentes: string[] = [], erros: any[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(3, fila.length) }, async () => {
    while (i < fila.length) {
      const nome = fila[i++];
      if (Date.now() > prazo - 30_000) { pendentes.push(nome); continue; }
      try { await moduloVinculos({ acao: 'produtosVendidos', loja: nome, dias: 90, aguardarLista: true }, apiBase, tokens); prontas.push(nome); }
      catch (e) { erros.push({ loja: nome, erro: e instanceof Error ? e.message : String(e) }); }
    }
  }));
  return { completo: !pendentes.length, prontas, pendentes, erros, jaEstavam: feitas.size, ms: Date.now() - t0 };
}

// Diagnostico (somente leitura): mostra quais campos a API da Central devolve, mascarando dados pessoais.
const SENSIVEL = /email|telefone|fone|celular|cpf|cnpj|documento|rg\b|endereco|logradouro|cep|senha|token|key/i;
async function moduloDiagnosticoCentral(body: any) {
  const nDias = Math.min(60, Math.max(1, Number(body.dias ?? 30)));
  const base = await buscarPedidosCentralSemCache(nDias, true);
  if (base.erro && !base.lista.length) throw new Error(base.erro);
  const pedidos = base.lista, falhas = base.falhas;
  const campos = new Map<string, { tipos: Set<string>; exemplos: Set<string>; n: number }>();
  const mascarar = (k: string, v: unknown) => (SENSIVEL.test(k) ? '***' : String(v).slice(0, 50));
  function andar(o: any, base: string) {
    if (o === null || o === undefined) return;
    if (Array.isArray(o)) { o.slice(0, 20).forEach((x) => andar(x, base + '[]')); if (!o.length) registrar(base + '[]', 'array-vazio', ''); return; }
    if (typeof o === 'object') { for (const [k, v] of Object.entries(o)) andar(v, base ? `${base}.${k}` : k); return; }
    registrar(base, typeof o, mascarar(base, o));
  }
  function registrar(path: string, tipo: string, ex: string) {
    const c = campos.get(path) ?? { tipos: new Set(), exemplos: new Set(), n: 0 };
    c.tipos.add(tipo); c.n++; if (c.exemplos.size < 3 && ex !== '') c.exemplos.add(ex);
    campos.set(path, c);
  }
  pedidos.forEach((p) => andar(p, ''));
  const status: Record<string, number> = {};
  for (const p of pedidos) { const s = `${p.situacao?.status ?? '?'} | ${p.situacao?.descricao ?? '?'}`; status[s] = (status[s] ?? 0) + 1; }
  const limparObj = (o: any, k = ''): any => Array.isArray(o) ? o.slice(0, 2).map((x) => limparObj(x, k))
    : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([kk, v]) => [kk, limparObj(v, kk)]))
    : o == null ? o : SENSIVEL.test(k) ? '***' : o;
  return {
    diasConsultados: nDias, falhas, totalPedidos: pedidos.length, situacoes: status,
    campos: [...campos.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([path, c]) => ({ campo: path, tipo: [...c.tipos].join('/'), ocorrencias: c.n, exemplos: [...c.exemplos] })),
    exemploPedido: pedidos[0] ? limparObj(pedidos[0]) : null,
  };
}


// =====================================================================
// USUÁRIOS DO PAINEL (somente admin, exceto meuPerfil / senhaTrocada)
// Tabela usuarios_painel (SQL 20261105000002_usuarios_painel.sql)
// =====================================================================
function gerarSenhaTemporaria() {
  const letras = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz', nums = '23456789';
  const b = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (let i = 0; i < 10; i++) s += letras[b[i] % letras.length];
  return s.slice(0, 5) + nums[b[10] % nums.length] + nums[b[11] % nums.length] + s.slice(5);
}
async function moduloUsuarios(body: any, a: Acesso) {
  const acao = String(body.acao ?? '');
  const s = sb();
  if (acao === 'meuPerfil') {
    let lojas: string[] = a.lojas;
    if (a.todas) { const { data } = await s.from('lojas_config').select('nome').eq('ativo', true); lojas = (data ?? []).map((l: any) => l.nome).sort(); }
    return { tipo: a.tipo, nome: a.nome, email: a.email ?? null, papel: a.papel, todas: a.todas, lojas, trocarSenha: !!a.trocarSenha,
      loginObrigatorio: String(Deno.env.get('LOGIN_OBRIGATORIO') ?? '').toLowerCase() === 'true' };
  }
  if (acao === 'senhaTrocada') {
    if (a.tipo !== 'usuario') return { ok: true };
    await s.from('usuarios_painel').update({ trocar_senha: false, atualizado_em: new Date().toISOString() }).eq('user_id', a.userId);
    cacheAcesso.clear();
    return { ok: true };
  }
  exigirPapel(a, 'admin');
  const tab = await s.from('usuarios_painel').select('user_id').limit(1);
  if (tab.error) throw new Error('Tabela usuarios_painel nao encontrada. Rode o SQL 20261105000002_usuarios_painel.sql no Supabase.');
  const papelOk = (p: unknown) => { if (!['admin', 'equipe', 'franqueado'].includes(String(p))) throw new Error('Papel invalido: use admin, equipe ou franqueado.'); return String(p); };
  const validarLojas = async (lojas: unknown) => {
    const l = Array.isArray(lojas) ? [...new Set(lojas.map(String).filter(Boolean))] : [];
    if (!l.length) return l;
    const { data } = await s.from('lojas_config').select('nome').in('nome', l);
    const existe = new Set((data ?? []).map((x: any) => x.nome));
    const faltam = l.filter((x) => !existe.has(x));
    if (faltam.length) throw new Error(`Loja(s) nao cadastrada(s): ${faltam.join(', ')}`);
    return l;
  };

  if (acao === 'listar') {
    const { data, error } = await s.from('usuarios_painel').select('*').order('nome');
    if (error) throw new Error(error.message);
    const ultimos = new Map<string, string | null>();
    try { const r = await s.auth.admin.listUsers({ page: 1, perPage: 1000 }); for (const u of r.data?.users ?? []) ultimos.set(u.id, u.last_sign_in_at ?? null); } catch { /* opcional */ }
    return { usuarios: (data ?? []).map((u: any) => ({ userId: u.user_id, email: u.email, nome: u.nome, papel: u.papel, lojas: u.lojas ?? [], ativo: u.ativo, trocarSenha: u.trocar_senha, criadoEm: u.criado_em, criadoPor: u.criado_por, ultimoAcesso: ultimos.get(u.user_id) ?? null })) };
  }
  if (acao === 'criar') {
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('E-mail invalido.');
    const nome = String(body.nome ?? '').trim();
    if (!nome) throw new Error('Informe o nome.');
    const papel = papelOk(body.papel);
    const lojas = await validarLojas(body.lojas);
    if (papel === 'franqueado' && !lojas.length) throw new Error('Escolha pelo menos uma loja para o franqueado.');
    const senha = gerarSenhaTemporaria();
    let userId: string | null = null;
    const cr = await s.auth.admin.createUser({ email, password: senha, email_confirm: true, user_metadata: { nome } });
    if (cr.error) {
      if (!/already|registered|exists/i.test(cr.error.message)) throw new Error(`Erro ao criar o usuario: ${cr.error.message}`);
      const r = await s.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const u = (r.data?.users ?? []).find((x: any) => String(x.email).toLowerCase() === email);
      if (!u) throw new Error('E-mail ja cadastrado no Supabase, mas nao encontrado. Tente de novo.');
      userId = u.id;
      const up = await s.auth.admin.updateUserById(u.id, { password: senha });
      if (up.error) throw new Error(`Erro ao definir a senha: ${up.error.message}`);
    } else userId = cr.data.user!.id;
    const { error } = await s.from('usuarios_painel').upsert({ user_id: userId, email, nome, papel, lojas, ativo: true, trocar_senha: true, criado_por: a.nome, atualizado_em: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) throw new Error(`Erro ao salvar o perfil: ${error.message}`);
    return { ok: true, userId, email, senhaTemporaria: senha };
  }
  const alvo = String(body.userId ?? '');
  if (!alvo) throw new Error('Informe o usuario.');
  if (acao === 'atualizar') {
    const patch: Record<string, unknown> = { atualizado_em: new Date().toISOString() };
    if (body.nome !== undefined) patch.nome = String(body.nome).trim();
    if (body.papel !== undefined) patch.papel = papelOk(body.papel);
    if (body.lojas !== undefined) patch.lojas = await validarLojas(body.lojas);
    if (body.ativo !== undefined) patch.ativo = !!body.ativo;
    if (a.userId === alvo && (patch.papel && patch.papel !== 'admin' || patch.ativo === false)) throw new Error('Voce nao pode tirar o seu proprio acesso de administrador.');
    if (patch.papel === 'franqueado' || (patch.lojas !== undefined)) {
      const { data: atual } = await s.from('usuarios_painel').select('papel, lojas').eq('user_id', alvo).maybeSingle();
      const papelFinal = (patch.papel ?? atual?.papel), lojasFinal = (patch.lojas ?? atual?.lojas ?? []) as string[];
      if (papelFinal === 'franqueado' && !lojasFinal.length) throw new Error('Franqueado precisa de pelo menos uma loja.');
    }
    const { error } = await s.from('usuarios_painel').update(patch).eq('user_id', alvo);
    if (error) throw new Error(error.message);
    cacheAcesso.clear();
    return { ok: true };
  }
  if (acao === 'redefinirSenha') {
    const senha = gerarSenhaTemporaria();
    const up = await s.auth.admin.updateUserById(alvo, { password: senha });
    if (up.error) throw new Error(`Erro ao redefinir: ${up.error.message}`);
    await s.from('usuarios_painel').update({ trocar_senha: true, atualizado_em: new Date().toISOString() }).eq('user_id', alvo);
    cacheAcesso.clear();
    return { ok: true, senhaTemporaria: senha };
  }
  throw new Error('Acao invalida: use meuPerfil, senhaTrocada, listar, criar, atualizar ou redefinirSenha.');
}

Deno.serve(async (req) => {
  cors['Access-Control-Allow-Origin'] = origemPermitida(req);
  reiniciarMedicao();
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  // Configuração pública do login (URL do projeto + chave pública do Supabase Auth — feita para ficar no navegador).
  if (req.method === 'GET' && new URL(req.url).searchParams.has('config')) {
    return resp({ supabaseUrl: Deno.env.get('SUPABASE_URL'), anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? null,
      loginObrigatorio: String(Deno.env.get('LOGIN_OBRIGATORIO') ?? '').toLowerCase() === 'true' });
  }
  // Pre-aquecimento (tarefa agendada no GitHub): baixa e guarda as vendas e os pedidos da Central antes do expediente.
  // Protegido pelo secret AQUECER_CHAVE (cabecalho x-aquecer-chave); sem o secret, desligado.
  if (req.method === 'POST' && req.headers.get('x-aquecer-chave')) {
    const chave = Deno.env.get('AQUECER_CHAVE');
    if (!chave || !iguaisSeguro(req.headers.get('x-aquecer-chave') ?? '', chave)) { await freioTentativa(req); return resp({ error: 'Chave de aquecimento inválida.' }, 401); }
    try { return resp(await aquecerCaches(await req.json().catch(() => ({})))); } catch (e) { return resp({ error: e instanceof Error ? e.message : String(e) }, 500); }
  }
  let a: Acesso;
  try { a = await obterAcesso(req); } catch (e) { if (e instanceof ErroAcesso) return respostaErroAcesso(e, cors); throw e; }
  if (req.method === 'GET') return resp({ ok: true });
  try {
    const body = await req.json().catch(() => ({}));
    const modulo = String(body.modulo ?? '');
    if (modulo === 'usuarios') return resp(await moduloUsuarios(body, a));
    if (a.trocarSenha) throw new ErroAcesso('Troque a senha temporária antes de continuar.', 403);
    // o nome registrado em aprovações/vínculos é sempre o do usuário logado
    if (a.tipo === 'usuario') { body.aprovadoPor = a.nome; body.enviadoPor = a.nome; body.usuario = a.nome; }
    const equipe = () => exigirPapel(a, 'admin', 'equipe');

    if (modulo === 'vinculo') { exigirLoja(a, body.loja); return resp(await moduloVinculo(body)); }
    if (modulo === 'diagnosticoCentral') { equipe(); return resp(await moduloDiagnosticoCentral(body)); }
    if (modulo === 'catalogoCentral') { equipe(); return resp(await moduloCatalogoCentral(body)); }
    if (modulo === 'vinculos') {
      const acao = String(body.acao ?? '');
      if (['salvar', 'salvarLote', 'ignorar', 'remover', 'importarCatalogo', 'importarVinculos'].includes(acao)) equipe(); // vínculos valem para a rede inteira
      if (acao === 'produtosVendidos') { exigirLoja(a, body.loja); return resp(await moduloVinculos(body, Deno.env.get('VAREJONLINE_API_BASE')!, await getLojasTokens())); }
      return resp(await moduloVinculos(body));
    }
    if (modulo === 'dre') return resp(await moduloDre(body, a));
    if (modulo === 'painel') return resp(await moduloPainel(body, a));
    if (modulo === 'comparativo') return resp(await moduloComparativo(body, a));
    if (modulo === 'clientes') return resp(await moduloClientes(body, a));
    if (modulo === 'produtos') return resp(await moduloProdutos(body, a));
    if (modulo === 'fotosProdutos') return resp(await moduloFotosProdutos(body, a));
    if (modulo === 'metasVendedores') return resp(await moduloMetasVendedores(body, a));
    if (modulo === 'sincronizarCentral') return resp(await moduloSincronizarCentral(body));
    if (modulo === 'fornecedores') {
      equipe(); // painel da franqueadora
      if (body.acao === 'vendasLoja' || body.acao === 'estoqueLoja' || body.acao === 'mapearLoja' || body.acao === 'cadastroProdutos') exigirLoja(a, body.loja);
      return resp(await moduloFornecedores(body, a));
    }
    if (modulo === 'lojaEditar') { exigirPapel(a, 'admin'); return resp(await moduloLojaEditar(body)); }
    if (modulo === 'compatibilidade') { equipe(); return resp(await moduloCompatibilidade(Deno.env.get('VAREJONLINE_API_BASE')!, await getLojasTokens(), body)); }
    if (modulo === 'vendedores') { body.lojas = lojasDoAcesso(a, body.lojas); return resp(await moduloVendedores(Deno.env.get('VAREJONLINE_API_BASE')!, await getLojasTokens(), body)); }
    if (modulo === 'pedidoSugerido') {
      const acao = String(body.acao ?? 'gerar');
      if (acao === 'gerar' || acao === 'aprovar') exigirLoja(a, body.loja);
      if (acao === 'listar') { if (body.loja) exigirLoja(a, body.loja); else if (!a.todas) body.lojasPermitidas = a.lojas; }
      if (['status', 'opcoesEnvio', 'enviar'].includes(acao)) {
        const { data: ped } = await sb().from('pedidos_sugeridos').select('loja').eq('id', body.id ?? '').maybeSingle();
        if (ped) exigirLoja(a, ped.loja);
      }
      const precisaVarejo = acao === 'gerar';
      return resp(await moduloPedidoSugerido(precisaVarejo ? Deno.env.get('VAREJONLINE_API_BASE')! : '', precisaVarejo ? await getLojasTokens() : {}, body));
    }
    if (modulo === 'recorrente') {
      body.lojas = lojasDoAcesso(a, body.lojas);
      const apiBase = Deno.env.get('VAREJONLINE_API_BASE')!;
      if (body.soPrazos) { const base = await buscarPedidosCentral(DIAS_CATALOGO); return resp({ prazosFornecedores: base.lista.length ? prazosFornecedores(base.lista) : {} }); }
      const res: any = await moduloRecorrente(apiBase, await getLojasTokens(), body);
      if (body.prazos) { // prazo de entrega por fornecedor, para "pedir até" no alerta de ruptura
        try { const base = await buscarPedidosCentral(DIAS_CATALOGO); if (base.lista.length) res.prazosFornecedores = prazosFornecedores(base.lista); } catch { /* sem prazos: a tela usa o padrão */ }
      }
      return resp(res);
    }
    return resp({ error: `Modulo desconhecido: "${modulo}".` }, 400);
  } catch (e) {
    if (e instanceof ErroAcesso) return respostaErroAcesso(e, cors);
    if (e instanceof ConfirmacaoNecessaria) return resp({ error: e.message, confirmar: e.tipo }, 409);
    const msg = e instanceof Error ? e.message : String(e);
    return resp({ error: msg.replace(/token=[^&\s)]+/g, 'token=***') }, 500);
  }
});
