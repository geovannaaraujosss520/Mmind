# Módulos do Insight SSS (antigo Mastermind)

## Central de Decisão
Roda em paralelo Compras, Estoque, DRE do mês + metas, Vendedores (e Benchmark, opcional) e entrega:
- **Ações priorizadas** (Crítico / Atenção / Oportunidade) com impacto em R$: ruptura, meta projetada abaixo, prejuízo operacional, margem abaixo da rede, capital parado, transferências, pedidos da Central parados ou atrasados, mix barato, cliente não identificado, cadastros incompletos.
- **Nota de saúde 0–100 por loja** = meta projetada (30) + margem operacional (30) + ruptura (25) + excesso/parado (15).
- **Ritmo do mês**: projeção de fechamento × meta e quanto precisa vender por dia.
- **Resumo executivo** para copiar e enviar.

## Compra Recorrente
Venda média × período alvo × crescimento + segurança − estoque − pedidos em andamento na Central.
Lê as vendas em janelas paralelas e o estoque da unidade (com diagnóstico de cobertura). Pedidos em andamento são descontados por item e variação.

## Pedido Central
1. Etapa 1: necessidade da loja (Compra Recorrente).
2. Etapa 2: converte em itens da Central usando os **Vínculos**, separa por fornecedor, aplica mínimo/máximo/embalagem.
3. Revisão: quantidades, variação, **grade de tamanhos** (fornecedores em `FORNECEDORES_GRADE`) com distribuição pela proporção da rede.
4. **Retorno do pedido**: quanto volta em vendas (preço médio cobrado pela loja), lucro bruto e margem, venda em risco se não pedir (e quanto o pedido protege), quanto a loja perde por dia com itens zerados e até o pedido chegar — no total e por fornecedor, recalculado a cada ajuste.
5. Aprovação (com trava de duplicidade e limite de valor).
6. Envio pela API `POST /api/v3/cart/finishOrders` com conferência de frete, pagamento e preço; ou lançamento manual com confirmação automática quando o pedido aparece na Central.

## Vínculos de produtos
Produto da VarejOnline (código do sistema) ↔ item da Central (código + variação + tamanho), **válido para a rede inteira**.
Ordem de ligação: vínculo confirmado → vínculo antigo por código → código igual → descrição igual. Variações por cor e tamanho (referência da variação, P/M/G, medidas).
Status: Confirmado · Por código · Conferir · Sem vínculo · Fora da Central.
**Vínculo à grade** (fornecedores em `FORNECEDORES_GRADE`): quando a loja tem um produto só e a Central tem vários tamanhos (ex.: colar 35/38/42/45/50 cm), o produto é ligado a todos os tamanhos da mesma cor; o pedido distribui a quantidade pela proporção da rede e os pedidos em andamento de qualquer tamanho são descontados.

**Vínculo a todas as letras** (qualquer fornecedor): quando a Central tem o mesmo produto de A a Z, cada letra com código próprio (ex.: COLAR CHOKER DE CRISTAL 38CM E PINGENTE LETRA A…Z, Glamour), e a loja tem um produto só ("LETRA ALFABETO"), o produto é ligado a todas as letras da mesma cor. O pedido distribui a quantidade entre as letras pela proporção da rede e desconta pedidos em andamento de qualquer letra.

**Catálogo fixo** (`catalogo_central`): todo item visto nos pedidos fica guardado (com idProduto/unidade para o envio pela API), e a planilha "Peças da Central" pode ser importada na tela de Vínculos — importar de novo só acrescenta os novos e atualiza o custo. Itens que só vieram da planilha entram no pedido sugerido, mas o envio pela API exige que o item já tenha aparecido em algum pedido (senão, lançamento manual).
**Importar vínculos conferidos**: a planilha de conferência (coluna Aprovar = SIM) é carregada em lote na mesma tela.

## Início
- Franqueadora: Visão da rede — faturado no mês, % da meta, projeção, compras na Central, alertas (abaixo do ritmo, sem comprar há 21+ dias, pedidos a enviar, franqueado sem entrar há 7+ dias) e tabela por loja com último acesso.
- Franqueado: Minha loja — barra da meta, falta por dia, ontem, ticket, PA, última compra, produtos zerados (R$/dia), o que comprar e atalhos.

