// Supabase Edge Function: sss-mastermind
// Painel único com 7 módulos, consultando a API da VarejOnline (um token por loja) e o próprio
// banco Postgres do Supabase (metas, benchmark e cadastro de lojas):
//   - recorrente : recomendação de compra recorrente (histórico recente + estoque + % crescimento)
//   - sazonal    : mais vendidos por período/ano (ex: Out-Dez de anos anteriores)
//   - estoque    : alertas de estoque baixo / muito alto, por dias de cobertura
//   - financeiro : DRE por competência (receita, CMV, despesas por categoria) + bandeiras + metas
//   - metas      : salvar/listar a meta de faturamento de cada loja, por mês/ano
//   - benchmark  : compara lojas normalizando por população local e tempo de abertura
//   - lojas      : cadastro de unidades (nome, CNPJ, token) — pelo próprio painel, sem terminal
//
// As lojas (nome/CNPJ/token) ficam na tabela lojas_config (ver lojas_config.sql), não mais num
// secret — assim dá pra cadastrar loja nova direto no painel, sem redeploy.
//
// Variáveis de ambiente (supabase secrets set):
//   VAREJONLINE_API_BASE  -> https://integrador.varejonline.com.br/apps/api
//   APP_PASSCODE          -> (opcional, recomendado) senha exigida no header x-app-passcode
//   ALLOWED_ORIGIN        -> (opcional) restringe CORS a um domínio específico (ex: seu Netlify).
//                            Sem esse secret, aceita chamadas de qualquer origem (menos seguro).
//
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetados automaticamente pelo Supabase em toda
// Edge Function do mesmo projeto — não precisa configurar esses dois.
//
// Todas as chamadas são POST com { "modulo": "recorrente"|"sazonal"|"estoque"|"financeiro"|"metas"|"benchmark"|"lojas", ...params }.
// GET (sem body) lista as lojas ativas configuradas.
//
// Limites do Supabase (erro 546 = tempo/memória): o painel consulta UMA loja por chamada
// (lojas: [nome]) e junta os resultados no navegador. O benchmark tem ainda a ação
// "agrupar", que recebe as métricas de todas as lojas e calcula faixas e grupos.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";


// ALLOWED_ORIGIN aceita varios enderecos separados por virgula (ex.: GitHub Pages + servidor Node).
// localhost sempre pode (painel rodando no computador com node server.js).
const ORIGENS_PERMITIDAS = String(Deno.env.get('ALLOWED_ORIGIN') || '*').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
function origemPermitida(req: Request): string {
  if (ORIGENS_PERMITIDAS.includes('*')) return '*';
  const o = (req.headers.get('origin') ?? '').replace(/\/+$/, '');
  if (o && (ORIGENS_PERMITIDAS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o))) return o;
  return ORIGENS_PERMITIDAS[0];
}
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": ORIGENS_PERMITIDAS.includes("*") ? "*" : ORIGENS_PERMITIDAS[0],
  "Vary": "Origin",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-passcode",
};

function getSupabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key);
}
const clienteAcesso = getSupabaseAdmin;

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


// ---------- Utilidades comuns ----------


// As lojas (nome, CNPJ, token) ficam guardadas na tabela lojas_config (ver lojas_config.sql),
// não mais só no secret VAREJONLINE_LOJAS — assim dá pra cadastrar loja nova pelo próprio painel,
// sem precisar mexer no terminal. O secret VAREJONLINE_LOJAS antigo não é mais usado.
async function getLojasTokens(): Promise<Record<string, string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("lojas_config")
    .select("nome, token")
    .eq("ativo", true);
  if (error) throw new Error(`Erro ao ler lojas_config: ${error.message}`);
  const mapa: Record<string, string> = {};
  for (const row of data ?? []) mapa[row.nome] = row.token;
  return mapa;
}

function formatDateBR(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

// Esconde o token da loja em mensagens de erro (elas chegam ao painel e aos logs).
const semToken = (s: unknown) => String(s).replace(/token=[^&\s)"']+/g, "token=***");

// "AAAA-MM-DD" do painel -> data LOCAL (new Date("2026-11-01") seria meia-noite UTC = dia 31 no Brasil).
function dataDoPainel(s: unknown): Date | null {
  const m = String(s ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
// Datas da VarejOnline: "DD-MM-AAAA", "DD/MM/AAAA" (com ou sem hora) ou ISO "AAAA-MM-DD".
// (new Date("05-11-2026") no JavaScript vira 11 de MAIO — por isso a leitura é explícita.)
function dataVarejo(s: unknown): Date | null {
  const t = String(s ?? "").trim();
  let m = t.match(/^(\d{2})[-/](\d{2})[-/](\d{4})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  return null;
}

// A API entrega no máximo ~300 itens por página, mesmo pedindo 1000: avança pelo tamanho real
// e só para em página vazia (antes parava na 1ª página, porque 300 < 1000).
// onPage processa cada página e a descarta, economizando memória.
async function fetchAllPages(url: string, token: string, onPage?: (items: any[]) => void): Promise<any[]> {
  const results: any[] = [];
  let inicio = 0;
  let ultima = "";
  for (let n = 0; n < 400; n++) {
    const sep = url.includes("?") ? "&" : "?";
    const pageUrl = `${url}${sep}inicio=${inicio}&quantidade=1000&token=${token}`;
    const resp = await fetch(pageUrl);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(semToken(`Erro ao consultar ${url.split("?")[0]} (${resp.status}): ${text.slice(0, 300)}`));
    }
    const page = await resp.json();
    const items = Array.isArray(page) ? page : (page.items ?? page.dados ?? []);
    if (!items.length) break;
    const assinatura = JSON.stringify(items[0]).slice(0, 300);
    if (assinatura === ultima) break; // a API devolveu a mesma página de novo
    ultima = assinatura;
    if (onPage) onPage(items); else results.push(...items);
    inicio += items.length;
  }
  return results;
}

// Lê as saídas (vendas) em janelas de até 30 dias, 4 em paralelo — a paginação é sequencial e lenta
// em períodos longos. Janelas se sobrepõem em 1 dia; vendas repetidas são descartadas pelo id.
async function buscarSaidas(apiBase: string, token: string, dIni: Date, dFim: Date, onSaida: (s: any) => void, janelaDias = 30, conc = 4) {
  const janelas: [Date, Date][] = [];
  for (let a = new Date(dIni); a <= dFim; a = new Date(a.getTime() + janelaDias * 86400000)) {
    janelas.push([a, new Date(Math.min(dFim.getTime(), a.getTime() + janelaDias * 86400000))]);
  }
  const vistos = new Set<string>();
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, janelas.length) }, async () => {
    while (i < janelas.length) {
      const [a, b] = janelas[i++];
      await fetchAllPages(`${apiBase}/saidas?desde=${formatDateBR(a)}&ate=${formatDateBR(b)}`, token, (pg) => {
        for (const sd of pg) {
          const k = sd.id != null ? `i${sd.id}` : `d${sd.numeroDocumento}|${sd.data ?? ""}|${sd.entidade?.id ?? ""}`;
          if (vistos.has(k)) continue;
          vistos.add(k);
          onSaida(sd);
        }
      });
    }
  }));
}
const ehPedidoVenda = (s: any) => !s.cancelado && (!s.tipoSaida || s.tipoSaida === "PEDIDO_VENDA");

