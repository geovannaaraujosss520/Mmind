-- Mastermind SSS · usuários do painel (login por e-mail e senha)
-- Cada pessoa tem uma conta no Supabase Auth + um perfil aqui com o papel e as lojas liberadas.
--   admin      → tudo, inclusive usuários e cadastro de lojas
--   equipe     → rede toda (compras, pedidos, vínculos, financeiro, benchmark)
--   franqueado → só as lojas em "lojas" (inclusive aprovar e enviar os pedidos delas)
-- Supabase → SQL Editor → New query → cole → Run. Pode rodar mais de uma vez.

create table if not exists public.usuarios_painel (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  email          text not null,
  nome           text not null,
  papel          text not null default 'franqueado' check (papel in ('admin', 'equipe', 'franqueado')),
  lojas          text[] not null default '{}',
  ativo          boolean not null default true,
  trocar_senha   boolean not null default true,   -- senha temporária: pede para trocar no 1º acesso
  criado_por     text,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now()
);

create index if not exists usuarios_painel_lojas_idx on public.usuarios_painel using gin (lojas);

-- Só as Edge Functions (service role) leem e gravam; nada é exposto ao navegador.
alter table public.usuarios_painel enable row level security;
