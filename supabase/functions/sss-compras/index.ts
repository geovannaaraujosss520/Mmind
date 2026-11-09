// sss-compras: Compra Recorrente com paginacao completa da VarejOnline + desconto dos pedidos em andamento da Central.
// Modulos (POST): { modulo: 'recorrente' | 'vinculo' | 'diagnosticoCentral' | 'catalogoCentral' | 'pedidoSugerido' | 'vendedores' | 'compatibilidade' | 'lojaEditar', ... }.
// Secrets: VAREJONLINE_API_BASE, APP_PASSCODE, PEDIDOS_API_KEY, ALLOWED_ORIGIN (opcional), LIMITE_PEDIDO_SEM_CONFIRMACAO (opcional, em R$).
// Tabelas: lojas_config, pedidos_vinculos, pedidos_sugeridos.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { saidasComCache, saldosComCache, reiniciarMedicao, resumoMedicao, medicao } from '../_shared/vendas_cache.ts';


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

async function obterAcesso(req: Request): Promise<Acesso> {
  const auth = req.headers.get('authorization') ?? '';
  const jwt = /^bearer /i.test(auth) ? auth.slice(7).trim() : '';
  const chavesPublicas = [Deno.env.get('SUPABASE_ANON_KEY'), Deno.env.get('SUPABASE_PUBLISHABLE_KEY')].filter(Boolean);
  if (jwt && !chavesPublicas.includes(jwt)) {
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
  if (!obrigatorio && esperado && (req.headers.get('x-app-passcode') ?? '') === esperado) return { tipo: 'senha', nome: 'Senha do time', papel: 'admin', lojas: [], todas: true };
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
    if (onPage) onPage(items); else out.push(...items);
    inicio += items.length;
  }
  return out;
}

// Le as vendas em janelas de ~15 dias em paralelo (a paginacao da VarejOnline e sequencial e lenta em lojas grandes).
// As janelas se sobrepoem em 1 dia e as vendas repetidas sao descartadas pelo id.
// Vendas de um periodo: dias fechados vem do cache (vendas_cache_dias); ontem e hoje, da VarejOnline.
async function buscarSaidasParalelo(apiBase: string, token: string, dIni: Date, dFim: Date, onSaida: (sd: any) => void, janelaDias = 15, conc = 4) {
  await saidasComCache({ sb, buscarPaginas: fetchAllPages, apiBase, token, loja: lojaPorToken.get(token) ?? null, dIni, dFim, onSaida, janelaDias, conc });
}

const lojaPorToken = new Map<string, string>();
async function getLojasTokens(): Promise<Record<string, string>> {
  const { data, error } = await sb().from('lojas_config').select('nome, token').eq('ativo', true);
  if (error) throw new Error(`Erro ao ler lojas_config: ${error.message}`);
  const m: Record<string, string> = {};
  for (const r of data ?? []) { m[r.nome] = r.token; if (r.token) lojaPorToken.set(r.token, r.nome); }
  return m;
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
  const { data, error } = await sb().from('pedidos_vinculos').select('loja, codigo_central, produto_id, ignorar');
  if (error) return { mapa, aviso: `Vinculos nao carregados: ${error.message}` as string | undefined };
  for (const r of data ?? []) {
    if (!mapa.has(r.loja)) mapa.set(r.loja, new Map());
    mapa.get(r.loja)!.set(r.codigo_central, r);
  }
  return { mapa, aviso: undefined as string | undefined };
}

