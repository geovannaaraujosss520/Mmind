-- Vínculo de um produto da loja a VÁRIOS itens da Central escolhidos à mão
-- (ex.: pulseira cor 22 = 4443.pp|22, 4443.p|22, 4443.m|22, 4443.g|22).
-- chave_central continua com o primeiro item; aqui ficam os demais.
alter table public.vinculos_produto_rede add column if not exists chaves_grade text[];
