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

## Início — Vendido hoje e meta do dia
No topo do Início (loja e rede): **vendido hoje** com atendimentos; **ano passado** no mesmo dia da semana (364 dias antes), até o mesmo horário e no dia inteiro, com a variação; e a **faixa da meta de hoje** = o que falta da meta do mês até ontem ÷ dias de venda que sobram no mês, contando hoje. Dias de venda = segunda a sábado; marcando **Considerar domingo** ao salvar a meta (Financeiro), o domingo entra para aquela loja/mês (coluna `considerar_domingo` em `metas_faturamento`). Domingo sem a opção mostra "não entra na meta". Projeção e "falta por dia" seguem a mesma regra. Na rede, a meta do dia soma as lojas com meta e compara com o vendido nelas.

## Velocidade
Todo dia de vendas lido da VarejOnline fica em `vendas_cache_dias` com validade pela idade: hoje 5 min, ontem 1 h, últimos 7 dias 6 h, mais antigos para sempre. O workflow **Aquecer vendas de hoje** roda a cada 15 min das 8h às 22h45 (Brasília) e deixa ontem/hoje de todas as lojas prontos; o **Aquecer cache do Insight** (5h17) guarda 400 dias.

## Início — Produtos
Quadro no Início (franqueado: a própria loja; franqueadora: rede inteira ou uma loja em "Ver"). **Top 10 mais vendidos** nos últimos 30 dias por modelo (variações somadas), com tendência contra os 30 dias anteriores e, na loja, o estoque atual (aviso "repor" quando o estoque é menor que metade do vendido em 30 dias). **Oportunidades**: produtos com estoque na loja e nenhuma venda há 90 dias ou mais, ordenados pelo custo parado (custo médio das vendas de 12 meses; se nunca vendeu, custo referencial do cadastro), com última venda, valor de venda e atalho "Para quem oferecer" (abre Clientes). Módulo `produtos` da sss-compras.

## Comparativo de vendas
Faturamento **líquido** (valor cobrado − devoluções e trocas de clientes, lidas das entradas DEVOLUCAO_VENDA) e **bruto** (valor cobrado + descontos dos itens), com botão Líquido/Bruto que troca gráfico, ticket e tabelas; atendimentos nas três épocas. Período escolhido (atalhos: hoje, ontem, 7 dias, este mês, mês passado) contra o mesmo período do mês anterior e do ano anterior — por data ou, no ano anterior, pelo mesmo dia da semana (364 dias antes). Indicadores de faturamento, ticket médio, atendimentos e PA com a variação; gráfico de evolução (acumulado ou por dia) de faturamento, ticket ou atendimentos; tabela dia a dia e, para várias lojas, tabela por loja. Módulo `comparativo` da função sss-compras. O Início mostra o ticket médio com a referência do mesmo período do mês anterior. O pré-aquecimento guarda 400 dias de vendas para o ano anterior abrir rápido.

## Clientes
Cadastro dos clientes (telefone, e-mail, aniversário, CEP, bairro, cidade) é lido da VarejOnline um a um (`/terceiros/:id`), só dos clientes do período, e guardado na tabela `clientes_cadastro` (chave = resumo do token + id do cliente; relido após 60 dias) — listas, planilha e Onde moram usam essa tabela e completam o que faltar a cada consulta. Aba **Onde moram** (`acao: 'localizacao'`): usa o endereço desse cadastro, agrupa por cidade e bairro e calcula a distância do CEP de cada cliente até a loja — coordenadas do CEP pela AwesomeAPI (reserva: BrasilAPI), guardadas na tabela `cep_geo`; a loja é localizada pelo CNPJ (BrasilAPI). Mostra metade/80%/90% dos clientes até X km, faixas de distância com o gasto, mapa de calor ou pontos (Leaflet + Leaflet.heat, mapa base OpenStreetMap) com a loja, anéis e círculos por região de CEP (nunca o endereço exato).

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


## Benchmark — Cluster, Performance e Geográfico

