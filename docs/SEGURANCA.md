# Segurança do Insight SSS — checklist

Última revisão: 09/11/2026.

## Onde ficam as chaves

| Chave | Onde fica | Quem usa | Nunca colocar em |
|---|---|---|---|
| `PEDIDOS_API_KEY`, `CENTRAL_API_KEY_PEDIDOS` (Central do Franqueado) | Supabase → Edge Functions → Secrets | funções | GitHub, Hostinger, painel, chat |
| `APP_PASSCODE` (senha do time) | Supabase → Secrets | funções | idem |
| `AQUECER_CHAVE` | Supabase → Secrets **e** GitHub → Actions secrets | pré-aquecimento | código, Hostinger |
| Token VarejOnline de cada loja | tabela `lojas_config` (via tela Lojas) | funções | qualquer arquivo |
| `SUPABASE_SERVICE_ROLE_KEY` | automático no Supabase | funções | **qualquer outro lugar** |
| Chave de IA de cada pessoa (Anthropic, OpenAI, Gemini ou OpenRouter) | só no navegador de quem cadastrou | assistente (vai no cabeçalho `x-ia-chave`, o servidor não grava) | banco, código, chat |
| Chave pública (anon / publishable) | Supabase (o painel busca em `?config=1`) | login no navegador | — é pública por natureza; a proteção são as RLS |

A Hostinger **não precisa de nenhuma chave**: ela só entrega os arquivos do painel (ramo `site`).

## Verificações feitas no código (09/11/2026)
- Histórico do Git (todos os commits): nenhum token, senha, chave de API ou JWT encontrado. Só `.env.example` com valores de exemplo.
- Respostas das funções nunca devolvem tokens das lojas (`listar` lojas seleciona só nome/CNPJ/status).
- Mensagens de erro da VarejOnline não incluem a URL com token.
- Todas as tabelas criadas pelo Insight têm RLS ligada (acesso só pelas funções).
- Senha do time e chave de aquecimento comparadas em tempo constante; tentativa errada espera 0,4 s, 0,8 s, 1,2 s… (até 8 s) por IP.
- Permissão por loja conferida no servidor (franqueado não acessa outra loja nem pelo console do navegador).

## Pendências (fazer no Supabase)
1. **Conferir RLS das tabelas antigas** (`lojas_config`, `metas_faturamento`, `pedidos_vinculos`, `perfil_lojas` e outras). Rode no SQL Editor:
   ```sql
   select c.relname as tabela,
          c.relrowsecurity as rls_ligada,
          (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as politicas
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
   order by rls_ligada, tabela;
   ```
   Qualquer linha com `rls_ligada = false` precisa de: `alter table public.NOME_DA_TABELA enable row level security;`
   (as funções usam a service role e continuam funcionando). Se alguma tabela tiver política liberando `anon`/`public`, revisar.
2. **Ligar `LOGIN_OBRIGATORIO=true`** quando todos tiverem login próprio — enquanto não, quem souber a senha do time entra como administrador.
3. **Trocar a `AQUECER_CHAVE`** por uma gerada só por vocês (a atual passou pelo chat). Mesmo valor no Supabase e no GitHub.
4. **Senha do time forte** (`APP_PASSCODE` com 20+ caracteres) enquanto ela existir.
5. Supabase → Authentication: cadastro público desligado (*Allow new users to sign up* = off) e, se possível, MFA para administradores.
6. Rotacionar a chave da Central (`PEDIDOS_API_KEY`/`CENTRAL_API_KEY_PEDIDOS`) se ela já foi colada em algum lugar fora do Supabase (planilha, e-mail, chat, Hostinger).
