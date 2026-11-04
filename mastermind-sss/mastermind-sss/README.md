# Mastermind SSS — Painel Operacional

Painel de decisão da rede **Santo Santo Santo**: compras, estoque, financeiro, equipe e pedidos para a Central do Franqueado, com dados ao vivo da **VarejOnline** e da **Central do Franqueado**.

> ⚠️ **Mantenha este repositório PRIVADO.** O código não tem senhas nem tokens (eles ficam nos *Secrets* do Supabase), mas descreve a operação da rede.

---

## Estrutura

```
mastermind-sss/
├── painel/                      → o app (PWA) que abre no navegador/celular
│   ├── index.html               → todo o painel (HTML + CSS + JS)
│   ├── manifest.json            → "instalar como app"
│   ├── sw.js                    → service worker (cache do casco; dados sempre ao vivo)
│   └── icons/                   → icon-192.png e icon-512.png (copiar da hospedagem atual)
├── supabase/
│   ├── config.toml
│   ├── functions/
│   │   ├── sss-compras/index.ts → Edge Function: compras, pedidos, vínculos, vendedores, compatibilidade
│   │   └── sss-mastermind/      → Edge Function: estoque, financeiro, sazonal, benchmark, lojas (código pendente)
│   └── migrations/              → SQL das tabelas criadas pelo Mastermind (rodar em ordem)
├── .github/workflows/           → automações opcionais de deploy
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

## Como subir este pacote para o GitHub

### Pelo site (sem terminal)
1. Em github.com → **New repository** → nome `mastermind-sss` → marque **Private** → **Create repository**.
2. Na página do repositório vazio, clique em **uploading an existing file**.
3. Arraste **o conteúdo** desta pasta (não a pasta em si) e clique em **Commit changes**.
   - Pastas que começam com ponto (`.github`) podem não ser arrastadas por alguns navegadores. Se faltar, crie manualmente: **Add file → Create new file** → digite `.github/workflows/deploy-sss-compras.yml` e cole o conteúdo.

### Pelo terminal
```bash
cd mastermind-sss
git init -b main
git add .
git commit -m "Mastermind SSS: painel, Edge Function sss-compras e migrações"
git remote add origin https://github.com/SEU-USUARIO/mastermind-sss.git
git push -u origin main
```

---

## Instalação / atualização

### 1. Banco (Supabase → SQL Editor), em ordem
| Arquivo | Cria |
|---|---|
| `20261103000001_pedidos_sugeridos.sql` | pedidos aprovados no painel |
| `20261104000001_pedidos_sugeridos_envio.sql` | colunas/status do envio à Central |
| `20261104000002_central_cache_dias.sql` | cache diário dos pedidos da Central |
| `20261104000003_vinculos_produto_rede.sql` | vínculos produto ↔ item da Central (rede) |

Todos usam `if not exists`: rodar de novo não apaga nada.
Tabelas que já existiam antes do Mastermind (`lojas_config`, `pedidos_vinculos`, metas, `perfil_lojas`) não estão aqui.

### 2. Secrets (Supabase → Edge Functions → Secrets)
| Secret | Obrigatório | Para quê |
|---|---|---|
| `VAREJONLINE_API_BASE` | sim | URL base da API da VarejOnline |
| `APP_PASSCODE` | sim | senha de acesso do painel |
| `PEDIDOS_API_KEY` | sim | chave da API da Central (leitura de pedidos) |
| `ALLOWED_ORIGIN` | recomendado | endereço do painel (bloqueia chamadas de outros sites) |
| `CENTRAL_ENVIO_HABILITADO` | para enviar pedidos | `true` libera o envio à Central |
| `CENTRAL_API_KEY_PEDIDOS` | se diferente | chave com permissão `criar_pedido` |
| `CENTRAL_BASE_URL` | não | domínio da Central, se não for `app.centraldofranqueado.com.br` |
| `LIMITE_PEDIDO_SEM_CONFIRMACAO` | não | valor (R$) acima do qual a aprovação pede confirmação extra |
| `FORNECEDORES_GRADE` | não | fornecedores com grade de tamanhos (padrão: `EMPORIUM DA BIJUTERIA`) |

### 3. Edge Function `sss-compras`
- **Manual:** Supabase → Edge Functions → sss-compras → Code → colar `supabase/functions/sss-compras/index.ts` → **Deploy**.
- **CLI:** `supabase functions deploy sss-compras --project-ref cyxerqtlkhubrkcjqcmx --no-verify-jwt`
- **Automático (opcional):** crie o secret do repositório **`SUPABASE_ACCESS_TOKEN`** (GitHub → Settings → Secrets and variables → Actions). A cada push em `supabase/functions/sss-compras/`, o workflow *Deploy sss-compras* publica sozinho.

### 4. Painel
Publique a pasta `painel/` onde ele já está hospedado (incluindo `icons/`).
Opcional: GitHub Pages pelo workflow *Publicar painel* (Actions → Run workflow). Em repositório privado o Pages exige plano pago.
Depois de publicar, quem usa o app instalado deve fechar e abrir de novo (ou Ctrl+Shift+R no navegador).

---

## Segurança — leia antes de abrir para as lojas
- O acesso é por **uma senha única** (`APP_PASSCODE`). Quem tiver a senha vê todas as lojas, dados de vendedores e clientes, e pode aprovar/enviar pedidos. Próximo passo recomendado: login por usuário (Supabase Auth) com permissão por loja.
- Configure `ALLOWED_ORIGIN` com o endereço do painel.
- O envio de pedidos à Central só funciona com `CENTRAL_ENVIO_HABILITADO=true`, sempre com confirmação humana e trava contra duplicidade.

## Pendências conhecidas
- Exportar o código da `sss-mastermind` para `supabase/functions/sss-mastermind/` (e aplicar nela a leitura de estoque corrigida e a divisão loja a loja contra o erro 546).
- Ícones do PWA (`painel/icons/`) — copiar da hospedagem atual.
- Lista de frete da Central (`/api/v3/order/options`): o frete vem do último pedido do fornecedor quando a lista não é reconhecida.
