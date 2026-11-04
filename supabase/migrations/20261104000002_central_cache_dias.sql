-- Mastermind SSS · cache dos pedidos da Central do Franqueado (um registro por dia)
-- Evita buscar 120–180 dias na API da Central a cada clique (causa do erro 546 por tempo).
-- Supabase → SQL Editor → New query → cole → Run. Rodar uma vez.

create table if not exists public.central_cache_dias (
  dia            date primary key,
  pedidos        jsonb not null default '[]'::jsonb,
  total          integer not null default 0,
  atualizado_em  timestamptz not null default now()
);

-- Só a Edge Function (service role) acessa.
alter table public.central_cache_dias enable row level security;