- **Mês de baixa**: mês com menor receita nos últimos 12 meses e quanto fica abaixo do mês médio. Só aparece com ~1 ano de vendas (loja nova teria meses vazios). `indicePorMes` = receita de cada mês ÷ mês médio × 100.
- **Cluster**: grupos por padrão de consumo e por época de venda, com pico, baixa e a faixa de 12 meses de cada loja.
- **Performance**: `indicePerformance` = receita por habitante ÷ mediana da rede × 100. Faixas: 120+ acima, 80–119 na média, <80 abaixo.
- **Geográfico**: lojas por porte da cidade (até 100 mil, 100–300 mil, 300 mil–1 milhão, mais de 1 milhão); `vsMediaPortePercent` compara com a média do porte (só quando há 2+ lojas no porte).

## Clientes — prazo ideal de volta e ação comercial

- **Prazo da loja** = mediana dos intervalos entre visitas (15 a 180 dias). **Prazo do cliente** = mediana dos intervalos dele (2+ intervalos); com 1 intervalo, média entre o dele e o da loja; sem volta, o da loja (15 a 365 dias).
- **Situação**: em dia (< 80% do prazo), hora de chamar (80% a 130%), passou do prazo (> 130%), sumiu (> dias de "sumido"). Dentro do prazo = em dia + hora de chamar; ≥ 50% perto do ideal, 30–49% dá para melhorar, < 30% longe.
- Nova aba **Hora de chamar** (hora + passou do prazo, até 300) e colunas "Volta ideal" e "Prazo de volta" na planilha.
- **Ação comercial**: meses de alta (≥ 115 do mês médio) e de baixa (≤ 85), com ações para cada um, o que mais vendeu no próximo mês de alta e quem comprou nesse mês. Precisa de 12 meses de vendas da loja (Ajustes em 12 ou 24 meses).

### Média da rede do prazo de volta

- Tabela `clientes_indicadores` (migração 20261114000002): prazo de volta, % dentro do prazo e recompra de cada loja, sempre na régua padrão (12 meses, sumido = 90 dias, loja com 30+ clientes identificados).
- Preenchida quando alguém abre Clientes com a régua padrão e pelo aquecimento diário (`{"clientesRede":true}`, passo novo em aquecer-cache.yml), que recalcula as lojas com mais de 20 h.
- Média da rede = média dos prazos das lojas atualizadas nos últimos 10 dias (precisa de 3+ outras lojas). Situação: até 90% da média = melhor que a rede; até 115% = na média; acima = longe da rede. Posição 1 = loja onde o cliente volta mais rápido.

## Compras — foto do produto e filtro de fornecedor

- **Foto**: vem do cadastro da VarejOnline (`urlsFotosProduto`, a primeira foto). O painel pede as fotos só das linhas que aparecem na tela (`modulo: 'fotosProdutos'`, até 400 ids por chamada; guardadas 6 h na memória da função). Clicar na foto abre maior. Produto sem foto mostra um quadro cinza.
- **Pedido Central**: seletor de fornecedor mostra um fornecedor por vez (o valor total do topo continua com todos).
- **Compra Recorrente**: cada produto mostra o fornecedor pelo vínculo com o item da Central (catálogo fixo); sem vínculo = "Sem vínculo com a Central"; vínculo marcado como ignorar = "Fora da Central". Filtro de fornecedor e "Só o que comprar".

## Vínculos — grade de cores

- Quando o mesmo código da Central tem 2 ou mais cores do mesmo fornecedor (ex.: MB26 0001 ROSA, 0002 AZUL, 0003 VERDE) e a loja vende tudo num produto só ("DEZENA ... [ROSA, VERDE E AZUL]"), a tela de vínculos oferece **Vincular a todas as cores**.
- O vínculo fica com `grade = true` (mesma coluna da grade de tamanhos/letras). No pedido, a quantidade sugerida é dividida entre as cores pela proporção do que a rede comprou de cada cor em 180 dias, e dá para ajustar no botão "Grade: cores".
- Na Compra Recorrente, pedidos em andamento de qualquer cor desse código descontam da compra do produto.
- Ordem de detecção: grade de tamanhos (fornecedores com grade) > letras > cores.

## Início — Ações do dia (aviso)