const enxutoSaldo = (sl: any) => ({ quantidade: sl.quantidade, entidade: sl.entidade ? { id: sl.entidade.id, nome: sl.entidade.nome } : undefined,
  produto: sl.produto ? { id: sl.produto.id, codigoSistema: sl.produto.codigoSistema, codigoInterno: sl.produto.codigoInterno, codigoBarras: sl.produto.codigoBarras } : undefined });

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
    let r: any = await sb().from(TABELA_VINCULOS).select('produto_chave, chave_central, codigo_central, variacao, ignorar, grade, descricao_central');
    if (r.error) r = await sb().from(TABELA_VINCULOS).select('produto_chave, chave_central, codigo_central, variacao, ignorar, descricao_central');
    const data = r.data;
    for (const v of data ?? []) vincRede.set(String(v.produto_chave), v);
  }

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
        const cur = itens.get(ch) ?? { cod: c, chave: ch, codigoCentral: String(i.codigo).trim(), descricao: i.descricaoProduto, qtd: 0, pedidos: [] };
        cur.qtd += q;
        cur.pedidos.push({ pedido: p.codigo, situacao: p.situacao?.descricao, quantidade: q, criadoEm: p.dataCriacao });
        itens.set(ch, cur);
      }
    }

    const vl = vinc.mapa.get(nomeLoja) ?? new Map<string, any>();
    const andamentoProd = new Map<string, { qtd: number; pedidos: any[] }>();
    const revisao: any[] = [];
    let vinculados = 0, ignorados = 0, semVenda = 0;
    // vinculos exatos (produto -> codigo+variacao) desta loja, invertidos: item da Central -> produto
    const exatos = new Map<string, string[]>();
    const porGrade = new Map<string, string[]>();
    for (const [prod, vd] of venda) {
      const v = vincRede.get(chaveProduto({ codigoSistema: vd.codigoSistema, produtoId: prod }));
      if (v && !v.ignorar && v.chave_central) {
        if (!exatos.has(v.chave_central)) exatos.set(v.chave_central, []); exatos.get(v.chave_central)!.push(prod);
        const cv = `CV:${codVar(v.codigo_central ?? String(v.chave_central).split('|')[0], v.variacao ?? String(v.chave_central).split('|')[1])}`;
        if (!exatos.has(cv)) exatos.set(cv, []); if (!exatos.get(cv)!.includes(prod)) exatos.get(cv)!.push(prod);
        // vinculo a grade: qualquer tamanho do mesmo codigo e cor e deste produto
        if (v.grade) {
          const kg = `${String(v.chave_central).split('|')[0]}|${andamento.cbPorChave.get(v.chave_central) ?? corBaseDaChave(v.chave_central)}`; if (!porGrade.has(kg)) porGrade.set(kg, []); porGrade.get(kg)!.push(prod);
          // familia por letra (A-Z, cada letra com codigo proprio): pedido de qualquer letra e deste produto
          const kl = chaveFamiliaLetra(v.descricao_central, String(v.chave_central).split('|')[1]); if (kl) { if (!porGrade.has(kl)) porGrade.set(kl, []); if (!porGrade.get(kl)!.includes(prod)) porGrade.get(kl)!.push(prod); }
          // letras como variacao do mesmo codigo (A, B, ... Z): pedido de qualquer letra
          if (/^[A-Z]( |$)/.test(String(v.chave_central).split('|')[1] ?? '')) { const kc = `${String(v.chave_central).split('|')[0]}|*`; if (!porGrade.has(kc)) porGrade.set(kc, []); if (!porGrade.get(kc)!.includes(prod)) porGrade.get(kc)!.push(prod); }
        }
      }
    }
    for (const it of itens.values()) {
      const v = vl.get(it.cod);
      const kl = chaveFamiliaLetra(it.descricao, String(it.chave).split('|')[1]);
      const varIt = String(it.chave).split('|')[1] ?? '';
      const ex = exatos.get(it.chave) ?? exatos.get(`CV:${codVar(it.cod, varIt)}`) ?? (/^[A-Z]( |$)/.test(varIt) ? porGrade.get(`${String(it.chave).split('|')[0]}|*`) : undefined) ?? porGrade.get(`${String(it.chave).split('|')[0]}|${andamento.cbPorChave.get(it.chave) ?? corBaseDaChave(it.chave)}`) ?? (kl ? porGrade.get(kl) : undefined);
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
        if (cands.length) {
          revisao.push({
            codigoCentral: it.codigoCentral, descricaoCentral: it.descricao, quantidade: it.qtd, pedidos: it.pedidos.slice(0, 3),
            candidatos: cands.map((c) => ({ produtoId: venda.get(c.id).produtoId, descricao: venda.get(c.id).descricao, codigoSistema: venda.get(c.id).codigoSistema, similaridade: Math.round(c.sc * 100) / 100 })),
          });
        }
      }
    }
    revisao.sort((a, b) => b.quantidade - a.quantidade);

    const linhas: any[] = [];
    for (const [k, agg] of venda) {
      const vel = agg.qtd / diasHistorico;
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
      distribuirGrade: !!(m as any).grade && !!itensDaGrade(idx, esc),
      tipoGrade: itensDaGrade(idx, esc)?.tipo ?? null,
      // grade: familia por letra (A-Z) ou todas as variacoes (cores/tamanhos) do mesmo codigo e fornecedor
      grade: (() => {
        const fam = itensDaGrade(idx, esc);
        if (fam?.tipo === 'letra') return fam.itens.map((x: any) => ({ ...resumoItemCentral(x), rotuloGrade: `Letra ${letraDoItem(x)}` }));
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
    return { ok: true, id: data.id, valor };
  }

  if (acao === 'status') {
    const novo = String(body.status ?? '');
    if (!['descartado', 'lancado', 'aprovado'].includes(novo) || !body.id) throw new Error('Informe id e status (aprovado, lancado ou descartado).');
    const patch: any = { status: novo };
    if (novo === 'lancado') { patch.lancado_em = new Date().toISOString(); patch.codigo_pedido_central = body.codigoPedidoCentral ? Number(body.codigoPedidoCentral) : null; }
    const { error } = await s.from('pedidos_sugeridos').update(patch).eq('id', body.id);
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
    let saidas: any[] = [], reps: any[] = [], novosClientes: any[] = [];
    let erroCadastros: string | null = null;
    try {
      [, reps] = await Promise.all([
        buscarSaidasParalelo(apiBase, token, dIni!, dFim!, (sd) => { if (ehVenda(sd)) saidas.push(compactarSaida(sd)); }),
        fetchAllPages(`${apiBase}/representantes`, token).catch(() => []),
      ]);
      try { novosClientes = await fetchAllPages(`${apiBase}/terceiros?filtroData=dataCriacao&desde=${desde.replace(/-/g, '/')}&ate=${ate.replace(/-/g, '/')}`, token); }
      catch (e) { erroCadastros = e instanceof Error ? e.message : String(e); }
    } catch (e) { return { nomeLoja, erro: e instanceof Error ? e.message : String(e), vendedores: [] }; }
    const repInfo = new Map<string, any>(reps.map((r: any) => [String(r.id), r]));

    type Acc = { id: string; atend: Set<string>; atend1: number; atend1Barata: number; pecas: number; fat: number; desc: number; pecasBaratas: number; fatBarato: number; baratasSozinhas: number; baratasAcrescimo: number; dias: Set<string>; atendCliente: Set<string> };
    const acc = new Map<string, Acc>();
    const loja = { atend: 0, pecas: 0, fat: 0, desc: 0, pecasBaratas: 0, fatBarato: 0, atendCliente: 0, atend1Barata: 0, baratasSozinhas: 0, baratasAcrescimo: 0, baratasSoBaratas: 0 };
    const entidadesLoja = new Set<string>();
    const pendente1Barata: string[] = [];
    // pecas abaixo do preco-limite, por produto (quais sao e quem vende)
    const baratos = new Map<string, { produtoId: any; descricao: string; codigoSistema: string | null; qtd: number; fat: number; vend: Map<string, number>; sozinha: number; acrescimo: number; soBaratas: number }>();
    // primeira venda de cada cliente no periodo -> vendedor principal dessa venda
    const primeiraVenda = new Map<string, { data: number; vendedor: string }>();
    const parseData = (x: unknown) => { const m = String(x ?? '').match(/(\d{2})[-/](\d{2})[-/](\d{4})(?:\s+(\d{2}):(\d{2}))?/); return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0)) : 0; };
    for (const sd of saidas) {
      if (!ehVenda(sd)) continue;
      const idAt = String(sd.id ?? sd.numeroDocumento ?? Math.random());
      const dia = String(sd.data ?? sd.dataSaida ?? sd.dataEmissao ?? '').slice(0, 10);
      const porVend = new Map<string, number>(); // pecas por vendedor neste atendimento
      const valPorVend = new Map<string, number>();
      if (sd.entidade?.id != null) entidadesLoja.add(String(sd.entidade.id));
      const comCliente = clienteIdentificado(sd.terceiro);
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
        const a = acc.get(vid) ?? { id: vid, atend: new Set(), atend1: 0, atend1Barata: 0, pecas: 0, fat: 0, desc: 0, pecasBaratas: 0, fatBarato: 0, baratasSozinhas: 0, baratasAcrescimo: 0, dias: new Set(), atendCliente: new Set() };
        a.atend.add(idAt); a.pecas += q; a.fat += v; a.desc += d; if (dia) a.dias.add(dia);
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
        loja.atend++;
        if (comCliente) loja.atendCliente++;
        const tid = sd.terceiro?.id != null ? String(sd.terceiro.id) : null;
        if (tid) {
          const quando = parseData(sd.data ?? sd.dataSaida ?? sd.dataEmissao);
          const principal = [...valPorVend.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'sem';
          const atual = primeiraVenda.get(tid);
          if (!atual || quando < atual.data) primeiraVenda.set(tid, { data: quando, vendedor: principal });
        }
      }
      for (const [vid, q] of porVend) if (q <= 1) acc.get(vid)!.atend1++;
    }
    for (const v0 of pendente1Barata) { const a0 = acc.get(v0); if (a0) a0.atend1Barata++; }
    // ---- Cadastros novos no periodo (so os criados nesta loja, quando a VarejOnline informa) ----
    const cadPorVend = new Map<string, { novos: number; completos: number; falta: Record<string, number> }>();
    const incompletos: any[] = [];
    const cadLoja = { novos: 0, completos: 0, semVenda: 0, falta: { 'nome completo': 0, telefone: 0, CPF: 0, CEP: 0 } as Record<string, number> };
    for (const t of novosClientes) {
      if (t.excluido) continue;
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
    const paLoja = loja.atend ? loja.pecas / loja.atend : 0;
    const ticketLoja = loja.atend ? loja.fat / loja.atend : 0;
    const vendedores = [...acc.values()].map((a) => {
      const r = repInfo.get(a.id);
      const at = a.atend.size;
      const pa = at ? a.pecas / at : 0, ticket = at ? a.fat / at : 0;
      const pctBaratas = a.pecas ? a.pecasBaratas / a.pecas * 100 : 0;
      const pct1 = at ? a.atend1 / at * 100 : 0;
      const idxPA = paLoja ? pa / paLoja : null, idxTicket = ticketLoja ? ticket / ticketLoja : null;
      // Perfil indicativo (comparado com a propria loja). Precisa de volume minimo para nao julgar por poucos atendimentos.
      let perfil = 'sem_volume';
      if (a.id === 'sem') perfil = 'sem_vendedor';
      else if (at >= 15 && idxPA != null && idxTicket != null) {
        if (idxPA < 0.8 && idxTicket < 0.85 && pct1 >= 50) perfil = 'tirador_pedido';
        else if (idxPA >= 1.1 && idxTicket >= 1.05) perfil = 'destaque';
        else if (idxPA < 0.9 || idxTicket < 0.9) perfil = 'atencao';
        else perfil = 'na_media';
      }
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
      };
    }).sort((x, y) => y.faturamento - x.faturamento);
    const pctLoja = loja.pecas ? loja.pecasBaratas / loja.pecas * 100 : 0;
    const nomeVend = (id: string) => id === 'sem_venda' ? 'Sem venda no período' : id === 'sem' ? 'Sem vendedor informado' : (repInfo.get(id)?.nome ?? `Vendedor ${id}`);
    return {
      nomeLoja,
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
      },
      vendedores,
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

function indexarCatalogo(cat: any) {
  const porCodigo = new Map<string, any[]>(), porDesc = new Map<string, any[]>(), porChave = new Map<string, any>(), porFamilia = new Map<string, any[]>();
  for (const it of cat.itens) {
    porChave.set(it.chave, it);
    const kf = familiaDoItem(it); if (kf) { if (!porFamilia.has(kf)) porFamilia.set(kf, []); porFamilia.get(kf)!.push(it); }
    const c = codNorm(it.codigo); if (c) { if (!porCodigo.has(c)) porCodigo.set(c, []); porCodigo.get(c)!.push(it); }
    for (const desc of it.descricoes?.length ? it.descricoes : [it.descricao]) {
      for (const d of [limpa(desc), limpa(`${desc} ${it.variacao}`)]) { if (!d) continue; if (!porDesc.has(d)) porDesc.set(d, []); if (!porDesc.get(d)!.includes(it)) porDesc.get(d)!.push(it); }
    }
    if (it.referencia) { const rf = codNorm(it.referencia); if (!porCodigo.has(rf)) porCodigo.set(rf, []); if (!porCodigo.get(rf)!.includes(it)) porCodigo.get(rf)!.push(it); }
  }
  return { porCodigo, porDesc, porChave, porFamilia, itens: cat.itens };
}

// Vinculos da propria loja (cada loja tem sua conta na VarejOnline e o id do produto pode coincidir entre contas).
async function carregarVinculosLoja(loja: string) {
  const novos = new Map<string, any>(), antigos = new Map<string, string>();
  let tabelaNova = true;
  let r1: any = await sb().from(TABELA_VINCULOS).select('produto_chave, produto_id, chave_central, codigo_central, variacao, ignorar, grade, motivo, loja_origem, atualizado_por, atualizado_em');
  // antes de rodar o SQL da grade a coluna nao existe: le sem ela
  if (r1.error && /grade/i.test(r1.error.message)) r1 = await sb().from(TABELA_VINCULOS).select('produto_chave, produto_id, chave_central, codigo_central, variacao, ignorar, motivo, loja_origem, atualizado_por, atualizado_em');
  if (r1.error) tabelaNova = false; else for (const v of r1.data ?? []) novos.set(String(v.produto_chave), v);
  // vinculos antigos (por codigo da Central) continuam como reserva, so da propria loja
  const r2 = await sb().from('pedidos_vinculos').select('loja, codigo_central, produto_id, ignorar').eq('loja', loja);
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
    if (it) return { via: 'vínculo', item: it, variacaoIncerta: false, grade: !!vn.grade, alternativas: (idx.porCodigo.get(codNorm(it.codigo)) ?? []).filter((x: any) => x !== it).slice(0, 5) };
    // item vinculado sumiu do catalogo (sem pedidos no periodo): cai para as outras regras, avisando
  }
  let cands: any[] = [], via = '';
  const vc = vinc.antigos.get(pid);
  if (vc && idx.porCodigo.has(vc)) { cands = idx.porCodigo.get(vc)!; via = 'vínculo (código)'; }
  for (const cod of [r.codigoSistema, r.codigoInterno]) {
    if (!cands.length && cod && idx.porCodigo.has(codNorm(cod))) { cands = idx.porCodigo.get(codNorm(cod))!; via = 'código'; }
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
function itensDaGrade(idx: ReturnType<typeof indexarCatalogo>, it: any): { tipo: 'tamanho' | 'letra'; itens: any[]; rotulos: string[] } | null {
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
async function aquecerCaches(body: any) {
  const t0 = Date.now(), limite = 90_000;
  const apiBase = Deno.env.get('VAREJONLINE_API_BASE');
  if (!apiBase) throw new Error('VAREJONLINE_API_BASE não configurado.');
  const dias = Math.min(400, Math.max(7, Number(body.dias ?? 120)));
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
        const ok = await saidasComCache({ sb, buscarPaginas: fetchAllPages, apiBase, token: lojasTokens[nome], loja: nome, dIni: ini, dFim: fim, onSaida: () => {}, janelaDias: 15, conc: 3, prazo });
        (ok ? prontas : pendentes).push(nome);
      } catch (e) { erros.push({ loja: nome, erro: e instanceof Error ? e.message : String(e) }); }
    }
  }));
  let central: any = null;
  if (Date.now() - t0 < 120_000) { try { const r = await sincronizarCentralDias(180, Math.max(5_000, 140_000 - (Date.now() - t0))); central = { completo: !r.pendentes, pendentes: r.pendentes ?? 0, falhas: r.falhas }; } catch (e) { central = { erro: String(e) }; } }
  return { completo: !pendentes.length && !!central?.completo, dias, prontas, pendentes, erros, central, ms: Date.now() - t0 };
}

