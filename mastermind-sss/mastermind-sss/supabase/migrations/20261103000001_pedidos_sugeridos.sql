-- Mastermind SSS · tabela dos pedidos sugeridos aprovados
-- Rode uma vez no Supabase: SQL Editor → New query → cole → Run.

create table if not exists public.pedidos_sugeridos (
  id                     uuid primary key default gen_random_uuid(),
  loja                   text not null,
  fornecedor_id          text not null,
  fornecedor_nome        text,
  itens                  jsonb not null,
  valor_total            numeric(14,2) not null default 0,
  status                 text not null default 'aprovado'
                         check (status in ('aprovado', 'lancado', 'descartado')),
  aprovado_por           text,
  observacao             text,
  criado_em              timestamptz not null default now(),
  lancado_em             timestamptz,
  codigo_pedido_central  integer
);

create index if not exists pedidos_sugeridos_loja_idx   on public.pedidos_sugeridos (loja, criado_em desc);
create index if not exists pedidos_sugeridos_status_idx on public.pedidos_sugeridos (status, fornecedor_id);

-- Só a Edge Function (service role) acessa; nenhum acesso público.
alter table public.pedidos_sugeridos enable row level security;
