// Insight SSS · cache das vendas (saídas) da VarejOnline por loja e dia — usado pelas duas Edge Functions.
//
// Dia fechado (anteontem para trás) não muda: fica guardado em vendas_cache_dias e não é baixado de novo.
// Ontem e hoje são sempre lidos ao vivo. Dias dos últimos 7 dias guardados há mais de 6 h são relidos
// (cancelamentos e ajustes tardios). Sem a tabela (SQL não rodado), tudo continua ao vivo como antes.

export type BuscarPaginas = (url: string, token: string, onPage: (pg: any[]) => void) => Promise<unknown>;

export type Medicao = {
  inicio: number;
  varejo: { chamadas: number; paginas: number; ms: number };
  cache: { diasDoCache: number; diasBaixados: number; diasAoVivo: number; ms: number };
  centralMs: number;
};
export const novaMedicao = (): Medicao => ({ inicio: Date.now(), varejo: { chamadas: 0, paginas: 0, ms: 0 }, cache: { diasDoCache: 0, diasBaixados: 0, diasAoVivo: 0, ms: 0 }, centralMs: 0 });
// Medição da requisição atual (aproximada se a mesma instância atender duas requisições ao mesmo tempo).
export let medicao: Medicao = novaMedicao();
export function reiniciarMedicao() { medicao = novaMedicao(); return medicao; }
export function resumoMedicao() {
  const m = medicao;
  return { totalMs: Date.now() - m.inicio, varejoMs: m.varejo.ms, varejoChamadas: m.varejo.chamadas, varejoPaginas: m.varejo.paginas,
    cacheMs: m.cache.ms, diasDoCache: m.cache.diasDoCache, diasBaixados: m.cache.diasBaixados, diasAoVivo: m.cache.diasAoVivo, centralMs: m.centralMs };
}

// Guarda só os campos que alguma tela usa (o objeto da VarejOnline é bem maior).
export const compactarVenda = (sd: any) => ({
  id: sd.id, numeroDocumento: sd.numeroDocumento, cancelado: sd.cancelado, tipoSaida: sd.tipoSaida,
  data: sd.data ?? sd.dataSaida ?? sd.dataEmissao,
  entidade: sd.entidade ? { id: sd.entidade.id, nome: sd.entidade.nome } : undefined, entidadeId: sd.entidadeId,
  terceiro: sd.terceiro ? { id: sd.terceiro.id, nome: sd.terceiro.nome, documento: sd.terceiro.documento } : undefined,
  mercadorias: (sd.mercadorias ?? []).map((it: any) => ({
    produto: it.produto ? { id: it.produto.id, descricao: it.produto.descricao, codigoSistema: it.produto.codigoSistema, codigoBarras: it.produto.codigoBarras } : null,
    quantidade: it.quantidade, valorCusto: it.valorCusto, valorTotal: it.valorTotal, valorTotalDesconto: it.valorTotalDesconto,
    valorDescontoItem: it.valorDescontoItem, idRepresentante: it.idRepresentante,
  })),
});

// No banco, a descrição do produto vai uma vez por dia (dicionário), não em cada item: ocupa ~40% menos.
function empacotar(lista: any[]) {
  const p: Record<string, any[]> = {};
  const s = lista.map((sd) => ({ ...sd, mercadorias: (sd.mercadorias ?? []).map((it: any) => {
    const pr = it.produto; if (!pr) return { ...it, produto: undefined };
    const id = String(pr.id); if (!p[id]) p[id] = [pr.descricao ?? null, pr.codigoSistema ?? null, pr.codigoBarras ?? null];
    return { ...it, produto: undefined, p: pr.id };
  }) }));
  return { v: 1, p, s };
}
function desempacotar(x: any): any[] {
  if (Array.isArray(x)) return x;
  if (!x || !Array.isArray(x.s)) return [];
  const p = x.p ?? {};
  return x.s.map((sd: any) => ({ ...sd, mercadorias: (sd.mercadorias ?? []).map((it: any) => {
    if (it.p == null) return { ...it, produto: null };
    const d = p[String(it.p)] ?? [];
    const { p: id, ...resto } = it;
    return { ...resto, produto: { id, descricao: d[0] ?? undefined, codigoSistema: d[1] ?? undefined, codigoBarras: d[2] ?? undefined } };
  }) }));
}