// Estoque da UNIDADE: se o token enxerga mais de uma unidade (loja + depósito), usa só a(s) que
// venderam; se a API devolver saldo vazio, tenta de novo informando a unidade.
async function saldosDaUnidade(apiBase: string, token: string, entidadesVenda: Set<string>) {
  const enxuto = (sl: any) => ({ quantidade: sl.quantidade, entidade: sl.entidade ? { id: sl.entidade.id, nome: sl.entidade.nome } : undefined,
    produto: sl.produto ? { id: sl.produto.id, descricao: sl.produto.descricao, codigoSistema: sl.produto.codigoSistema } : undefined });
  let saldos: any[] = [];
  await fetchAllPages(`${apiBase}/saldos-mercadorias`, token, (pg) => { for (const sl of pg) saldos.push(enxuto(sl)); });
  let consultaComEntidade = false;
  if (!saldos.length && entidadesVenda.size) {
    await fetchAllPages(`${apiBase}/saldos-mercadorias?entidades=${[...entidadesVenda].join(",")}`, token, (pg) => { for (const sl of pg) saldos.push(enxuto(sl)); });
    consultaComEntidade = true;
  }
  const unidades = new Set(saldos.map((sl) => String(sl.entidade?.id ?? "?")));
  let filtrouUnidade = false;
  if (unidades.size > 1 && [...entidadesVenda].some((e) => unidades.has(e))) {
    saldos = saldos.filter((sl) => entidadesVenda.has(String(sl.entidade?.id)));
    filtrouUnidade = true;
  }
  return { saldos, consultaComEntidade, filtrouUnidade, unidadesNoSaldo: unidades.size };
}

function lojasAlvo(lojasTokens: Record<string, string>, filtro: string[] | null): string[] {
  return filtro && filtro.length ? filtro.filter((n) => lojasTokens[n]) : Object.keys(lojasTokens);
}

// ---------- Módulo: recomendação de compra RECORRENTE ----------

async function moduloRecorrente(apiBase: string, lojasTokens: Record<string, string>, body: any) {
  const diasHistorico = Number(body.diasHistorico ?? 90);
  const diasPeriodoAlvo = Number(body.diasPeriodoAlvo ?? 30);
  const percentCrescimento = Number(body.percentCrescimento ?? 0);
  const diasSeguranca = Number(body.diasSeguranca ?? 7);
  const nomesLojas = lojasAlvo(lojasTokens, body.lojas ?? null);

  const hoje = new Date();
  const inicioHistorico = new Date(hoje);
  inicioHistorico.setDate(inicioHistorico.getDate() - diasHistorico);
  const desde = formatDateBR(inicioHistorico);
  const ate = formatDateBR(hoje);
  const fatorCrescimento = 1 + percentCrescimento / 100;

  const lojasResultado: any[] = [];

  for (const nomeLoja of nomesLojas) {
    const token = lojasTokens[nomeLoja];
    let saidas: any[] = [];
    let saldos: any[] = [];
    try {
      const ents = new Set<string>();
      await buscarSaidas(apiBase, token, inicioHistorico, hoje, (sd) => { if (sd.entidade?.id != null) ents.add(String(sd.entidade.id)); if (ehPedidoVenda(sd)) saidas.push(sd); });
      saldos = (await saldosDaUnidade(apiBase, token, ents)).saldos;
    } catch (e) {
      lojasResultado.push({ nomeLoja, erro: semToken(e), totalProdutosAnalisados: 0, valorTotalEstimadoCompra: 0, recomendacoes: [] });
      continue;
    }

    type Agg = { produtoId: number; descricao: string; codigoSistema: string; qtd: number; valor: number; custo: number };
    const vendaProduto = new Map<string, Agg>();

    for (const saida of saidas) {
      if (saida.cancelado) continue;
      if (saida.tipoSaida && saida.tipoSaida !== "PEDIDO_VENDA") continue;
      for (const item of saida.mercadorias ?? []) {
        const p = item.produto;
        if (!p) continue;
        const key = String(p.id);
        const cur = vendaProduto.get(key) ?? { produtoId: p.id, descricao: p.descricao, codigoSistema: p.codigoSistema, qtd: 0, valor: 0, custo: 0 };
        cur.qtd += Number(item.quantidade ?? 0);
        cur.valor += Number(item.valorTotal ?? 0);
        cur.custo += Number(item.valorCusto ?? 0);
        vendaProduto.set(key, cur);
      }
    }

    const estoqueProduto = new Map<string, number>();
    for (const s of saldos) {
      const id = s.produto?.id;
      if (id == null) continue;
      estoqueProduto.set(String(id), (estoqueProduto.get(String(id)) ?? 0) + Number(s.quantidade ?? 0));
    }

    const linhas = [];
    for (const [key, agg] of vendaProduto) {
      const velocidadeDiaria = agg.qtd / diasHistorico;
      const demandaProjetada = velocidadeDiaria * diasPeriodoAlvo * fatorCrescimento;
      const estoqueSeguranca = velocidadeDiaria * diasSeguranca * fatorCrescimento;
      const estoqueAtual = estoqueProduto.get(key) ?? 0;
      const qtdRecomendada = Math.max(0, Math.ceil(demandaProjetada + estoqueSeguranca - estoqueAtual));
      const custoMedioUnit = agg.qtd > 0 ? agg.custo / agg.qtd : 0;
      linhas.push({
        produtoId: agg.produtoId,
        descricao: agg.descricao,
        codigoSistema: agg.codigoSistema,
        vendaMediaDiaria: Number(velocidadeDiaria.toFixed(2)),
        estoqueAtual,
        demandaProjetadaPeriodo: Number(demandaProjetada.toFixed(1)),
        qtdRecomendadaCompra: qtdRecomendada,
        valorEstimadoCompra: Number((qtdRecomendada * custoMedioUnit).toFixed(2)),
        riscoRuptura: estoqueAtual < demandaProjetada,
      });
    }
    linhas.sort((a, b) => b.qtdRecomendadaCompra - a.qtdRecomendadaCompra);

    lojasResultado.push({
      nomeLoja,
      totalProdutosAnalisados: linhas.length,
      valorTotalEstimadoCompra: Number(linhas.reduce((s, r) => s + r.valorEstimadoCompra, 0).toFixed(2)),
      recomendacoes: linhas,
    });
  }

  return {
    parametros: { diasHistorico, diasPeriodoAlvo, percentCrescimento, diasSeguranca },
    valorTotalEstimadoCompraRede: Number(lojasResultado.reduce((s, l) => s + (l.valorTotalEstimadoCompra ?? 0), 0).toFixed(2)),
    lojas: lojasResultado.sort((a, b) => a.nomeLoja.localeCompare(b.nomeLoja)),
  };
}