## Assistente de IA
Botão "Assistente" (canto inferior direito, em todas as telas) abre uma conversa. Cada pessoa usa a **própria chave da Anthropic** (console.anthropic.com → API Keys; uso cobrado na conta dela), guardada só no navegador e enviada no cabeçalho `x-ia-chave` a cada pergunta — o servidor não grava nem registra. O módulo `assistente` (sss-compras) roda o Claude com ferramentas que consultam os módulos do Insight com o mesmo acesso do usuário (franqueado só vê as próprias lojas): resumo do mês, comparativo, produtos (top 10 e parados), clientes (sumidos, aniversariantes, para quem oferecer), equipe e estoque/compra. Modelos: Sonnet (padrão), Haiku, Opus.

## Início — Produtos
Quadro no Início (franqueado: a própria loja; franqueadora: rede inteira ou uma loja em "Ver"). **Top 10 mais vendidos** nos últimos 30 dias por modelo (variações somadas), com tendência contra os 30 dias anteriores e, na loja, o estoque atual (aviso "repor" quando o estoque é menor que metade do vendido em 30 dias). **Oportunidades**: produtos com estoque na loja e nenhuma venda há 90 dias ou mais, ordenados pelo custo parado (custo médio das vendas de 12 meses; se nunca vendeu, custo referencial do cadastro), com última venda, valor de venda e atalho "Para quem oferecer" (abre Clientes). Módulo `produtos` da sss-compras.

## Comparativo de vendas
Faturamento **líquido** (valor cobrado − devoluções e trocas de clientes, lidas das entradas DEVOLUCAO_VENDA) e **bruto** (valor cobrado + descontos dos itens), com botão Líquido/Bruto que troca gráfico, ticket e tabelas; atendimentos nas três épocas. Período escolhido (atalhos: hoje, ontem, 7 dias, este mês, mês passado) contra o mesmo período do mês anterior e do ano anterior — por data ou, no ano anterior, pelo mesmo dia da semana (364 dias antes). Indicadores de faturamento, ticket médio, atendimentos e PA com a variação; gráfico de evolução (acumulado ou por dia) de faturamento, ticket ou atendimentos; tabela dia a dia e, para várias lojas, tabela por loja. Módulo `comparativo` da função sss-compras. O Início mostra o ticket médio com a referência do mesmo período do mês anterior. O pré-aquecimento guarda 400 dias de vendas para o ano anterior abrir rápido.

## Clientes
Tela simples para o franqueado: frases-resumo, abas de tarefas (Chamar de volta, Aniversariantes do mês, Melhores clientes, Oferecer uma peça) com cartões, sugestão de peça por cliente (a que mais vende na categoria preferida e ele ainda não levou), WhatsApp com mensagem pronta. Os números completos ficam em "Ver números detalhados". Botão "Baixar planilha" gera um .xlsx (no navegador) com abas Todos os clientes, Chamar de volta, Aniversariantes, Melhores clientes e Oferecer (se buscou uma peça), com telefone, link do WhatsApp, e-mail, aniversário e perfil; os contatos de todos vêm do cadastro de clientes da VarejOnline lido em páginas (`exportar: true`). Uma loja por vez, últimos 6/12/24 meses, só vendas com cliente identificado (CPF/CNPJ válido; sem consumidor final, fornecedores e prestadores). Mostra clientes no período, ativos em 90 dias, novos, recompra (2+ visitas), quem voltou em até 90 dias, tempo mediano até voltar, receita e ticket de quem volta × 1 visita, distribuição por última compra / visitas / intervalo. Listas: **clientes que sumiram** (mais de 60/90/120/180 dias, ordenados por gasto), **melhores clientes** e **para quem oferecer** um produto: clientes que compram a mesma categoria ou levaram peças que costumam sair junto com ele, que ainda não compraram aquele modelo, ordenados por afinidade de categoria, faixa de preço, recência e frequência, com o motivo. Telefone/WhatsApp e aniversário vêm do cadastro da VarejOnline (`/terceiros/:id`, só de quem aparece nas listas). Módulo `clientes` da sss-compras.

