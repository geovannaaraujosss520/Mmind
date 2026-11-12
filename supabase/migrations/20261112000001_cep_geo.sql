-- Coordenadas por CEP (para a distância dos clientes até a loja na tela Clientes).
-- Guarda só o CEP e a posição aproximada do logradouro/bairro: nada que identifique o cliente.
create table if not exists public.cep_geo (
  cep text primary key,              -- 8 dígitos; lojas usam 'CNPJ' + 14 dígitos
  lat double precision,
  lng double precision,
  cidade text,
  bairro text,
  uf text,
  fonte text,                         -- awesomeapi | brasilapi | nao_encontrado
  atualizado_em timestamptz not null default now()
);
alter table public.cep_geo enable row level security;  -- acesso só pelas funções (service role)