// ---------- Módulo: recomendação SAZONAL (mais vendidos por período/ano) ----------

function periodoDoAno(ano: number, mesInicio: number, mesFim: number) {
  const inicio = new Date(ano, mesInicio - 1, 1);
  const fim = new Date(ano, mesFim, 0);
  return { inicio, fim };
}

async function moduloSazonal(apiBase: string, lojasTokens: Record<string, string>, body: any) {
  const anos: number[] = Array.isArray(body.anos) && body.anos.length ? body.anos : [new Date().getFullYear()];
  const mesInicio = Number(body.mesInicio ?? 10);
  const mesFim = Number(body.mesFim ?? 12);
  const topN = Number(body.topN ?? 30);
  // Quando o painel consulta loja a loja, pede um ranking maior para juntar a rede com precisão.
  const topNRede = Math.max(topN, Number(body.topNRede ?? topN));
  const nomesLojas = lojasAlvo(lojasTokens, body.lojas ?? null);

  type AggProduto = { produtoId: number; descricao: string; codigoSistema: string; qtdVendida: number; valorVendido: number };
  const resultadoPorAno: any[] = [];
  const combinadoTodosAnos = new Map<string, AggProduto>();

  for (const ano of anos) {
    const { inicio, fim } = periodoDoAno(ano, mesInicio, mesFim);
    const desde = formatDateBR(inicio);
    const ate = formatDateBR(fim);

    const redeAgg = new Map<string, AggProduto>();
    const porLoja: any[] = [];

    for (const nomeLoja of nomesLojas) {
      const token = lojasTokens[nomeLoja];
      const saidas: any[] = [];
      try {
        await buscarSaidas(apiBase, token, inicio, fim, (sd) => {
          if (!ehPedidoVenda(sd)) return;
          saidas.push({ mercadorias: (sd.mercadorias ?? []).map((it: any) => ({ produto: it.produto ? { id: it.produto.id, descricao: it.produto.descricao, codigoSistema: it.produto.codigoSistema } : null, quantidade: it.quantidade, valorTotal: it.valorTotal })) });
        });
      } catch (e) {
        porLoja.push({ loja: nomeLoja, topProdutos: [], totalUnidades: 0, totalValor: 0, erro: semToken(e) });
        continue;
      }
      const lojaAgg = new Map<string, AggProduto>();
      for (const saida of saidas) {
        if (saida.cancelado) continue;
        if (saida.tipoSaida && saida.tipoSaida !== "PEDIDO_VENDA") continue;
        for (const item of saida.mercadorias ?? []) {
          const p = item.produto;
          if (!p) continue;
          const key = String(p.id);
          const qtd = Number(item.quantidade ?? 0);
          const valor = Number(item.valorTotal ?? 0);
          for (const [map, target] of [[lojaAgg, key], [redeAgg, key], [combinadoTodosAnos, key]] as const) {
            const cur = map.get(target) ?? { produtoId: p.id, descricao: p.descricao, codigoSistema: p.codigoSistema, qtdVendida: 0, valorVendido: 0 };
            cur.qtdVendida += qtd;
            cur.valorVendido += valor;
            map.set(target, cur);
          }
        }
      }
      const listaLoja = Array.from(lojaAgg.values()).sort((a, b) => b.qtdVendida - a.qtdVendida);
      porLoja.push({
        loja: nomeLoja,
        topProdutos: listaLoja.slice(0, topN),
        totalUnidades: listaLoja.reduce((s, p) => s + p.qtdVendida, 0),
        totalValor: Number(listaLoja.reduce((s, p) => s + p.valorVendido, 0).toFixed(2)),
      });
    }

    const rankingRede = Array.from(redeAgg.values()).sort((a, b) => b.qtdVendida - a.qtdVendida).slice(0, topNRede);
    resultadoPorAno.push({
      ano,
      periodo: { desde, ate },
      topProdutosRede: rankingRede,
      totalUnidadesRede: Array.from(redeAgg.values()).reduce((s, p) => s + p.qtdVendida, 0),
      totalValorRede: Number(Array.from(redeAgg.values()).reduce((s, p) => s + p.valorVendido, 0).toFixed(2)),
      porLoja: porLoja.sort((a, b) => a.loja.localeCompare(b.loja)),
    });
  }

  const rankingCombinado = Array.from(combinadoTodosAnos.values()).sort((a, b) => b.qtdVendida - a.qtdVendida).slice(0, topNRede);

  return {
    parametros: { anos, mesInicio, mesFim, topN },
    porAno: resultadoPorAno,
    topProdutosCombinadoTodosAnos: rankingCombinado,
  };
}

// ---------- Módulo: alertas de ESTOQUE (baixo / muito alto, por dias de cobertura) ----------

