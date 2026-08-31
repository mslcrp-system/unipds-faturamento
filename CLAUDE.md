
# O banco não é deste repo

O banco da UNIPDS (Supabase `rgdjacvmwnsbrczxjngn`) é responsabilidade do **mentor do
banco**, que trabalha em `unipds-banco`. Decisão do Misael em 28/08/2026: os repos do grupo
UNIPDS respondem a ele no que toca ao banco.

**Só o mentor escreve migrations.** Daqui, nunca rode DDL — nem `apply_migration` por MCP,
nem `supabase db push`, nem CREATE/ALTER/DROP pelo SQL Editor. Vale para tabela, coluna,
view, função, índice, RLS, GRANT, role, trigger e cron.

Deste repo você **lê à vontade** e **escreve dado** só pelas portas que o banco expõe: view,
RPC ou Edge Function.

## Precisa de algo no schema?

Escreva um pedido em `unipds-banco/docs/<tema>-pedido-<AAAA-MM-DD>.md` com o que falta, o
SQL que você imagina (mesmo aproximado) e por quê. O mentor responde em
`<tema>-resposta-<data>.md` e aplica. Modelo pronto:
`unipds-banco/docs/mesa-pedido-competencia-2026-08-18.md`.

Não peça por conversa: o pedido escrito é o que explica, um ano depois, por que o campo
existe.

A regra completa está em `unipds-banco/CLAUDE.md`.

---

## Como este repo se chama em cada lugar

- No disco: `unipds-faturamento`
- No GitHub: `mslcrp-system/unipds-faturamento`
- No Vercel: `unipds-fat-conc`

Os nomes divergem entre as camadas em metade do grupo — o de-para completo está em
`unipds-banco/CLAUDE.md`.