// ---- Tela de vinculos ----
let cacheCatalogo: { quando: number; idx: ReturnType<typeof indexarCatalogo>; cat: any } | null = null;
async function catalogoIndexado() {
  if (cacheCatalogo && cacheCentral && cacheCatalogo.quando === cacheCentral.quando && cacheFixo) return cacheCatalogo;
  const base = await buscarPedidosCentral(DIAS_CATALOGO);
  if (base.erro && !base.lista.length) throw new Error(base.erro);
  const cat = montarCatalogo(base.lista);
  await gravarItensDosPedidos(cat).catch(() => {});
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
    return { loja: lj, dias, produtos: [...agg.values()].map((a) => [a.produtoId, a.descricao, a.codigoSistema, r2(a.qtd / dias)]) };
  }
  const loja = String(body.loja ?? '').trim();
  const s = sb();

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
    const lista: any[] = acao === 'salvar' ? [body] : (Array.isArray(body.itens) ? body.itens : []);
    if (!lista.length || lista.length > 1000) throw new Error('Envie de 1 a 1000 vinculos.');
    const { idx } = await catalogoIndexado();
    const linhas = lista.map((v) => {
      if (v.produtoId == null || !v.chave) throw new Error('Cada vinculo precisa de produtoId e chave do item da Central.');
      const it = idx.porChave.get(String(v.chave));
      if (!it) throw new Error(`Item da Central "${v.chave}" nao existe no catalogo.`);
      return { produto_chave: chaveProduto(v), produto_id: String(v.produtoId), codigo_sistema: v.codigoSistema ? String(v.codigoSistema) : null, descricao_produto: v.descricaoLoja ?? null,
        chave_central: it.chave, codigo_central: it.codigo, variacao: it.variacao || null, fornecedor_id: it.fornecedorId, descricao_central: it.descricao,
        ignorar: false, motivo: null, loja_origem: loja, atualizado_por: quem, atualizado_em: new Date().toISOString(),
        ...(v.grade === true ? { grade: !!itensDaGrade(idx, it) } : (v.grade === false ? { grade: false } : {})) };
    });
    if (linhas.some((l: any) => l.grade === true)) {
      const t = await s.from(TABELA_VINCULOS).select('grade').limit(1);
      if (t.error) throw new Error('Para vincular a grade, rode antes o SQL 20261105000001_vinculos_grade.sql no Supabase.');
    }
    for (let i = 0; i < linhas.length; i += 200) {
      const { error } = await s.from(TABELA_VINCULOS).upsert(linhas.slice(i, i + 200), { onConflict: 'produto_chave' });
      if (error) throw new Error(`Erro ao salvar vinculos: ${error.message}`);
    }
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
    if (!chave || req.headers.get('x-aquecer-chave') !== chave) return resp({ error: 'Chave de aquecimento inválida.' }, 401);
    try { return resp(await aquecerCaches(await req.json().catch(() => ({})))); } catch (e) { return resp({ error: e instanceof Error ? e.message : String(e) }, 500); }
  }
  let a: Acesso;
  try { a = await obterAcesso(req); } catch (e) { if (e instanceof ErroAcesso) return respostaErroAcesso(e, cors); throw e; }
  if (req.method === 'GET') return resp({ ok: true, modulos: ['recorrente', 'vinculo', 'diagnosticoCentral', 'catalogoCentral', 'pedidoSugerido', 'vendedores', 'compatibilidade', 'lojaEditar', 'sincronizarCentral', 'vinculos', 'usuarios'] });
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
    if (modulo === 'sincronizarCentral') return resp(await moduloSincronizarCentral(body));
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
      return resp(await moduloRecorrente(apiBase, await getLojasTokens(), body));
    }
    return resp({ error: `Modulo desconhecido: "${modulo}".` }, 400);
  } catch (e) {
    if (e instanceof ErroAcesso) return respostaErroAcesso(e, cors);
    if (e instanceof ConfirmacaoNecessaria) return resp({ error: e.message, confirmar: e.tipo }, 409);
    const msg = e instanceof Error ? e.message : String(e);
    return resp({ error: msg.replace(/token=[^&\s)]+/g, 'token=***') }, 500);
  }
});