async function moduloEstoque(apiBase: string, lojasTokens: Record<string, string>, body: any) {
  const diasHistorico = Number(body.diasHistorico ?? 90);
  const limiteBaixoDias = Number(body.limiteBaixoDias ?? 7);
  const limiteAltoDias = Number(body.limiteAltoDias ?? 90);
  const nomesLojas = lojasAlvo(lojasTokens, body.lojas ?? null);

  const hoje = new Date();
  const inicioHistorico = new Date(hoje);
  inicioHistorico.setDate(inicioHistorico.getDate() - diasHistorico);

  const lojasResultado: any[] = [];

  for (const nomeLoja of nomesLojas) {
    const token = lojasTokens[nomeLoja];
    const vendaProduto = new Map<string, { produtoId: number; descricao: string; codigoSistema: string; qtd: number }>();
    const entidadesVenda = new Set<string>();
    let saldos: any[] = [];
    let diagEstoque: any = null;
    try {
      await buscarSaidas(apiBase, token, inicioHistorico, hoje, (saida) => {
        if (saida.entidade?.id != null) entidadesVenda.add(String(saida.entidade.id));
        if (!ehPedidoVenda(saida)) return;
        for (const item of saida.mercadorias ?? []) {
          const p = item.produto;
          if (!p) continue;
          const key = String(p.id);
          const cur = vendaProduto.get(key) ?? { produtoId: p.id, descricao: p.descricao, codigoSistema: p.codigoSistema, qtd: 0 };
          cur.qtd += Number(item.quantidade ?? 0);
          vendaProduto.set(key, cur);
        }
      });
      const u = await saldosDaUnidade(apiBase, token, entidadesVenda);
      saldos = u.saldos;
      diagEstoque = { linhasSaldo: saldos.length, consultaComEntidade: u.consultaComEntidade, filtrouUnidade: u.filtrouUnidade, unidadesNoSaldo: u.unidadesNoSaldo };
    } catch (e) {
      lojasResultado.push({ nomeLoja, erro: semToken(e), alertasBaixo: [], alertasAlto: [], semMovimento: [] });
      continue;
    }

    const estoqueProduto = new Map<string, { produtoId: number; descricao: string; codigoSistema: string; estoque: number }>();
    for (const s of saldos) {
      const p = s.produto;
      if (!p?.id) continue;
      const key = String(p.id);
      const cur = estoqueProduto.get(key) ?? { produtoId: p.id, descricao: p.descricao, codigoSistema: p.codigoSistema, estoque: 0 };
      cur.estoque += Number(s.quantidade ?? 0);
      estoqueProduto.set(key, cur);
    }

    const alertasBaixo: any[] = [];
    const alertasAlto: any[] = [];
    const semMovimento: any[] = [];

    // Produtos com estoque atual, cruzando com velocidade de venda (0 se não vendeu no período)
    for (const [key, est] of estoqueProduto) {
      const venda = vendaProduto.get(key);
      const velocidadeDiaria = venda ? venda.qtd / diasHistorico : 0;

      if (velocidadeDiaria === 0) {
        if (est.estoque > 0) {
          semMovimento.push({ produtoId: est.produtoId, descricao: est.descricao, codigoSistema: est.codigoSistema, estoqueAtual: est.estoque });
        }
        continue;
      }

      const diasCobertura = est.estoque / velocidadeDiaria;
      const linha = {
        produtoId: est.produtoId,
        descricao: est.descricao,
        codigoSistema: est.codigoSistema,
        estoqueAtual: est.estoque,
        vendaMediaDiaria: Number(velocidadeDiaria.toFixed(2)),
        diasCobertura: Number(diasCobertura.toFixed(1)),
      };
      if (diasCobertura < limiteBaixoDias) alertasBaixo.push(linha);
      else if (diasCobertura > limiteAltoDias) alertasAlto.push(linha);
    }

    alertasBaixo.sort((a, b) => a.diasCobertura - b.diasCobertura);
    alertasAlto.sort((a, b) => b.diasCobertura - a.diasCobertura);
    semMovimento.sort((a, b) => b.estoqueAtual - a.estoqueAtual);

    lojasResultado.push({
      nomeLoja,
      totalAlertasBaixo: alertasBaixo.length,
      totalAlertasAlto: alertasAlto.length,
      totalSemMovimento: semMovimento.length,
      diagEstoque,
      alertasBaixo,
      alertasAlto,
      semMovimento,
    });
  }

  return {
    parametros: { diasHistorico, limiteBaixoDias, limiteAltoDias },
    lojas: lojasResultado.sort((a, b) => a.nomeLoja.localeCompare(b.nomeLoja)),
  };
}

// ---------- Módulo: FINANCEIRO / DRE por competência ----------
//
// DRE por competência, por loja e para a rede toda:
//   Receita Bruta de Vendas   -> soma de /saidas (PEDIDO_VENDA) no período, por data da saída
//   (-) Devoluções            -> soma de /devolucoes no mesmo período (se o endpoint responder;
//                                se falhar, a linha aparece zerada e sinalizada, não trava o DRE)
//   = Receita Líquida
//   (-) CMV                   -> soma de valorCusto das mesmas /saidas
//   = Lucro Bruto
//   (-) Despesas Operacionais -> /contas-pagar do período, agrupadas pela categoria/plano de
//                                contas de cada conta (campo lido com fallback — ver abaixo)
//   = Resultado Operacional
//
// ATENÇÃO nos nomes de campo: confirmado via teste real contra a API que não existe um campo
// "categoria" — a classificação da despesa vem da conta contábil de débito
// (`contaContabilDebito`, ex: "13901 - EMPRESTIMO", ou `classificacoesContabeis[0].contaContabil`
// quando a conta é rateada entre mais de uma classificação). O código extrai só a parte depois do
// código numérico (ex: "EMPRESTIMO"), já que o número é um ID interno do plano de contas, não o
// nome da categoria.
//
// Data de competência: confirmado via teste real que `dataEmissao` é a data do documento/contrato
// original (ex: um empréstimo emitido em 2023 com parcelas até anos depois) — usar essa data faria
// a parcela nunca aparecer no mês em que ela realmente pesa no caixa/resultado. `dataVencimento` é
// a data de cada parcela individual, e é o que usamos como competência de cada lançamento.

function camposCategoria(conta: any): string {
  const bruto =
    conta.classificacoesContabeis?.[0]?.contaContabil ||
    conta.contaContabilDebito ||
    conta.historico ||
    null;
  if (!bruto) return "Sem categoria";
  // Remove um prefixo numérico de código de conta contábil, tipo "13901 - EMPRESTIMO" -> "EMPRESTIMO".
  const semCodigo = String(bruto).replace(/^\s*\d+\s*-\s*/, "").trim();
  return semCodigo || "Sem categoria";
}

function dataCompetenciaConta(conta: any): { data: string | null; campoUsado: string } {
  if (conta.dataVencimento) return { data: conta.dataVencimento, campoUsado: "dataVencimento" };
  if (conta.dataCompetencia) return { data: conta.dataCompetencia, campoUsado: "dataCompetencia" };
  if (conta.dataEmissao) return { data: conta.dataEmissao, campoUsado: "dataEmissao (fallback — pode ser a data do documento original, não da parcela)" };
  return { data: null, campoUsado: "nenhum campo de data encontrado" };
}

