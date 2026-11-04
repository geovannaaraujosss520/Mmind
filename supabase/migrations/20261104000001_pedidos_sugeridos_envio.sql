-- Mastermind SSS · envio de pedidos para a Central (rodar UMA vez, depois do pedidos_sugeridos.sql)
-- Supabase → SQL Editor → New query → cole → Run.

alter table public.pedidos_sugeridos
  add column if not exists enviado_em       timestamptz,
  add column if not exists enviado_por      text,
  add column if not exists erro_envio       text,
  add column if not exists resposta_central jsonb,
  add column if not exists frete_id         text,
  add column if not exists pagamento_id     text;

-- novos status: enviando (trava durante o envio) e erro_envio
alter table public.pedidos_sugeridos drop constraint if exists pedidos_sugeridos_status_check;
alter table public.pedidos_sugeridos add constraint pedidos_sugeridos_status_check
  check (status in ('aprovado', 'enviando', 'erro_envio', 'lancado', 'descartado'));
