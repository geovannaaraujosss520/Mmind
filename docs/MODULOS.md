# Módulos do Mastermind SSS

## Central de Decisão
Roda em paralelo Compras, Estoque, DRE do mês + metas, Vendedores (e Benchmark, opcional) e entrega:
- **Ações priorizadas** (Crítico / Atenção / Oportunidade) com impacto em R$: ruptura, meta projetada abaixo, prejuízo operacional, margem abaixo da rede, capital parado, transferências, pedidos da Central parados ou atrasados, mix barato, cliente não identificado, cadastros incompletos.
- **Nota de saúde 0–100 por loja** = meta projetada (30) + margem operacional (30) + ruptura (25) + excesso/parado (15).
- **Ritmo do mês**: projeção de fechamento × meta e quanto precisa vender por dia.
- **Transferências entre lojas** antes de comprar.
- **Resumo executivo** para copiar e enviar.

## Compra Recorrente
Venda média × período alvo × crescimento + segurança − estoque − pedidos em andamento na Central.
Lê as vendas em janelas paralelas e o estoque da unidade (com diagnóstico de cobertura). Pedidos em andamento são descontados por item e variação.

## Pedido Central
1. Etapa 1: necessidade da loja (Compra Recorrente).
2. Etapa 2: converte em itens da Central usando os **Vínculos**, separa por fornecedor, aplica mínimo/máximo/embalagem.
3. Revisão: quantidades, variação, **grade de tamanhos** (fornecedores em `FORNECEDORES_GRADE`) com distribuição pela proporção da rede.
4. Aprovação (com trava de duplicidade e limite de valor).
5. Envio pela API `POST /api/v3/cart/finishOrders` com conferência de frete, pagamento e preço; ou lançamento manual com confirmação automática quando o pedido aparece na Central.

## Vínculos de produtos
Produto da VarejOnline (código do sistema) ↔ item da Central (código + variação + tamanho), **válido para a rede inteira**.
Ordem de ligação: vínculo confirmado → vínculo antigo por código → código igual → descrição igual. Variações por cor e tamanho (referência da variação, P/M/G, medidas).
Status: Confirmado · Por código · Conferir · Sem vínculo · Fora da Central.

## Vendedores
Por vendedor e loja, em período de/até: faturamento, atendimentos, PA, ticket, preço médio da peça, % de peças abaixo do preço-limite (alerta a partir de 60%), atendimentos de 1 peça, desconto, % de vendas com cliente identificado e cadastros novos completos (nome completo, telefone, CPF válido, CEP).
Perfil comparado à média da própria loja: Destaque · Na média · Atenção · Tirador de pedido (mín. 15 atendimentos).

## Benchmark + Compatibilidade
- Benchmark (sss-mastermind): receita por habitante e por dia de loja aberta.
- Compatibilidade (sss-compras + navegador): % de mix em comum (participação no faturamento, por EAN) e de perfil de compra; matriz, ranking, produtos que explicam a semelhança, grupos de lojas gêmeas e oportunidades de sortimento.

## Lojas
Cadastro, edição (nome, CNPJ, token testado antes de salvar; renomear propaga para metas, vínculos e pedidos), ativar/desativar e diagnóstico da API da Central.

## Cache e limites
- Pedidos da Central ficam em `central_cache_dias` (validade de 5 min a 24 h conforme a idade do dia). A primeira carga é feita em partes.
- Consultas pesadas são feitas loja a loja pelo painel, para respeitar o limite de tempo/memória das Edge Functions (erro 546).