async function moduloFinanceiro(apiBase: string, lojasTokens: Record<string, string>, body: any) {
  // Período do DRE: por padrão, o mês corrente inteiro.
  const hoje = new Date();
  const inicioPeriodo = dataDoPainel(body.desde) ?? new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  const fimPeriodo = dataDoPainel(body.ate) ?? new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);
  const desde = formatDateBR(inicioPeriodo);
  const ate = formatDateBR(fimPeriodo);
  // Contas a pagar: busca 6 meses antes para pegar parcelas emitidas antes e que vencem no período;
  // o filtro final é pela data de vencimento de cada parcela.
  const inicioContas = new Date(inicioPeriodo); inicioContas.setMonth(inicioContas.getMonth() - 6);
  const inicioMs = inicioPeriodo.getTime();
  const fimMs = new Date(fimPeriodo.getFullYear(), fimPeriodo.getMonth(), fimPeriodo.getDate(), 23, 59, 59).getTime();

  const nomesLojas = lojasAlvo(lojasTokens, body.lojas ?? null);

  const lojasResultado: any[] = [];
  const bandeirasRede = new Map<string, { bandeira: string; quantidade: number; valor: number }>();
  const categoriasRede = new Map<string, number>();

  for (const nomeLoja of nomesLojas) {
    const token = lojasTokens[nomeLoja];
    let devolucoes: any[] = [];
    let contasPagar: any[] = [];
    let negociacoesCartao: any[] = [];
    const avisos: string[] = [];

    // Receita bruta e CMV, a partir das saídas (competência = data da própria venda).
    let receitaBruta = 0;
    let cmv = 0;
    const outrasSaidas = new Map<string, number>(); // saídas não contadas como venda, por tipo
    try {
      await buscarSaidas(apiBase, token, inicioPeriodo, fimPeriodo, (saida) => {
        if (saida.cancelado) return;
        if (saida.tipoSaida && saida.tipoSaida !== "PEDIDO_VENDA") {
          const v = (saida.mercadorias ?? []).reduce((t: number, it: any) => t + Number(it.valorTotal ?? 0), 0);
          if (v) outrasSaidas.set(saida.tipoSaida, (outrasSaidas.get(saida.tipoSaida) ?? 0) + v);
          return;
        }
        for (const item of saida.mercadorias ?? []) {
          receitaBruta += Number(item.valorTotal ?? 0);
          cmv += Number(item.valorCusto ?? 0);
        }
      });
    } catch (e) {
      lojasResultado.push({ nomeLoja, erro: semToken(e) });
      continue;
    }
    for (const [tipo, v] of outrasSaidas) {
      if (/VENDA/i.test(tipo) && !/DEVOLU/i.test(tipo)) avisos.push(`R$ ${v.toFixed(2)} em saídas do tipo ${tipo} não entraram na receita (só PEDIDO_VENDA é contado).`);
    }
    try {
      devolucoes = await fetchAllPages(`${apiBase}/devolucoes?desde=${desde}&ate=${ate}`, token);
    } catch {
      avisos.push("Não foi possível consultar /devolucoes neste período — receita bruta pode estar sem o abatimento de devoluções.");
    }
    try {
      contasPagar = await fetchAllPages(`${apiBase}/contas-pagar?desde=${formatDateBR(inicioContas)}&ate=${ate}`, token);
    } catch {
      avisos.push("Não foi possível consultar /contas-pagar — despesas operacionais ficaram zeradas.");
    }
    try {
      negociacoesCartao = await fetchAllPages(`${apiBase}/negociacoes-cartao?desde=${desde}&ate=${ate}`, token);
    } catch {
      avisos.push("Não foi possível consultar /negociacoes-cartao — bandeiras ficaram zeradas.");
    }

    let totalDevolucoes = 0;
    for (const dev of devolucoes) {
      totalDevolucoes += Number(dev.valor ?? dev.valorTotal ?? 0);
    }

    const receitaLiquida = receitaBruta - totalDevolucoes;
    const lucroBruto = receitaLiquida - cmv;

    // Despesas operacionais, agrupadas por categoria — filtradas pela data de competência da
    // própria conta (não a janela de vencimento), já que /contas-pagar não tem filtro nativo
    // conhecido por competência: buscamos uma janela um pouco mais ampla e filtramos aqui.
    let camposDataAmostra = "";
    let semDataLegivel = 0;
    const despesasPorCategoria = new Map<string, number>();
    for (const conta of contasPagar) {
      if (conta.cancelado) continue;
      const { data, campoUsado } = dataCompetenciaConta(conta);
      if (!camposDataAmostra) camposDataAmostra = campoUsado;
      if (data) {
        const d = dataVarejo(data);
        if (!d) semDataLegivel++;
        else if (d.getTime() < inicioMs || d.getTime() > fimMs) continue; // fora do período pedido
      }
      const categoria = camposCategoria(conta);
      const valor = Number(conta.valor ?? conta.valorTotal ?? 0);
      despesasPorCategoria.set(categoria, (despesasPorCategoria.get(categoria) ?? 0) + valor);
      categoriasRede.set(categoria, (categoriasRede.get(categoria) ?? 0) + valor);
    }

    if (semDataLegivel) avisos.push(`${semDataLegivel} conta(s) a pagar com data em formato não reconhecido entraram no período sem filtro.`);
    const listaDespesas = Array.from(despesasPorCategoria.entries())
      .map(([categoria, valor]) => ({ categoria, valor: Number(valor.toFixed(2)) }))
      .sort((a, b) => b.valor - a.valor);
    const totalDespesasOperacionais = Number(listaDespesas.reduce((s, d) => s + d.valor, 0).toFixed(2));
    const resultadoOperacional = Number((lucroBruto - totalDespesasOperacionais).toFixed(2));

    // Bandeiras de cartão no período (informativo, não entra no cálculo do DRE em si).
    const bandeirasLoja = new Map<string, { bandeira: string; quantidade: number; valor: number }>();
    for (const neg of negociacoesCartao) {
      const bandeira = neg.bandeira || neg.cartaoBandeira || "NAO_INFORMADA";
      const valor = Number(neg.valor ?? neg.valorLiquido ?? neg.valorBruto ?? 0);
      const curLoja = bandeirasLoja.get(bandeira) ?? { bandeira, quantidade: 0, valor: 0 };
      curLoja.quantidade += 1;
      curLoja.valor += valor;
      bandeirasLoja.set(bandeira, curLoja);
      const curRede = bandeirasRede.get(bandeira) ?? { bandeira, quantidade: 0, valor: 0 };
      curRede.quantidade += 1;
      curRede.valor += valor;
      bandeirasRede.set(bandeira, curRede);
    }

    const totalBandeirasLoja = Array.from(bandeirasLoja.values()).reduce((s, b) => s + b.valor, 0);
    const porBandeiraLojaComPercent = Array.from(bandeirasLoja.values())
      .map((b) => ({ ...b, valor: Number(b.valor.toFixed(2)), percentual: totalBandeirasLoja ? Number(((b.valor / totalBandeirasLoja) * 100).toFixed(1)) : 0 }))
      .sort((a, b) => b.percentual - a.percentual);

    lojasResultado.push({
      nomeLoja,
      avisos,
      campoDataUsadoDespesas: camposDataAmostra || "sem contas a pagar no período",
      dre: {
        receitaBruta: Number(receitaBruta.toFixed(2)),
        devolucoes: Number(totalDevolucoes.toFixed(2)),
        receitaLiquida: Number(receitaLiquida.toFixed(2)),
        cmv: Number(cmv.toFixed(2)),
        lucroBruto: Number(lucroBruto.toFixed(2)),
        despesasPorCategoria: listaDespesas,
        totalDespesasOperacionais,
        resultadoOperacional,
        margemBrutaPercent: receitaLiquida ? Number(((lucroBruto / receitaLiquida) * 100).toFixed(1)) : 0,
        margemOperacionalPercent: receitaLiquida ? Number(((resultadoOperacional / receitaLiquida) * 100).toFixed(1)) : 0,
      },
      porBandeira: porBandeiraLojaComPercent,
    });
  }

  const somaValida = (campo: string) =>
    Number(lojasResultado.reduce((s, l) => s + (l.dre?.[campo] ?? 0), 0).toFixed(2));

  const totalBandeirasRede = Array.from(bandeirasRede.values()).reduce((s, b) => s + b.valor, 0);
  const porBandeiraRedeComPercent = Array.from(bandeirasRede.values())
    .map((b) => ({ ...b, valor: Number(b.valor.toFixed(2)), percentual: totalBandeirasRede ? Number(((b.valor / totalBandeirasRede) * 100).toFixed(1)) : 0 }))
    .sort((a, b) => b.percentual - a.percentual);

  return {
    parametros: { periodo: { desde, ate } },
    lojas: lojasResultado.sort((a, b) => a.nomeLoja.localeCompare(b.nomeLoja)),
    redeConsolidado: {
      receitaBruta: somaValida("receitaBruta"),
      devolucoes: somaValida("devolucoes"),
      receitaLiquida: somaValida("receitaLiquida"),
      cmv: somaValida("cmv"),
      lucroBruto: somaValida("lucroBruto"),
      totalDespesasOperacionais: somaValida("totalDespesasOperacionais"),
      resultadoOperacional: somaValida("resultadoOperacional"),
      margemBrutaPercent: somaValida("receitaLiquida") ? Number(((somaValida("lucroBruto") / somaValida("receitaLiquida")) * 100).toFixed(1)) : 0,
      margemOperacionalPercent: somaValida("receitaLiquida") ? Number(((somaValida("resultadoOperacional") / somaValida("receitaLiquida")) * 100).toFixed(1)) : 0,
      despesasPorCategoria: Array.from(categoriasRede.entries())
        .map(([categoria, valor]) => ({ categoria, valor: Number(valor.toFixed(2)) }))
        .sort((a, b) => b.valor - a.valor),
    },
    porBandeiraRede: porBandeiraRedeComPercent,
  };
}