## Equipe (Vendedores)
- Metas do mês por vendedor (franqueado define para as próprias lojas), com % atingido, falta e falta por dia; botão Mês atual.
Por vendedor e loja, em período de/até: faturamento, atendimentos, PA, ticket, preço médio da peça, % de peças abaixo do preço-limite (alerta a partir de 60%), atendimentos de 1 peça, desconto, % de vendas com cliente identificado e cadastros novos completos (nome completo, telefone, CPF válido, CEP).
Perfil comparado à média da própria loja: Destaque · Na média · Atenção · Tirador de pedido (mín. 15 atendimentos).

## Benchmark + Compatibilidade
- Benchmark (sss-mastermind): receita por habitante e por dia de loja aberta.
- Compatibilidade (sss-compras + navegador): % de mix em comum (participação no faturamento, por EAN) e de perfil de compra; matriz, ranking, produtos que explicam a semelhança, grupos de lojas gêmeas e oportunidades de sortimento.

## Lojas
Cadastro, edição (nome, CNPJ, token testado antes de salvar; renomear propaga para metas, vínculos e pedidos), ativar/desativar e diagnóstico da API da Central.

### Duas unidades com o mesmo token
Brasília, Goiânia e Ribeirão têm 2 unidades usando o mesmo token da VarejOnline (CNPJs diferentes). Quando duas lojas ativas têm o mesmo token, cada uma é separada pelo **CNPJ cadastrado em Lojas**: o sistema acha a entidade da VarejOnline com aquele CNPJ (pelas vendas recentes ou pelo cadastro de empresas) e passa a pedir vendas, estoque e contas a pagar só dela (`entidades=`). Sem CNPJ, ou com CNPJ que não existe na conta, a loja mostra o aviso para corrigir o CNPJ. O cache antigo dessas lojas (as duas unidades somadas) é descartado e baixado de novo, já separado.

## Cache e limites
- Vendas da VarejOnline ficam em `vendas_cache_dias` por loja e dia: dia fechado não é baixado de novo; ontem e hoje sempre ao vivo; dias da última semana são relidos após 6 h. Pré-aquecimento diário às 5h17 (workflow *Aquecer cache do Insight*).
- Estoque (saldos) reaproveitado por 10 minutos na memória da função.
- O painel mostra na hora o último resultado de cada tela (mesmos filtros, até 24 h, apagado ao sair) enquanto atualiza, e o tempo de cada consulta (VarejOnline, cache, Central).
- Pedidos da Central ficam em `central_cache_dias` (validade de 5 min a 24 h conforme a idade do dia). A primeira carga é feita em partes.
- Consultas pesadas são feitas loja a loja pelo painel, para respeitar o limite de tempo/memória das Edge Functions (erro 546).

## Usuários e acesso
- Login por e-mail e senha; senha temporária gerada pelo administrador e trocada no 1º acesso.
- **Administrador**: tudo. **Equipe**: rede toda, sem Usuários e Lojas. **Franqueado**: só as lojas dele (Central de Decisão, compras, pedidos, estoque, financeiro, vendedores); sem Benchmark, Vínculos, Lojas e Usuários.
- Quem aprova/envia um pedido fica registrado com o nome do usuário logado.
- `LOGIN_OBRIGATORIO=true` desliga a senha do time.

## DRE importado (Financeiro)
- Importa a planilha de fluxo de caixa / DRE gerencial da loja (aba com uma coluna por mês, ex.: "DFC 2026"); a loja é reconhecida pelo nome do arquivo.
- Cada mês importado substitui o anterior daquela loja. Meses sem valores são ignorados.
- No "DRE por Loja", a planilha é comparada linha a linha com o DRE do sistema: linhas iguais, diferentes (lado a lado, com a diferença) e as que só existem na planilha ou só no sistema.