- Abre **uma vez por dia por loja** (guardado no navegador), depois que o Início termina de carregar com dados novos. O botão **Ações do dia (N)** no Início reabre a lista; fica com borda vermelha quando há ponto crítico.
- **Franqueado (uma loja)**, em ordem: produtos que vendem e estão zerados (crítico), loja sem meta (crítico), pedido aprovado esperando envio (crítico), projeção abaixo de 90% da meta (crítico abaixo de 75%), quanto falta para a meta de hoje, hoje 15% ou mais abaixo do ano passado no mesmo horário, produtos que vão faltar antes da reposição, mais de 21 dias sem comprar na Central.
- **Franqueadora (rede)**: lojas sem meta, lojas com projeção abaixo de 80% da meta, lojas com pedido aprovado esperando envio, lojas há mais de 21 dias sem comprar na Central, franqueados sem abrir o painel há mais de 7 dias.
- Cada item tem um botão que leva à tela onde se resolve.

## Metas — quem faz o quê

- **Meta da loja** (Financeiro): só a franqueadora (administrador/equipe) cadastra. O servidor já recusava o salvar para franqueado; agora o franqueado vê só a meta, sem o formulário, com um atalho para dividir na Equipe.
- **Meta por vendedor** (Equipe › Metas por vendedor): o franqueado divide a meta da loja. A tela mostra a meta da loja, quanto já foi dividido e quanto falta, com os botões **Dividir pelo que cada um vendeu** (proporção do faturamento do período analisado) e **Dividir igualmente** (arredonda em R$ 10; o último vendedor fica com o resto para fechar a meta).
- Aviso do dia (franqueado): sem meta da loja = atenção ("a franqueadora cadastra"); meta cadastrada mas nenhuma meta por vendedor no mês = "Divida a meta da loja entre os vendedores".

## Início — Alerta de ruptura (franqueado)

- Bloco próprio no Início da loja, logo abaixo dos números do mês: produtos que vendem e vão acabar nos **próximos 15 dias**.
- **Acaba em** = estoque ÷ venda média por dia dos últimos 60 dias (da análise de Compra Recorrente da loja), com a data estimada. Faixas: zerado, até 7 dias, 8 a 15 dias.
- **Pedido a caminho**: quando estoque + pedidos em andamento na Central cobrem mais de 15 dias, o produto vai para o fim da lista com essa etiqueta.
- Ordem: sem cobertura primeiro, depois zerados, depois menos dias, depois quem vende mais em R$. Mostra 10 e "Ver todos". Botão para montar o pedido.
- O aviso do dia ganha o item crítico "N produto(s) acabam em até 7 dias" (sem pedido a caminho); o item "vão faltar antes da próxima reposição" deixa de repetir esses produtos.

## Vínculos — vários itens da Central para um produto

- Quando um produto da loja corresponde a vários itens da Central que não formam uma grade automática (ex.: PULSEIRA CRISTAL cor 22 = 4443.pp|22, 4443.p|22, 4443.m|22, 4443.g|22), marque os itens (sugestões ou busca) e clique em **Vincular os marcados**.
- Grava `chave_central` = primeiro item e `chaves_grade` = os demais (coluna nova: migração `20261116000001_vinculos_varios_itens.sql`). Todos precisam ser do mesmo fornecedor.
- Pedido: a linha vira "Grade: N itens" e a quantidade é dividida entre os itens pela proporção do que a rede pediu de cada um (ajustável). Compra Recorrente: pedido em andamento de qualquer desses itens desconta do produto.
- Vincular um item só (botão Vincular, Confirmar ou um marcado) limpa os itens extras.

## Grade de tamanhos por código (ex.: 4443.XPP / .PP / .P / .M / .G)

- Alguns fornecedores cadastram cada tamanho como um código próprio na Central e a cor na variação (PULSEIRA CRISTAL: 4443.pp|6, 4443.p|6, 4443.m|6…). O sistema reconhece o tamanho no final do código (XXPP, XPP, PP, P, M, G, GG, XG, EG, U…) e monta a grade com os tamanhos da **mesma cor e fornecedor**.
- Ordem de detecção: tamanhos na variação > letras > **tamanhos por código** > cores.
- Vínculos: aparece "Vincular à grade (N tamanhos)". Pedido: "Grade: tamanhos (N)", na ordem dos tamanhos, com a quantidade dividida pela proporção da rede. Compra Recorrente: pedido em andamento de qualquer tamanho da mesma cor desconta do produto.

## Pedido Central — fornecedores sem sugestão (pedido à mão)