// ---------- Módulo: METAS de faturamento (salvar / listar) ----------
//
// Guarda a meta de faturamento de cada loja, por mês/ano, na tabela metas_faturamento
// (ver metas_faturamento.sql neste pacote — precisa rodar uma vez no SQL Editor do Supabase).

async function moduloMetas(body: any) {
  const supabase = getSupabaseAdmin();
  const acao = String(body.acao ?? "listar");

  if (acao === "salvar") {
    const loja = String(body.loja ?? "");
    const ano = Number(body.ano);
    const mes = Number(body.mes);
    const meta = Number(body.meta);
    if (!loja || !ano || !mes || Number.isNaN(meta)) {
      throw new Error("Para salvar uma meta, informe loja, ano, mes e meta.");
    }
    const { error } = await supabase
      .from("metas_faturamento")
      .upsert({ loja, ano, mes, meta, atualizado_em: new Date().toISOString() }, { onConflict: "loja,ano,mes" });
    if (error) throw new Error(`Erro ao salvar meta: ${error.message}`);
    return { ok: true };
  }

  // acao === "listar"
  const ano = body.ano ? Number(body.ano) : null;
  const mes = body.mes ? Number(body.mes) : null;
  let query = supabase.from("metas_faturamento").select("loja, ano, mes, meta");
  if (ano) query = query.eq("ano", ano);
  if (mes) query = query.eq("mes", mes);
  const { data, error } = await query;
  if (error) throw new Error(`Erro ao listar metas: ${error.message}`);
  return { metas: data ?? [] };
}

// ---------- Módulo: BENCHMARK entre lojas (padrão de consumo normalizado) ----------
//
// Compara lojas de cidades distintas de forma justa: em vez de faturamento bruto (que sempre
// favorece cidade grande + loja antiga), calcula receita por habitante e por dia de loja aberta,
// e agrupa lojas com perfil parecido nessas métricas normalizadas.
//
// Depende da tabela perfil_lojas (ver perfil_lojas.sql) com cidade + população por loja. A data
// de abertura é estimada automaticamente na primeira vez que essa loja passa pelo benchmark
// (busca a venda mais antiga que a API devolver) e fica salva pra não repetir a busca depois —
// é uma aproximação: se a loja vendeu antes de integrar com a VarejOnline, a data real de
// abertura pode ser mais antiga do que essa estimativa.

