-- Meta do dia: por padrão divide a meta pelos dias de segunda a sábado.
-- Marcando "Considerar domingo" (tela Financeiro, ao salvar a meta), o domingo entra na conta para aquela loja/mês.
alter table public.metas_faturamento add column if not exists considerar_domingo boolean not null default false;
