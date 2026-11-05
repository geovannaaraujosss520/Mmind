-- Mastermind SSS · catálogo fixo da Central do Franqueado
-- Guarda todos os itens já vistos nos pedidos (origem 'pedido') e os da planilha "Peças da Central" (origem 'planilha').
-- Nada sai sozinho: um item sem pedido há muito tempo continua disponível para vínculo e para o pedido sugerido.
-- Supabase → SQL Editor → New query → cole → Run. Pode rodar mais de uma vez.

create table if not exists public.catalogo_central (
  chave            text primary key,          -- CODIGO|VARIACAO (mesma chave usada nos vínculos)
  codigo           text not null,
  descricao        text,
  variacao         text,
  fornecedor_id    text,
  fornecedor_nome  text,
  categoria        text,
  preco            numeric,                   -- custo para a loja
  qtd_minima       numeric,
  fator_conversao  numeric,
  id_produto       text,                      -- só itens vistos em pedidos (necessário para enviar pela API)
  unidade          text,
  origem           text not null default 'planilha' check (origem in ('pedido','planilha')),
  ultima_compra    timestamptz,
  atualizado_em    timestamptz not null default now()
);

create index if not exists catalogo_central_codigo_idx on public.catalogo_central (codigo);

alter table public.catalogo_central enable row level security;
