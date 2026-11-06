-- Insight SSS · cache das vendas da VarejOnline por loja e dia
-- Dia fechado (anteontem para trás) não muda, então fica guardado aqui e não é baixado de novo:
-- as telas (Compras, Vínculos, Estoque, Financeiro, Vendedores, Benchmark) leem daqui e só buscam
-- ontem e hoje na VarejOnline. Pode apagar a tabela a qualquer momento: ela se refaz sozinha.
-- Supabase → SQL Editor → New query → cole → Run. Pode rodar mais de uma vez.

create table if not exists public.vendas_cache_dias (
  loja          text not null,
  dia           date not null,
  saidas        jsonb not null,             -- vendas do dia, compactadas (só os campos usados)
  qtd           int  not null default 0,    -- número de vendas no dia
  atualizado_em timestamptz not null default now(),
  primary key (loja, dia)
);

alter table public.vendas_cache_dias enable row level security;

-- Para limpar o cache de uma loja (ex.: depois de corrigir vendas antigas na VarejOnline):
-- delete from public.vendas_cache_dias where loja = 'SSS NOME DA LOJA';
