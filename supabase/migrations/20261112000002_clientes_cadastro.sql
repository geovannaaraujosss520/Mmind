-- Cadastro dos clientes já lido da VarejOnline (contato e endereço), para não ler o cadastro inteiro a cada consulta.
-- "conta" = resumo (hash) do token da VarejOnline: o mesmo id de cliente vale para todas as lojas desse token.
create table if not exists public.clientes_cadastro (
  conta text not null,
  cliente_id text not null,
  telefone text, whatsapp text, email text, aniversario text,
  cep text, bairro text, cidade text, uf text,
  encontrado boolean not null default true,
  atualizado_em timestamptz not null default now(),
  primary key (conta, cliente_id)
);
alter table public.clientes_cadastro enable row level security;  -- acesso só pelas funções (service role)