// Dia da venda (AAAA-MM-DD) a partir da data da VarejOnline ("dd-mm-aaaa ..." ou "aaaa-mm-dd ...").
export function diaDaVenda(sd: any): string | null {
  const t = String(sd?.data ?? sd?.dataSaida ?? sd?.dataEmissao ?? '').trim();
  let m = t.match(/^(\d{2})[-/](\d{2})[-/](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const br = (dia: string) => `${dia.slice(8, 10)}-${dia.slice(5, 7)}-${dia.slice(0, 4)}`;
const maisDias = (dia: string, n: number) => { const d = new Date(`${dia}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// "Hoje" no Brasil (UTC-3), independente do fuso do servidor.
const hojeBrasil = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);

let tabelaOk: boolean | null = null;

type Opcoes = {
  sb: () => any; buscarPaginas: BuscarPaginas; apiBase: string; token: string; loja: string | null;
  dIni: Date; dFim: Date; onSaida: (sd: any) => void; janelaDias?: number; conc?: number;
  prazo?: number; // (pre-aquecimento) não começa janelas novas depois deste horário; devolve completo=false
};

export async function saidasComCache(o: Opcoes): Promise<boolean> {
  const janelaDias = o.janelaDias ?? 15, conc = o.conc ?? 4;
  const ini = iso(o.dIni), fim = iso(o.dFim);
  if (ini > fim) return true;
  let completo = true;
  const noPrazo = () => !o.prazo || Date.now() < o.prazo;
  const vistos = new Set<string>();
  const emitir = (sd: any) => {
    const k = sd.id != null ? `i${sd.id}` : `d${sd.numeroDocumento}|${sd.data ?? ''}|${sd.entidade?.id ?? ''}`;
    if (vistos.has(k)) return;
    vistos.add(k); o.onSaida(sd);
  };
  const baixar = async (de: string, ate: string, cada: (sd: any) => void) => {
    const t0 = Date.now(); medicao.varejo.chamadas++;
    try {
      await o.buscarPaginas(`${o.apiBase}/saidas?desde=${br(de)}&ate=${br(ate)}`, o.token, (pg) => { medicao.varejo.paginas++; for (const sd of pg) cada(sd); });
    } finally { medicao.varejo.ms += Date.now() - t0; }
  };
  const emParalelo = async (tarefas: (() => Promise<void>)[]) => {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(conc, tarefas.length) }, async () => { while (i < tarefas.length) { if (!noPrazo()) { completo = false; return; } await tarefas[i++](); } }));
  };
  const janelas = (de: string, ate: string) => {
    const out: [string, string][] = [];
    for (let a = de; a <= ate; a = maisDias(a, janelaDias + 1)) { const b = maisDias(a, janelaDias); out.push([a, b < ate ? b : ate]); }
    return out;
  };

  const limiteFechado = maisDias(hojeBrasil(), -1); // ontem: daqui para frente é sempre ao vivo
  const fimFechado = fim < limiteFechado ? fim : maisDias(limiteFechado, -1);
  const usarCache = !!o.loja && tabelaOk !== false && ini <= fimFechado;

  // 1) Dias fechados: do cache; o que faltar é baixado e guardado
  if (usarCache) {
    const t0 = Date.now();
    const doCache = new Map<string, any[]>();
    const recente = maisDias(hojeBrasil(), -7), velho = new Date(Date.now() - 6 * 3600_000).toISOString();
    try {
      for (let a = ini; a <= fimFechado; a = maisDias(a, 31)) {
        const b = maisDias(a, 30) < fimFechado ? maisDias(a, 30) : fimFechado;
        const r = await o.sb().from('vendas_cache_dias').select('dia, saidas, atualizado_em').eq('loja', o.loja).gte('dia', a).lte('dia', b);
        if (r.error) throw r.error;
        tabelaOk = true;
        for (const row of r.data ?? []) {
          const dia = String(row.dia).slice(0, 10);
          if (dia >= recente && String(row.atualizado_em) < velho) continue; // recente e antigo: relê
          doCache.set(dia, desempacotar(row.saidas));
        }
      }
    } catch (_) { tabelaOk = false; doCache.clear(); }
    medicao.cache.ms += Date.now() - t0;

    if (tabelaOk) {
      for (const [, lista] of doCache) for (const sd of lista) emitir(sd);
      medicao.cache.diasDoCache += doCache.size;
      // dias que faltam -> trechos contínuos -> janelas
      const faltam: string[] = [];
      for (let d = ini; d <= fimFechado; d = maisDias(d, 1)) if (!doCache.has(d)) faltam.push(d);
      const trechos: [string, string][] = [];
      for (const d of faltam) { const u = trechos.at(-1); if (u && maisDias(u[1], 1) === d) u[1] = d; else trechos.push([d, d]); }
      const tarefas = trechos.flatMap(([a, b]) => janelas(a, b)).map(([a, b]) => async () => {
        const porDia = new Map<string, any[]>();
        for (let d = a; d <= b; d = maisDias(d, 1)) porDia.set(d, []);
        let confiavel = true;
        await baixar(a, b, (sd) => {
          const c = compactarVenda(sd), dia = diaDaVenda(sd);
          if (!dia || !porDia.has(dia)) confiavel = false; else porDia.get(dia)!.push(c);
          emitir(c);
        });
        medicao.cache.diasBaixados += porDia.size;
        if (!confiavel) return; // data fora do esperado: não guarda (na próxima vez baixa de novo)
        const agora = new Date().toISOString();
        const linhas = [...porDia.entries()].map(([dia, saidas]) => ({ loja: o.loja, dia, saidas: empacotar(saidas), qtd: saidas.length, atualizado_em: agora }));
        for (let k = 0; k < linhas.length; k += 7) {
          const { error } = await o.sb().from('vendas_cache_dias').upsert(linhas.slice(k, k + 7), { onConflict: 'loja,dia' });
          if (error) break;
        }
      });
      await emParalelo(tarefas);
    }
  }

  // 2) Ontem e hoje (ou tudo, sem cache): ao vivo
  const inicioVivo = usarCache && tabelaOk ? (fimFechado < ini ? ini : maisDias(fimFechado, 1)) : ini;
  if (inicioVivo <= fim && !o.prazo) {
    let dias = 0; for (let d = inicioVivo; d <= fim; d = maisDias(d, 1)) dias++;
    medicao.cache.diasAoVivo += dias;
    await emParalelo(janelas(inicioVivo, fim).map(([a, b]) => () => baixar(a, b, (sd) => emitir(compactarVenda(sd)))));
  }
  return completo && (!usarCache || tabelaOk !== false);
}

// ---- Estoque (saldos) guardado 10 minutos na memória da função ----
// A Central de Decisão e as telas abertas em seguida pedem o mesmo estoque várias vezes; dentro de 10 min
// ele é reaproveitado. Guarda só os campos usados (quantidade, unidade e identificação do produto).
const cacheSaldos = new Map<string, { t: number; itens: any[] }>();
const compactarSaldo = (sl: any) => ({ quantidade: sl.quantidade, entidade: sl.entidade ? { id: sl.entidade.id, nome: sl.entidade.nome } : undefined,
  produto: sl.produto ? { id: sl.produto.id, descricao: sl.produto.descricao, codigoSistema: sl.produto.codigoSistema, codigoInterno: sl.produto.codigoInterno, codigoBarras: sl.produto.codigoBarras } : undefined });
export async function saldosComCache(buscarPaginas: BuscarPaginas, url: string, token: string, onPage: (pg: any[]) => void): Promise<any[]> {
  const k = `${token}|${url}`, c = cacheSaldos.get(k);
  if (c && Date.now() - c.t < 10 * 60_000) { onPage(c.itens); return c.itens; }
  const itens: any[] = [];
  const t0 = Date.now(); medicao.varejo.chamadas++;
  try { await buscarPaginas(url, token, (pg) => { medicao.varejo.paginas++; const cp = pg.map(compactarSaldo); itens.push(...cp); onPage(cp); }); }
  finally { medicao.varejo.ms += Date.now() - t0; }
  if (cacheSaldos.size > 60) cacheSaldos.clear();
  cacheSaldos.set(k, { t: Date.now(), itens });
  return itens; // como o fetchAllPages: devolve a lista (há quem use o retorno)
}
