# Insight SSS (antigo Mastermind) — Painel Operacional

Painel de decisão da rede **Santo Santo Santo**: compras, estoque, financeiro, equipe e pedidos para a Central do Franqueado, com dados ao vivo da **VarejOnline** e da **Central do Franqueado**.

**Painel publicado:** https://geovannaaraujosss520.github.io/Mmind/ (GitHub Pages, branch `main`, raiz do repositório).

> ⚠️ **Este repositório é público.** Ele não contém senhas nem tokens — eles ficam nos *Secrets* do Supabase. **Nunca** cole tokens da VarejOnline, chave da Central ou a senha do painel em arquivos daqui.

---

## Estrutura

```
Mmind/
├── index.html                   → o painel (HTML + CSS + JS) — publicado pelo GitHub Pages
├── manifest.json                → "instalar como app"
├── sw.js                        → service worker (cache do casco; dados sempre ao vivo)
├── icons/                       → ícones do app (192 e 512 px)
├── .nojekyll                    → faz o GitHub Pages publicar os arquivos como estão
├── supabase/
│   ├── config.toml
│   ├── functions/
│   │   ├── sss-compras/index.ts → Edge Function: compras, pedidos, vínculos, vendedores, compatibilidade
│   │   └── sss-mastermind/      → Edge Function: estoque, financeiro, sazonal, benchmark, metas, lojas
│   └── migrations/              → SQL das tabelas criadas pelo Mastermind (rodar em ordem)
├── .github/workflows/           → deploy automático (opcional) da Edge Function
├── .env.example                 → lista dos Secrets usados (sem valores reais)
└── docs/MODULOS.md              → o que cada tela faz
```

## Módulos do painel

| Tela | Função | Edge Function |
|---|---|---|
| Central de Decisão | Diagnóstico em 1 clique: ações priorizadas, saúde por loja, projeção do mês, transferências | ambas |
| Compra Recorrente | Recomendação de compra por loja (vendas × estoque × pedidos em andamento) | sss-compras |
| Pedido Central | Pedido sugerido no formato da Central, por fornecedor, com grade de tamanhos e envio pela API | sss-compras |
| Vínculos | Produto da VarejOnline ↔ item da Central (código + variação), válido para a rede toda | sss-compras |
| Compra Sazonal | Compra de época com base em anos anteriores | sss-mastermind |
| Alertas Estoque | Ruptura, excesso e produtos parados | sss-mastermind |
| Financeiro | DRE por loja, metas, projeção de fechamento | sss-mastermind |
| Vendedores | Venda, PA, ticket, mix barato, cliente identificado e cadastros | sss-compras |
| Benchmark | Comparativo justo entre lojas + compatibilidade de mix | ambas |
| Lojas | Cadastro/edição de lojas e diagnóstico da Central | ambas |

Detalhes em [`docs/MODULOS.md`](docs/MODULOS.md).

---

## Como alterar
- **Painel:** edite `index.html` (ou `manifest.json`, `sw.js`, `icons/`) na branch `main`. O GitHub Pages publica sozinho em 1–2 minutos.
  Quem usa o app instalado vê a versão nova ao reabrir (o `sw.js` busca sempre o HTML mais recente).
- **Edge Function / banco:** edite em `supabase/` e publique no Supabase (passo 3 abaixo). Mudar estes arquivos aqui **não** muda o Supabase sozinho, a não ser que o deploy automático esteja ligado.
- Prefira mudanças por *branch* + *pull request*: revisa antes de ir ao ar.

---

## Instalação / atualização

### 1. Banco (Supabase → SQL Editor), em ordem
| Arquivo | Cria |
|---|---|
| `20261103000001_pedidos_sugeridos.sql` | pedidos aprovados no painel |
| `20261104000001_pedidos_sugeridos_envio.sql` | colunas/status do envio à Central |
| `20261104000002_central_cache_dias.sql` | cache diário dos pedidos da Central |
| `20261104000003_vinculos_produto_rede.sql` | vínculos produto ↔ item da Central (rede) |
| `20261105000001_vinculos_grade.sql` | vínculo à grade (produto → todos os tamanhos) |
| `20261105000002_usuarios_painel.sql` | usuários do painel (papel e lojas de cada um) |
| `20261105000003_catalogo_central.sql` | catálogo fixo da Central (itens dos pedidos + planilha) |

