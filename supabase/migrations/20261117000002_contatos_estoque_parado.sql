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

-- 2) Estoque parado: onde cada produto vende (últimos 60 dias, por código) e o resumo do parado de cada loja.
create table if not exists public.giro_produtos_rede (
  loja text not null,
  codigo text not null,
  descricao text,
  qtd60 numeric not null default 0,
  ultima_venda date,
  atualizado_em timestamptz not null default now(),
  primary key (loja, codigo)
);
create index if not exists giro_produtos_rede_codigo on public.giro_produtos_rede (codigo);
alter table public.giro_produtos_rede enable row level security;

create table if not exists public.estoque_parado_lojas (
  loja text primary key,
  produtos integer,                 -- produtos com estoque e sem venda há 60+ dias
  pecas numeric,
  valor_custo numeric,
  valor_venda numeric,
  faixas jsonb,                     -- { "60": {produtos, pecas, valor}, "90": …, "180": …, "sem12m": … }
  atualizado_em timestamptz not null default now()
);
alter table public.estoque_parado_lojas enable row level security;
