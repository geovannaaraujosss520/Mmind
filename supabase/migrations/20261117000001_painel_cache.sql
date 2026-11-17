-- Início pré-calculado: o aquecimento (a cada 15 min) guarda aqui o resultado do painel da rede.
-- Quem abre o painel lê o resultado pronto, sem estourar o limite de CPU (2 s) das funções.
create table if not exists public.painel_cache (
  chave text primary key,
  dados jsonb not null,
  atualizado_em timestamptz not null default now()
);
alter table public.painel_cache enable row level security;  -- acesso só pelas funções