- O filtro de fornecedor tem dois grupos: **Com itens sugeridos** e **Sem sugestão para esta loja (pedir à mão)** — todos os fornecedores do catálogo do Insight que não entraram no pedido sugerido (`outrosFornecedores`).
- Ao escolher um deles, o painel busca o catálogo dele (`modulo: 'vinculos', acao: 'itensFornecedor'`, até 600 itens, mais pedidos recentemente primeiro) para digitar quantidades e **Adicionar ao pedido**. Vira um cartão normal do fornecedor (aprovar, copiar, exportar, enviar), com os itens marcados "adicionado à mão".
- Limite: o catálogo do Insight só tem itens pedidos pela rede na Central em 180 dias ou importados pela planilha "Peças da Central".

## Em andamento: pedidos aprovados no Insight

- O "em andamento" de cada produto (Compra Recorrente, Pedido Central, Início) soma: pedidos da Central que não estão em situação final nem cancelados (alterados nos últimos 120 dias) **+ pedidos aprovados no Insight e ainda não lançados na Central** (status aprovado, enviando ou erro no envio, últimos 15 dias), pelo produto da loja de cada item.
- Quantidade sugerida = demanda do período + segurança − estoque − em andamento. Aparecem na lista de pedidos do produto como "Insight …, aprovado no Insight, ainda não lançado".
- Trava extra na aprovação: mesmo fornecedor e loja aprovado nas últimas 72 h pede confirmação.

## Estabilidade do servidor — Início pré-calculado e novas tentativas (nov/2026)

- **Por que oscilava:** cada abertura do Início recalculava as 29 lojas numa única chamada. As funções do Supabase têm limite de 2 s de CPU por chamada (em todos os planos); quando passava, a resposta voltava sem cabeçalhos (erro 546) e o navegador mostrava "Sem resposta do servidor".
- **Início pronto:** o aquecimento de 15 em 15 minutos (`aquecer-hoje.yml`, passo `{"painel":true}`) calcula o painel de todas as lojas e grava em `painel_cache` (chave `rede`). O `modulo: 'painel'` lê esse resultado se for de hoje e tiver menos de 20 min; filtra as lojas do usuário, remove dados de acesso para franqueado, relê na hora os pedidos aprovados no Insight e refaz os totais (`montarRedePainel`). O botão Atualizar manda `recalcular: true` e calcula na hora. Salvar meta apaga o resultado guardado.
- **Novas tentativas:** `chamarEdge` repete sozinho as leituras (sem `acao` ou com listar/buscar/…; nunca `lojaEditar`/`sincronizarCentral`) até 2 vezes (1,5 s e 4 s) em falha de rede ou HTTP 502/503/504/546. Gravações não são repetidas.
- **Erro mais suave:** se o Início já mostra dados e a atualização falha, aparece só um aviso discreto em vez do painel vermelho.
- SQL: `supabase/migrations/20261117000001_painel_cache.sql`.

## Acompanhamento do "Hora de chamar" (nov/2026)

- Cada cartão de cliente tem **WhatsApp** (ao clicar, o contato fica registrado) e **Já chamei** (para telefone, Instagram ou loja). Depois aparece "✓ Chamado hoje / há X dias"; no mesmo dia dá para **desfazer**. Um registro por cliente por dia.
- Na "Hora de chamar", quem foi chamado nos últimos 7 dias desce para o fim da lista.
- Quadro de acompanhamento (90 dias): chamados, quantos voltaram e compraram (até 30 dias depois do contato), % de retorno (sem contar quem foi chamado há menos de 30 dias e ainda não voltou), valor vendido para eles e os nomes de quem voltou.
- Franqueadora: botão **Comparar as lojas** (`clientes`/`contatosRede`): chamados em 30 dias por loja + retorno de 90 dias (gravado em `clientes_indicadores` quando a loja abre Clientes e no aquecimento diário).
- Servidor: `moduloClientes` ações `registrarContato` / `desfazerContato` / `contatosRede`; tabela `contatos_clientes`.

## Deploy das funções com versão fixa do Supabase CLI (nov/2026)

- `deploy-edge-functions.yml` usa `supabase/setup-cli@v1` com `version: 3.2.0` em vez de `latest`. Com `latest`, a ação consultava a API do GitHub para descobrir a versão e às vezes falhava por limite de consultas, o que exigia rodar o deploy de novo. Para atualizar, troque o número pela versão desejada.