async function moduloBenchmark(apiBase: string, lojasTokens: Record<string, string>, body: any) {
  const diasJanela = Number(body.diasJanela ?? 365);
  const nomesLojas = lojasAlvo(lojasTokens, body.lojas ?? null);

  const supabase = getSupabaseAdmin();
  const { data: perfis, error } = await supabase
    .from("perfil_lojas")
    .select("loja, cidade, populacao, data_abertura_est");
  if (error) throw new Error(`Erro ao ler perfil_lojas: ${error.message}`);
  const perfilPorLoja = new Map((perfis ?? []).map((p: any) => [p.loja, p]));

  const hoje = new Date();
  const inicioJanela = new Date(hoje);
  inicioJanela.setDate(inicioJanela.getDate() - diasJanela);
  const desde = formatDateBR(inicioJanela);
  const ate = formatDateBR(hoje);

  const NOMES_MES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

  // Processa uma loja por vez (função isolada) pra poder rodar várias em paralelo — sequencial
  // uma a uma (26+ lojas x 1 ano de histórico) estourava o tempo limite da Edge Function (erro 546).
  async function processarLoja(nomeLoja: string): Promise<any> {
    const perfil: any = perfilPorLoja.get(nomeLoja);
    if (!perfil || !perfil.populacao) {
      return { nomeLoja, semPerfil: true };
    }
    const token = lojasTokens[nomeLoja];

    let dataAberturaIso: string | null = perfil.data_abertura_est ?? null;
    if (!dataAberturaIso) {
      try {
        // Só a 1ª venda (uma página de 1 item) — antes percorria TODO o histórico desde 2015.
        const r = await fetch(`${apiBase}/saidas?desde=01-01-2015&ate=${ate}&inicio=0&quantidade=1&token=${token}`);
        const j: any = r.ok ? await r.json() : [];
        const primeiraPagina = Array.isArray(j) ? j : (j.items ?? j.dados ?? []);
        if (primeiraPagina.length && primeiraPagina[0].data) {
          const dataBR = String(primeiraPagina[0].data).split(" ")[0]; // "DD-MM-AAAA"
          const [dd, mm, yyyy] = dataBR.split("-");
          dataAberturaIso = `${yyyy}-${mm}-${dd}`;
          await supabase.from("perfil_lojas").update({ data_abertura_est: dataAberturaIso }).eq("loja", nomeLoja);
        }
      } catch { /* segue sem data de abertura se a consulta falhar */ }
    }

    let saldos: any[] = [];
    let receitaBruta = 0;
    let qtdVendidaTotal = 0;
    const receitaPorProduto = new Map<string, number>();
    const receitaPorMes = new Array(12).fill(0); // índice = mês civil (0 = janeiro)
    const entidadesVenda = new Set<string>();
    const somarSaida = (saida: any) => {
      if (saida.entidade?.id != null) entidadesVenda.add(String(saida.entidade.id));
      if (!ehPedidoVenda(saida)) return;

      // Bucket por mês civil da própria venda (não por "dias atrás"), pra achar o mês de pico real.
      let mesIdx: number | null = null;
      const dataSaida = dataVarejo(saida.data);
      if (dataSaida) mesIdx = dataSaida.getMonth();

      for (const item of saida.mercadorias ?? []) {
        const valor = Number(item.valorTotal ?? 0);
        receitaBruta += valor;
        qtdVendidaTotal += Number(item.quantidade ?? 0);
        if (mesIdx != null) receitaPorMes[mesIdx] += valor;

        const chaveProduto = String(item.produto?.id ?? item.idProduto ?? "?");
        receitaPorProduto.set(chaveProduto, (receitaPorProduto.get(chaveProduto) ?? 0) + valor);
      }
    };
    try {
      await buscarSaidas(apiBase, token, inicioJanela, hoje, somarSaida);
      saldos = (await saldosDaUnidade(apiBase, token, entidadesVenda)).saldos;
    } catch (e) {
      return { nomeLoja, erro: semToken(e) };
    }

    // Giro de estoque: unidades vendidas no período ÷ unidades em estoque atual.
    const estoqueAtualQtd = saldos.reduce((s, item) => s + Number(item.quantidade ?? 0), 0);
    const giroEstoque = estoqueAtualQtd > 0 ? Number((qtdVendidaTotal / estoqueAtualQtd).toFixed(2)) : null;

    // Concentração de mix: % da receita que vem dos 10 produtos mais vendidos.
    const top10Valor = Array.from(receitaPorProduto.values()).sort((a, b) => b - a).slice(0, 10).reduce((s, v) => s + v, 0);
    const concentracaoTop10Percent = receitaBruta > 0 ? Number(((top10Valor / receitaBruta) * 100).toFixed(1)) : null;

    // Sazonalidade: mês com maior receita nos últimos 12 meses civis, e o quanto ele se destaca da média.
    const mediaMovel = receitaPorMes.reduce((s, v) => s + v, 0) / 12;
    const picoValor = Math.max(...receitaPorMes);
    const mesPicoIdx = receitaPorMes.indexOf(picoValor);
    const mesPicoNome = mediaMovel > 0 ? NOMES_MES[mesPicoIdx] : null;
    const trimestrePico = mediaMovel > 0 ? Math.floor(mesPicoIdx / 3) : null; // 0=Jan-Mar, 1=Abr-Jun, 2=Jul-Set, 3=Out-Dez
    const intensidadeSazonalPercent = mediaMovel > 0 ? Number((((picoValor - mediaMovel) / mediaMovel) * 100).toFixed(1)) : null;

    const diasAbertura = dataAberturaIso
      ? Math.max(1, Math.round((hoje.getTime() - new Date(dataAberturaIso).getTime()) / 86400000))
      : null;
    const receitaPorHabitante = Number((receitaBruta / perfil.populacao).toFixed(4));
    const receitaPorHabitantePorDiaAberto = diasAbertura
      ? Number((receitaBruta / perfil.populacao / diasAbertura).toFixed(6))
      : null;

    return {
      nomeLoja,
      cidade: perfil.cidade,
      populacao: perfil.populacao,
      dataAberturaEstimada: dataAberturaIso,
      diasAbertura,
      receitaBruta: Number(receitaBruta.toFixed(2)),
      receitaPorHabitante,
      receitaPorHabitantePorDiaAberto,
      giroEstoque,
      concentracaoTop10Percent,
      mesPicoNome,
      trimestrePico,
      intensidadeSazonalPercent,
    };
  }

  // Roda em lotes de 6 lojas em paralelo (em vez de todas de uma vez, pra não sobrecarregar a
  // API da VarejOnline com dezenas de chamadas simultâneas).
  const TAMANHO_LOTE = 6;
  const resultados: any[] = [];
  for (let i = 0; i < nomesLojas.length; i += TAMANHO_LOTE) {
    const lote = nomesLojas.slice(i, i + TAMANHO_LOTE);
    const resultadosLote = await Promise.all(lote.map((nome) => processarLoja(nome)));
    resultados.push(...resultadosLote);
  }
  // Modo loja a loja: devolve só as métricas; o painel junta todas e chama a ação "agrupar".
  if (body.modo === "loja") return { parametros: { diasJanela, periodo: { desde, ate } }, lojas: resultados };
  return agruparBenchmark(resultados, { diasJanela, periodo: { desde, ate } });
}

// Faixas (consumo, maturidade, giro, sazonalidade) e grupos de lojas parecidas — precisa de TODAS as lojas.
function agruparBenchmark(resultados: any[], parametros: any) {
  const validos = resultados.filter((r) => !r.semPerfil && !r.erro && r.receitaPorHabitante != null);
  const valores = validos.map((r) => r.receitaPorHabitante).sort((a, b) => a - b);
  const valoresGiro = validos.filter((r) => r.giroEstoque != null).map((r) => r.giroEstoque).sort((a, b) => a - b);

  function faixaConsumoDe(valor: number): string {
    if (!valores.length) return "sem_dado";
    const p33 = valores[Math.floor(valores.length * 0.33)];
    const p66 = valores[Math.floor(valores.length * 0.66)];
    if (valor <= p33) return "baixo";
    if (valor <= p66) return "médio";
    return "alto";
  }
  function faixaMaturidadeDe(dias: number | null): string {
    if (dias == null) return "sem_dado";
    const anos = dias / 365;
    if (anos < 2) return "nova (<2 anos)";
    if (anos < 5) return "em maturação (2-5 anos)";
    return "consolidada (5+ anos)";
  }
  function faixaGiroDe(valor: number | null): string {
    if (valor == null || !valoresGiro.length) return "sem_dado";
    const p33 = valoresGiro[Math.floor(valoresGiro.length * 0.33)];
    const p66 = valoresGiro[Math.floor(valoresGiro.length * 0.66)];
    if (valor <= p33) return "giro baixo";
    if (valor <= p66) return "giro médio";
    return "giro alto";
  }
  function faixaSazonalidadeDe(intensidade: number | null): string {
    if (intensidade == null) return "sem_dado";
    if (intensidade < 30) return "baixa (venda estável no ano)";
    if (intensidade < 70) return "média";
    return "alta (bem concentrada em poucos meses)";
  }
  const NOMES_TRIMESTRE = ["Jan-Mar", "Abr-Jun", "Jul-Set", "Out-Dez"];

  for (const r of validos) {
    r.faixaConsumo = faixaConsumoDe(r.receitaPorHabitante);
    r.faixaMaturidade = faixaMaturidadeDe(r.diasAbertura);
    r.grupoPadrao = `${r.faixaConsumo} · ${r.faixaMaturidade}`;
    r.faixaGiro = faixaGiroDe(r.giroEstoque);
    r.faixaSazonalidade = faixaSazonalidadeDe(r.intensidadeSazonalPercent);
    r.trimestrePicoNome = r.trimestrePico != null ? NOMES_TRIMESTRE[r.trimestrePico] : null;
    r.grupoSazonal = r.trimestrePicoNome ? `${r.trimestrePicoNome} · ${r.faixaSazonalidade}` : "sem_dado";
  }

  const grupos = new Map<string, string[]>();
  for (const r of validos) {
    const g = grupos.get(r.grupoPadrao) ?? [];
    g.push(r.nomeLoja);
    grupos.set(r.grupoPadrao, g);
  }
  const clusters = Array.from(grupos.entries())
    .map(([grupo, lojas]) => ({ grupo, lojas }))
    .filter((c) => c.lojas.length > 1)
    .sort((a, b) => b.lojas.length - a.lojas.length);

  const gruposSazonais = new Map<string, string[]>();
  for (const r of validos) {
    if (r.grupoSazonal === "sem_dado") continue;
    const g = gruposSazonais.get(r.grupoSazonal) ?? [];
    g.push(r.nomeLoja);
    gruposSazonais.set(r.grupoSazonal, g);
  }
  const clustersSazonais = Array.from(gruposSazonais.entries())
    .map(([grupo, lojas]) => ({ grupo, lojas }))
    .filter((c) => c.lojas.length > 1)
    .sort((a, b) => b.lojas.length - a.lojas.length);

  return {
    parametros,
    lojas: resultados.sort((a, b) => (b.receitaPorHabitante ?? -1) - (a.receitaPorHabitante ?? -1)),
    clusters,
    clustersSazonais,
  };
}

