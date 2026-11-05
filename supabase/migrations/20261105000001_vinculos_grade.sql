-- Mastermind SSS · vínculo à grade: o produto da loja fica ligado a TODOS os tamanhos
-- do mesmo código/cor na Central (ex.: COLAR FIO ESPIRITO SANTO SIMPLES → 35, 38, 42, 45, 50 cm).
-- O pedido sugerido distribui a quantidade entre os tamanhos pela proporção da rede.
-- Supabase → SQL Editor → New query → cole → Run. Pode rodar mais de uma vez.

alter table public.vinculos_produto_rede
  add column if not exists grade boolean not null default false;
