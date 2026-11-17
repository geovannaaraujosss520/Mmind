-- 1) Acompanhamento do "Hora de chamar": cada contato feito com um cliente (WhatsApp ou "Marcar como chamado").
create table if not exists public.contatos_clientes (
  id bigserial primary key,
  loja text not null,
  cliente_id text not null,
  cliente_nome text,
  motivo text,                      -- hora, volta, aniversario, oferecer, vip, acao
  usuario text,
  contatado_em timestamptz not null default now()
);
create index if not exists contatos_clientes_loja_data on public.contatos_clientes (loja, contatado_em desc);
alter table public.contatos_clientes enable row level security;  -- acesso só pelas funções

-- retorno após contato por loja (para a franqueadora comparar as lojas)
alter table public.clientes_indicadores add column if not exists contatados_90 integer;
alter table public.clientes_indicadores add column if not exists voltaram_90 integer;
alter table public.clientes_indicadores add column if not exists retorno_contato_pct numeric;
alter table public.clientes_indicadores add column if not exists fat_apos_contato numeric;
