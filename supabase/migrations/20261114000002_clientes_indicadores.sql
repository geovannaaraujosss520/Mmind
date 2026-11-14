-- Indicadores de clientes por loja (prazo de volta), para comparar cada loja com a média da rede.
-- Preenchida pelo aquecimento diário e sempre que alguém abre a tela Clientes (12 meses, sumido = 90 dias).
create table if not exists public.clientes_indicadores (
  loja text primary key,
  prazo_dias integer,
  no_prazo_pct numeric,
  recompra_pct numeric,
  clientes integer,
  atualizado_em timestamptz not null default now()
);
alter table public.clientes_indicadores enable row level security;  -- acesso só pelas funções (service role)