// ---------- Módulo: LOJAS (cadastro de unidades — nome, CNPJ, token) ----------
//
// Cadastra/lista/desativa lojas na tabela lojas_config. O token NUNCA é devolvido pro frontend
// na listagem (só nome, CNPJ, status) — ele só entra e sai internamente na Edge Function.

async function moduloLojas(body: any) {
  const supabase = getSupabaseAdmin();
  const acao = String(body.acao ?? "listar");

  if (acao === "adicionar" || acao === "atualizar") {
    const nome = String(body.nome ?? "").trim();
    const cnpj = String(body.cnpj ?? "").trim();
    const token = String(body.token ?? "").trim();
    if (!nome || !token) throw new Error("Para cadastrar uma loja, informe pelo menos nome e token.");
    const { error } = await supabase
      .from("lojas_config")
      .upsert({ nome, cnpj: cnpj || null, token, ativo: true, atualizado_em: new Date().toISOString() }, { onConflict: "nome" });
    if (error) throw new Error(`Erro ao salvar loja: ${error.message}`);
    return { ok: true };
  }

  if (acao === "desativar" || acao === "reativar") {
    const nome = String(body.nome ?? "").trim();
    if (!nome) throw new Error("Informe o nome da loja.");
    const { error } = await supabase
      .from("lojas_config")
      .update({ ativo: acao === "reativar", atualizado_em: new Date().toISOString() })
      .eq("nome", nome);
    if (error) throw new Error(`Erro ao atualizar status da loja: ${error.message}`);
    return { ok: true };
  }

  // acao === "listar" — nunca inclui o token na resposta.
  const { data, error } = await supabase
    .from("lojas_config")
    .select("nome, cnpj, ativo, criado_em")
    .order("nome", { ascending: true });
  if (error) throw new Error(`Erro ao listar lojas: ${error.message}`);
  return { lojas: data ?? [] };
}

// ---------- Roteador principal ----------

serve(async (req) => {
  corsHeaders["Access-Control-Allow-Origin"] = origemPermitida(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let acesso: Acesso;
  try { acesso = await obterAcesso(req); } catch (e) {
    if (e instanceof ErroAcesso) return respostaErroAcesso(e, corsHeaders);
    throw e;
  }
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const apiBase = Deno.env.get("VAREJONLINE_API_BASE")!;

  if (req.method === "GET") {
    try {
      const lojasTokens = await getLojasTokens();
      const nomes = Object.keys(lojasTokens).filter((n) => acesso.todas || acesso.lojas.includes(n));
      return new Response(JSON.stringify({ lojas: nomes }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: semToken(err) }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  try {
    const body = await req.json().catch(() => ({}));
    const modulo = String(body.modulo ?? "");
    if (acesso.trocarSenha) throw new ErroAcesso("Troque a senha temporária antes de continuar.", 403);
    // Franqueado: só as lojas liberadas; benchmark e cadastro de lojas são da equipe.
    if (["recorrente", "sazonal", "estoque", "financeiro"].includes(modulo)) body.lojas = lojasDoAcesso(acesso, body.lojas);
    if (modulo === "benchmark") exigirPapel(acesso, "admin", "equipe");
    if (modulo === "lojas") { if (String(body.acao ?? "listar") === "listar") exigirPapel(acesso, "admin", "equipe"); else exigirPapel(acesso, "admin"); }
    if (modulo === "metas") {
      if (String(body.acao ?? "listar") === "salvar") { exigirPapel(acesso, "admin", "equipe"); }
      else if (!acesso.todas) {
        const r: any = await moduloMetas(body);
        return json({ metas: (r.metas ?? []).filter((m: any) => acesso.lojas.includes(m.loja)) });
      }
    }

    // Benchmark: agrupa métricas já calculadas loja a loja (não consulta a VarejOnline).
    if (modulo === "benchmark" && body.acao === "agrupar") {
      const metricas = Array.isArray(body.metricas) ? body.metricas : [];
      return new Response(JSON.stringify(agruparBenchmark(metricas, body.parametros ?? {})), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // O módulo de cadastro de lojas não precisa da lista de tokens carregada de antemão.
    if (modulo === "lojas") {
      const resultado = await moduloLojas(body);
      return new Response(JSON.stringify(resultado), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const lojasTokens = await getLojasTokens();

    let resultado;
    switch (modulo) {
      case "recorrente":
        resultado = await moduloRecorrente(apiBase, lojasTokens, body);
        break;
      case "sazonal":
        resultado = await moduloSazonal(apiBase, lojasTokens, body);
        break;
      case "estoque":
        resultado = await moduloEstoque(apiBase, lojasTokens, body);
        break;
      case "financeiro":
        resultado = await moduloFinanceiro(apiBase, lojasTokens, body);
        break;
      case "metas":
        resultado = await moduloMetas(body);
        break;
      case "benchmark":
        resultado = await moduloBenchmark(apiBase, lojasTokens, body);
        break;
      default:
        return new Response(JSON.stringify({ error: `Módulo desconhecido: "${modulo}". Use recorrente, sazonal, estoque, financeiro, metas, benchmark ou lojas.` }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    return new Response(JSON.stringify(resultado), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    if (err instanceof ErroAcesso) return respostaErroAcesso(err, corsHeaders);
    return new Response(JSON.stringify({ error: semToken(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