## Vínculos: lista fixa de produtos (nov/2026)

- A tela Vínculos abre sozinha com a **lista fixa** (`vinculos` / `listaFixa`): todos os produtos que as lojas já venderam, guardados em `painel_cache` (uma linha por loja, chave `vinc_loja:<loja>`), com os vínculos e status calculados na hora.
- Toda leitura de vendas de uma loja (`produtosVendidos`, usada pelo botão **Atualizar lista agora** e pelo aquecimento) junta o que leu com o que já estava guardado: quem parou de vender continua na lista com "sem venda em 90 dias"; sai só depois de 1 ano sem aparecer.
- Aquecimento diário (`aquecer-cache.yml`, passo `{"vinculosRede":true}`) atualiza a lista de cada loja, continuando de onde parou.
- O atalho "abrir no Vínculos" (tela de pedido) usa a lista fixa; se o produto ainda não estiver nela, lê as vendas na hora.
- Usa a tabela `painel_cache` (SQL 20261117000001); não precisa de SQL novo.

## Equipe: perfil com volume por dia trabalhado (nov/2026)

- Antes, o perfil olhava só PA e ticket: quem atendia metade dos clientes podia sair "Destaque".
- Agora cada vendedor tem **Dias com venda** e **Venda por dia** (faturamento ÷ dias com venda, + atendimentos por dia). A referência é a **média da loja por vendedor por dia** (soma do faturamento ÷ soma dos dias trabalhados dos vendedores com 15+ atendimentos). Dividir por dias evita prejudicar quem trabalhou menos dias (folga, meio período, férias, gerente).
- Perfis (15+ atendimentos): Tirador de pedido (igual antes) · **Destaque** = PA ≥ 110% e ticket ≥ 105% da loja **e** venda/dia ≥ 100% da média · **Atende bem, vende pouco** = PA e ticket altos com venda/dia abaixo · **Puxa as vendas** = PA e ticket na média e venda/dia ≥ 115% · **Muito volume, ticket baixo** = PA ou ticket < 90% com venda/dia ≥ 115% · Atenção = PA ou ticket < 90% · **Pouca venda por dia** = PA e ticket na média e venda/dia < 75% · Na média.
- Cada vendedor ganha uma leitura em uma frase (`leitura`, no título do perfil) e a loja devolve `referenciaDia`.

## Equipe: horários de pico (nov/2026)

- `moduloVendedores` monta, por loja e por vendedor, a grade dia da semana × hora (atendimentos e faturamento) a partir da data/hora de cada venda (`horarios`): horas com venda, número de cada dia da semana no período, os 3 blocos de 2 horas mais fortes da loja (média por dia) com quem mais vende em cada um, e para cada vendedor o dia e o horário mais fortes e a % das vendas feita nos horários fortes da loja (quintil de cima).
- Tela Equipe (loja): seção **Horários de pico** com mapa de calor (média por dia de cada dia da semana; Loja inteira ou um vendedor; Faturamento ou Atendimentos), cartões dos 3 picos e tabela por vendedor.

## Fornecedores — painel da franqueadora (nov/2026)

- Menu **Rede → Fornecedores** (escondido para franqueado). Servidor: `modulo: 'fornecedores'` (papel admin/equipe).
  - `acao: 'compras'` (uma chamada): pedidos da Central do período (até 180 dias atrás; sem cancelados), por fornecedor × loja × código.
  - `acao: 'vendasLoja'` (por loja, em trechos de até 31 dias; o painel divide o trecho ao meio se der 546): vendas somadas por produto + faturamento, peças e custo da loja. `acao: 'mapearLoja'`: liga os produtos ao item/fornecedor da Central pela regra da tela Vínculos (`casarProduto`). O painel lê as vendas de todas as lojas e liga os produtos de uma vez (cada código consultado uma vez, em lotes de 2.500; divide o lote se der 546) e depois junta por fornecedor.
  - `acao: 'frete'` / `'salvarFrete'`: frete médio por fornecedor (% do pedido), guardado em `painel_cache` chave `frete_fornecedores`.