Todos usam `if not exists`: rodar de novo não apaga nada.
Tabelas que já existiam antes (`lojas_config`, `pedidos_vinculos`, `metas_faturamento`, `perfil_lojas`) não estão aqui.

### 2. Secrets (Supabase → Edge Functions → Secrets)
| Secret | Obrigatório | Para quê |
|---|---|---|
| `VAREJONLINE_API_BASE` | sim | URL base da API da VarejOnline |
| `APP_PASSCODE` | sim | senha do time (entrada provisória até todos terem login) |
| `LOGIN_OBRIGATORIO` | depois | `true` desliga a senha do time: só entra com e-mail e senha |
| `PEDIDOS_API_KEY` | sim | chave da API da Central (leitura de pedidos) |
| `ALLOWED_ORIGIN` | recomendado | endereço(s) do painel separados por vírgula, sem barra no fim (ex.: `https://geovannaaraujosss520.github.io,https://seu-app.onrender.com`); localhost sempre funciona |
| `CENTRAL_ENVIO_HABILITADO` | para enviar pedidos | `true` libera o envio à Central |
| `CENTRAL_API_KEY_PEDIDOS` | se diferente | chave com permissão `criar_pedido` |
| `CENTRAL_BASE_URL` | não | domínio da Central, se não for `app.centraldofranqueado.com.br` |
| `LIMITE_PEDIDO_SEM_CONFIRMACAO` | não | valor (R$) acima do qual a aprovação pede confirmação extra |
| `FORNECEDORES_GRADE` | não | fornecedores com grade de tamanhos (padrão: `EMPORIUM DA BIJUTERIA`) |

### 3. Edge Functions (`sss-compras` e `sss-mastermind`)
- **Manual:** Supabase → Edge Functions → *nome da função* → Code → colar o `index.ts` da pasta correspondente em `supabase/functions/` → **Deploy**.
- **CLI:** `supabase functions deploy sss-compras --project-ref cyxerqtlkhubrkcjqcmx --no-verify-jwt`
- **Automático (opcional):** crie o secret do repositório **`SUPABASE_ACCESS_TOKEN`** (GitHub → Settings → Secrets and variables → Actions). A cada push em `supabase/functions/`, o workflow *Deploy Edge Functions* publica as duas funções sozinho.

### 4. Painel
Já publicado pelo GitHub Pages a partir da raiz da branch `main` (Settings → Pages → *Deploy from a branch* → `main` / `root`).
Depois de publicar, quem usa o app instalado deve fechar e abrir de novo (ou Ctrl+Shift+R no navegador).

---

## Rodar o painel com Node.js (repositório privado)
No plano gratuito do GitHub, o Pages não funciona com o repositório privado. O `server.js` (sem dependências, Node 18+) serve só o painel (`index.html`, `manifest.json`, `sw.js`, `icons/`) — nunca o resto do repositório.

```bash
node server.js            # http://localhost:3000
PORT=8080 node server.js  # outra porta
```
Para deixar no ar para as lojas, publique em um serviço que roda Node (Render, Railway etc.) com o comando `npm start`. Se o secret `ALLOWED_ORIGIN` estiver configurado no Supabase, troque-o pelo novo endereço.

## Segurança — leia antes de abrir para as lojas
- Acesso por **e-mail e senha** (Supabase Auth). Papéis: **Administrador** (tudo, inclusive Usuários e Lojas), **Equipe** (rede toda, sem Usuários/Lojas), **Franqueado** (só as lojas marcadas — vê, aprova e envia os pedidos delas; dados de vendedores só da própria loja). A permissão é conferida no servidor, não só na tela.
- Usuários são criados pelo administrador na tela **Usuários**, com senha temporária trocada no 1º acesso. Desative o cadastro público em Supabase → Authentication → Sign In / Providers → *Allow new users to sign up* = off.
- Enquanto `LOGIN_OBRIGATORIO` não for `true`, a senha do time (`APP_PASSCODE`) continua entrando como administrador.
- Configure `ALLOWED_ORIGIN` = `https://geovannaaraujosss520.github.io` (sem `/Mmind` no final).
- O envio de pedidos à Central só funciona com `CENTRAL_ENVIO_HABILITADO=true`, sempre com confirmação humana e trava contra duplicidade.

## Pendências conhecidas
- Lista de frete da Central (`/api/v3/order/options`): o frete vem do último pedido do fornecedor quando a lista não é reconhecida.
