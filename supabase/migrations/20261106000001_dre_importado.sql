-- Insight SSS · DRE / DFC gerencial importado por planilha (uma linha por loja, mês e linha do DRE)
-- Supabase → SQL Editor → New query → cole → Run. Pode rodar mais de uma vez.

create table if not exists public.dre_importado (
  loja          text not null,
  competencia   text not null,              -- AAAA-MM
  ordem         int  not null default 0,    -- posição da linha na planilha
  linha         text not null,              -- nome da linha como está na planilha
  tipo          text not null default 'item' check (tipo in ('item','total')),
  valor         numeric not null,
  arquivo       text,
  importado_por text,
  importado_em  timestamptz not null default now(),
  primary key (loja, competencia, linha)
);

create index if not exists dre_importado_loja_comp_idx on public.dre_importado (loja, competencia);

alter table public.dre_importado enable row level security;