- Por fornecedor: comprado (R$, peças, pedidos, lojas, último pedido), vendido (R$, peças), **giro** (peças vendidas ÷ compradas), **% do faturamento** das lojas analisadas, margem (venda − custo VarejOnline), frete %, **retorno** = venda ÷ (compra + frete) e leitura: Compensa (giro ≥ 70% e retorno ≥ 2×), Revisar (giro < 40% ou retorno < 1,5×), Atenção (entre os dois); "compra recente" quando o último pedido tem menos de 30 dias.
- Detalhe (clique na linha): por loja (comprou, vendeu, giro, % do faturamento da loja) e por produto da Central (40 mais comprados), mais a lista de produtos comprados sem nenhuma venda.
- Resumo mostra a **cobertura**: quanto do faturamento ficou ligado a algum fornecedor (depende dos vínculos).
- **Fornecedor de insumo** (embalagem, material de loja): marcado no detalhe (`salvarInsumo`, `painel_cache` chave `fornecedores_insumo`); vai para um grupo separado e sai dos totais e da leitura de revenda.

- **Esforço × retorno** (nov/2026): `vendasLoja` devolve também peças e custo totais da loja. Por fornecedor: % das peças vendidas, % do faturamento, % do lucro bruto (venda − custo VarejOnline), preço médio e lucro bruto por peça contra a média das lojas. Índice = % do faturamento ÷ % das peças: < 0,75 "Vende barato"; > 1,25 "Puxa o ticket"; "Não sustenta" = vende barato e lucro por peça < 60% da média (entra em Revisar). Quadro "Onde as lojas fazem força para pouco retorno" com os 5 maiores casos; no detalhe por loja, % das peças da loja.
- **Giro desta compra** (nov/2026): em cada loja × produto da Central, a venda conta até a quantidade comprada no período (`min(comprado, vendido)`); o excesso é "estoque antigo" e fica fora do giro (0–100%). **Markup** = venda dessas peças ÷ (custo de compra na Central × (1 + frete)); **já voltou** = venda dessas peças ÷ (valor comprado × (1 + frete)). Leitura: Revisar = não sustenta, giro < 35% ou markup < 1,8×; Compensa = giro ≥ 60% e markup ≥ 2,2×. A compra considera só as lojas cujas vendas foram lidas.
- **% do faturamento desta compra** (nov/2026): "Vendido", "% do faturamento", "% das peças", lucro e Esforço × retorno usam só as peças desta compra que já venderam (`daCompra`); a venda de estoque antigo do mesmo fornecedor aparece à parte (subtítulo e dica). Fornecedor sem pedido no período usa a venda total.
- **Faturamento por peça na leitura** (nov/2026): markup alto não basta (medalha R$ 0,50 → R$ 1,50 = 3×, mas 10 peças faturam R$ 15). Revisar também quando a peça do fornecedor fatura menos da metade da peça média da rede (índice % faturamento ÷ % peças < 0,5, com 20+ peças); Compensa exige índice ≥ 0,75. No detalhe: coluna "R$ por peça" por produto (vermelho abaixo de metade da média) e aviso de quanto das peças vendidas são desses produtos baratos.
- **Giro relativo à rede** (nov/2026): o giro de cada fornecedor é comparado com o giro médio da rede no mesmo período (peças desta compra vendidas ÷ compradas, sem insumos), mostrado no resumo. Revisar abaixo de 60% do giro da rede; Compensa igual ou acima. Cor da coluna Giro segue a mesma régua.
- **Até 13 meses** (nov/2026): `compras` aceita data inicial até 400 dias atrás; trechos de até 62 dias usam `centralIntervalo` (lê os dias guardados em `central_cache_dias` e busca na Central só os que faltam; dias com mais de 60 dias já guardados não são rebuscados). O painel pede as compras de mês em mês (repete o trecho enquanto houver dias pendentes) e soma. Atalhos 90 dias / 6 meses / 12 meses.

## Ligação produto → Central mais flexível por código (nov/2026)

