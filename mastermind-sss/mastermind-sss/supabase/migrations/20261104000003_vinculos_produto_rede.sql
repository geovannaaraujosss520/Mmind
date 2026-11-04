-- Mastermind SSS · vínculos produto (VarejOnline) → item da Central (código + variação), válidos para TODA a rede
-- Os cadastros de produto são iguais em todas as lojas, então o produto é identificado pelo código do sistema
-- (produto_chave = 'C:<código>'; sem código, 'I:<id do produto>').
-- Supabase → SQL Editor → New query → cole → Run. Rodar uma vez.

create table if not exists public.vinculos_produto_rede (
  produto_chave      text primary key,
  produto_id         text,
  codigo_sistema     text,
  descricao_produto  text,
  chave_central      text,                   -- CODIGO|VARIACAO[|tamanho] (nulo quando "fora da Central")
  codigo_central     text,
  variacao           text,
  fornecedor_id      text,
  descricao_central  text,
  ignorar            boolean not null default false,  -- produto que não se compra pela Central
  motivo             text,
  loja_origem        text,                   -- loja em que o vínculo foi feito (só informativo)
  atualizado_por     text,
  atualizado_em      timestamptz not null default now()
);

create index if not exists vinculos_produto_rede_central_idx on public.vinculos_produto_rede (chave_central);

alter table public.vinculos_produto_rede enable row level security;

-- Se você já tinha rodado o SQL anterior (produtos_vinculos_central, por loja), ele não é mais usado.
-- Pode apagar com a linha abaixo (tire os dois traços do começo):
-- drop table if exists public.produtos_vinculos_central;
