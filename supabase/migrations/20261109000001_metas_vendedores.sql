-- Insight SSS · metas do mês por vendedor (tela Equipe)
-- Supabase → SQL Editor → New query → cole → Run. Pode rodar mais de uma vez.

create table if not exists public.metas_vendedores (
  loja           text not null,
  ano            int  not null,
  mes            int  not null check (mes between 1 and 12),
  vendedor_id    text not null,            -- id do representante na VarejOnline
  vendedor_nome  text,
  meta           numeric not null check (meta >= 0),
  atualizado_por text,
  atualizado_em  timestamptz not null default now(),
  primary key (loja, ano, mes, vendedor_id)
);

alter table public.metas_vendedores enable row level security;