- `indexarCatalogo` passa a indexar códigos alternativos de cada item da Central: partes de códigos com barra ("0972/8062" vale 0972 e 8062) e códigos da loja escritos na descrição ("COLAR FIO ESPÍRITO SANTO 0104.0001"). Também indexa a base do código (antes do ponto).
- `casarProduto`, depois do código exato: tenta o código alternativo (via "código") e, por último, a base do código da loja ("8062.0001" → 8062) contra a base da Central, só quando a descrição é parecida (Jaccard ≥ 0,4) — via "código (base)", que na tela Vínculos aparece como **A conferir**.
- Motivo: na análise de fornecedores, vendas da EMPORIUM (ex.: 8062.0001 × "0972/8062") ficavam sem fornecedor e o giro dela aparecia baixo.
- **Fornecedor pela MARCA** (nov/2026): `fornecedores`/`marcas` lê a categoria de nível MARCA do cadastro da VarejOnline (`/produtos?idsProdutos`, lotes de 50, 55 s por chamada) e guarda para a rede em `painel_cache` chave `marcas_rede` (chave do produto → marca). O painel usa a marca quando o produto não liga por vínculo/código/descrição: marca → fornecedor pela maioria (≥ 60%) da venda já ligada dessa marca, ou pelo nome quando a marca não tem nada ligado (todas as palavras da marca no nome do fornecedor, um só candidato). Essa venda entra no total e no % do faturamento; no giro conta por loja até o que sobrou da compra do fornecedor naquela loja. A primeira análise lê as marcas de todos os produtos (demora mais); depois só os novos. Ação `cadastroProdutos` (leitura do cadastro completo de até 50 produtos) para conferência.
- **Quantas vezes mais esforço** (nov/2026): peças vendidas por R$ 1.000 faturados (`pecasPorMil`) e quantas vezes isso é a média da rede (`vezesEsforco`), na coluna Esforço × retorno; quadro "Comparar o esforço entre dois fornecedores" (padrão: os dois que mais compraram) com as peças necessárias para faturar R$ 10 mil e o lucro bruto de cada um.
- **Marcas por fornecedor**: ordem marca → fornecedor = marcas ligadas à mão (detalhe do fornecedor, `salvarMarcas`, `painel_cache` chave `marcas_fornecedor`) → nome da marca dentro do nome do fornecedor ("EA" → EA PRESENTES) → maioria (≥ 60%) da venda ligada. `listaMarcas` devolve as marcas já lidas com o número de produtos.
- **Top 10 de cada fornecedor** (nov/2026): no detalhe, os 10 produtos com maior faturamento no período (todas as lojas analisadas, inclusive estoque antigo e produtos ligados só pela marca), com peças, faturamento, % do fornecedor, R$ por peça (vermelho abaixo de metade da peça média), peças compradas no período e giro. A tabela por produto passa a listar só o que foi comprado no período.

### Fornecedores: código com zeros à esquerda
Algumas lojas cadastram o código da Central com zeros na frente (ex.: `00003D-CA-001` na loja = `3D-CA-001` na Central, Mini Jesus da ANA PAULA). A ligação agora compara também o código sem os zeros à esquerda. Quando o que sobra é só número (ex.: `972` × `0972`), exige descrição parecida para não juntar produtos diferentes.

### Fornecedores: tela mais precisa (giro maduro, itens a conferir, situação com motivo)
- **Giro só com compras de mais de 60 dias** (`FORN_DIAS_RECENTE`): a compra recente ainda está vendendo e entrava como "não vendida". As compras dos últimos 60 dias são lidas à parte (`comprasFornecedoresPorMes` no trecho final) e descontadas por loja e produto. A compra recente aparece no Comprado e no resumo.
- **Parado** = custo das peças compradas há mais de 60 dias sem venda.
- **Itens a conferir**: produto vendido, em média, por menos de 1,1× o custo da Central (vínculo errado, display/kit, caixa × unidade). Sai da conta do fornecedor e vai para uma lista no fim da tela.
- **Situação**: uma regra decide, na ordem Revisar (giro < 60% da rede) → Margem baixa (markup < 1,8×) → Gira abaixo da rede (60–90%) → Gira, peça barata (peça média < 75% da rede) → Compensa; Compra recente quando quase tudo foi comprado nos últimos 60 dias. O motivo aparece na linha.
- Tabela: Comprado → Vendeu (giro) → Parado → % do faturamento → R$ por peça (× esforço médio) → Situação. Frete, markup, "já voltou" e lucro bruto foram para o detalhe.

### Fornecedores: unidades no pacote
Item da Central vendido em pacote/caixa e vendido em unidades na loja (ex.: SANTITAS PACK = 27). Na lista **Itens a conferir**, a coluna "Unidades no pacote" salva o número (ação `salvarPacote`, `painel_cache` chave `pacote_itens_central`, `{ CODIGO: n }`, vale para a rede). A tela multiplica a compra e divide o custo por `n` e recalcula na hora, sem ler tudo de novo.

### Fornecedores: Visão geral × Por fornecedor
A tela tem duas abas. **Visão geral**: resumo da rede, situações, comparador de esforço, tabela de fornecedores e itens a conferir; clicar num fornecedor abre a outra aba. **Por fornecedor** (com seletor): situação e motivo, números principais (comprado, giro, parado, % do faturamento, R$ por peça, markup, lucro por peça), gráfico **compra × venda mês a mês** (trechos de ~1 mês, os mesmos da leitura; `mesCompra`/`mesVenda`), itens a conferir do fornecedor com unidades no pacote, e o detalhe (top 10, por loja com valor parado, por produto, frete, marcas, insumo).

### Visão do franqueado (revisão para apresentação)
- Rótulos "— rede"/"rede toda" viram "sua loja"/"suas lojas" para o franqueado (`REDE()`); "Ranking da rede" vira "Ranking da equipe"; "Lojas (vazio = todas)" vira "Lojas (vazio = suas lojas)".
- Escondidos para o franqueado: botões "Ver lojas configuradas", a opção técnica "Quantidade da Central é em embalagens", o diagnóstico técnico do estoque (só aparece se houver problema) e a aba "Comparativo de lojas" quando ele tem uma loja só.
- Central de Decisão: quando o DRE, o estoque ou as compras não carregam, os cartões mostram "—" com o aviso, em vez de R$ 0,00.
- Equipe: a lista de cadastros incompletos de clientes fica recolhida.
- Financeiro: a meta somada usa só as lojas analisadas (antes somava a meta da rede inteira mesmo filtrando uma loja: "R$ 45 mil de R$ 2,3 mi"). Aba "DRE da loja" para franqueado de uma loja.
- Central: "vs última análise" compara só com a última análise das mesmas lojas; capital parado mostra "—" quando há itens parados mas sem custo conhecido.
- Estoque: "Estoque baixo" mostra primeiro os produtos que vendem (≥ 2 por mês), do que mais vende para o que menos vende; os que quase não vendem ficam atrás de um botão.
- Sazonal: com uma loja só, sem a opção "Rede toda".

### DRE inativo para o franqueado (por enquanto)
`DRE_LIBERADO()` é falso para o franqueado: a tela Financeiro some do menu, o botão "Ver financeiro" sai do Início e a Central de Decisão deixa de mostrar resultado operacional, margens e as ações de margem/prejuízo. Faturamento do mês, metas e projeção continuam (vêm do mesmo módulo). Para reativar, fazer `DRE_LIBERADO` devolver `true` e tirar `'financeiro'` da lista `ocultar` do franqueado em `aplicarPerfil`.
- Central: alertas de prejuízo por falta de venda (valem com o DRE inativo): **Perdendo venda** (produtos que vendem e estão zerados, em R$ por dia e em 30 dias) e **Dinheiro parado** (excesso + sem venda, vira "atenção" quando passa de 10% do faturamento do mês). O cartão de ruptura mostra também a venda perdida por dia.

### Ruptura com prazo do fornecedor ("pedir até")
O alerta de ruptura do Início passou a dizer **quando pedir**, não só quando acaba: pedir até = dia em que acaba − prazo de entrega do fornecedor − 2 dias (montar/aprovar). Prazo do fornecedor (`prazosFornecedores`, ação `recorrente` com `prazos: true` ou `soPrazos: true`): mediana real dos pedidos entregues da Central (180 dias, ao menos 2 pedidos); senão o maior número do prazo informado ("20 A 30 DIAS" = 30); senão 15 dias (marcado com *). Situações: Ruptura (zerado), Pedir já (o pedido de hoje chega depois de acabar; mostra quantos dias fica sem), Pedir hoje (até 2 dias), Pedir esta semana (até 7 dias), Pedido a caminho (o que está em andamento segura até a próxima entrega). Só produtos que vendem ao menos 2 por mês. A Central de Decisão ganhou o alerta "N produtos precisam ser pedidos hoje" com a venda em risco até o pedido chegar.
