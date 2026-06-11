# Adendo à solicitação — Conciliação v3 (splits, reembolsos, régua de divergência)

**Data:** 2026-06-11
**Pré-requisito:** Conciliação v2 aplicada (confirmada em produção 2026-06-11).
**Origem:** análise dos dados reais de maio/IA pós-v2 (786 deals × 855 contratos, 760 links).

Três achados da avaliação, em ordem de impacto. Os itens A e B alteram a **mesma função** (`gerar_snapshot_voomp`) — apresentados como uma única versão v3 consolidada no final.

---

## Achado A — Pagamento dividido gera falso MATERIAL + falso órfão (maior impacto)

**Evidência (maio/IA):** 13 dos 15 links MATERIAIS têm o Voomp valendo **exatamente metade** do deal Pipe — todos venda Único. Cruzamento por CPF confirmou **9 casos** onde a outra metade está nos órfãos Voomp e a soma das duas metades fecha com o deal ao centavo:

| Aluno | Deal Pipe | Metade casada | Metade órfã | Soma |
|---|---|---|---|---|
| Jayme R. K. P. Silva | 5.207,12* | 2.603,56 | 2.603,56 | 5.207,12 ✓ |
| A. M. Ribeiro Garrefa | 5.207,12 | 2.603,56 | 2.603,56 | 5.207,12 ✓ |
| Bruno M. Nogueira | 4.338,54 | 2.169,27 | 2.169,27 | 4.338,54 ✓ |
| … (mais 6 idênticos) | | | | |

O aluno paga a venda à vista em 2 cobranças (2 cartões), a Voomp emite 2 vendas, e o snapshot trata cada metade como um contrato. Os 4 MATERIAIS restantes com o mesmo padrão provavelmente têm a 2ª metade paga no mês seguinte.

**Solução:** no `gerar_snapshot_voomp`, agrupar as cobranças **Único** por `(student_id, product_id, reembolsado)` dentro do mês, somando valores. Vira 1 linha de snapshot por venda real, com rastro das vendas agrupadas.

**Suporte de schema (colunas novas — apêndice, posições finais):**

```sql
ALTER TABLE conciliacao.voomp_snapshot
  ADD COLUMN qtd_cobrancas    integer NOT NULL DEFAULT 1,
  ADD COLUMN vendas_agrupadas text[];
```

`voomp_venda_id` passa a ser a venda principal (maior valor); `vendas_agrupadas` carrega todas para auditoria.

**Risco aceito (documentado):** aluno que compra legitimamente o mesmo produto 2× no mesmo mês seria fundido. Nesse caso o lado Pipe teria 2 deals e a divergência apareceria como MATERIAL de +100% — detectável na revisão. Caso raro; o padrão dominante (9–13/mês) é split.

---

## Achado B — Reembolsos zerados no snapshot (diverge da regra de negócio acordada)

**Evidência (maio/IA):**

| Origem | Linhas reembolsadas | Soma valor_cobrado |
|---|---|---|
| `unipds.charges` (fonte) | 50 | **R$ 184.195,84** |
| `conciliacao.voomp_snapshot` | 40 | **R$ 0,00** |

A função em produção zera `valor_cobrado`/`valor_recebido` dos reembolsados. A regra confirmada pelo usuário é outra:

> *"o valor é valor_recebido × recorrência total, pq estamos montando o faturamento gerencial"* e *"consideramos esses valores [dos reembolsos] pq há uma outra consulta olhando os reembolsos"*.

Ou seja: **reembolsado entra com valor gerencial cheio + flag `reembolsado = true`**. O card "Reembolsos" da UI mostra o total flagado como redutor explícito; o detalhe do estorno real fica na consulta própria de reembolsos (`unipds.refunds`). Com o zeramento atual, os R$184 mil ficam invisíveis no painel.

**Solução:** na v3, usar os valores das charges diretamente (sem zerar). `valor_recebido` de reembolsado já vem 0 da fonte — o líquido fica naturalmente zerado; o **bruto** (`valor_cobrado`) preserva o valor cheio.

**Nota:** os 50→40 são efeito da deduplicação com prioridade PAGO (contrato com parcela 1 paga E reembolsada conta como pago) — comportamento correto, sem ação.

---

## Achado C — Faixa cega na régua de divergência

**Evidência:** divergência de **R$ 7,35 (0,14%)** classificada como MATERIAL (caso venda 1620157). A régua atual pula de CENTAVOS (< R$1) direto para CUPOM (5–20%) — tudo entre R$1 e 5% cai em MATERIAL, mesmo trivial.

**Solução:** classe intermediária `PEQUENA` (≥ R$1 e < 5%):

```sql
-- Constraint (confirmar nome real com \d conciliacao.conciliacao_links)
ALTER TABLE conciliacao.conciliacao_links
  DROP CONSTRAINT conciliacao_links_divergencia_classe_check;
ALTER TABLE conciliacao.conciliacao_links
  ADD CONSTRAINT conciliacao_links_divergencia_classe_check
  CHECK (divergencia_classe IN ('IDENTICO','CENTAVOS','PEQUENA','CUPOM_PROVAVEL','MATERIAL'));
```

E em `executar_cruzamento`, substituir o CASE de classificação **nos 3 passes**:

```sql
CASE
  WHEN pd.valor = vs.valor_cobrado                                                 THEN 'IDENTICO'
  WHEN abs(pd.valor - vs.valor_cobrado) < 1                                        THEN 'CENTAVOS'
  WHEN abs(pd.valor - vs.valor_cobrado) / NULLIF(pd.valor,0) < 0.05                THEN 'PEQUENA'
  WHEN abs(pd.valor - vs.valor_cobrado) / NULLIF(pd.valor,0) <= 0.20               THEN 'CUPOM_PROVAVEL'
  ELSE 'MATERIAL'
END
```

A régua fica monotônica: 0 → IDENTICO · <R$1 → CENTAVOS · <5% → PEQUENA · 5–20% → CUPOM · >20% → MATERIAL. O front replica a mesma régua nos vínculos manuais (lado meu).

---

## Função consolidada v3 — `gerar_snapshot_voomp` (Achados A + B)

```sql
CREATE OR REPLACE FUNCTION conciliacao.gerar_snapshot_voomp(p_tenant_id uuid, p_ano_mes text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE
  v_fechamento_id uuid;
  v_rows          int;
  v_mes_inicio    date := (p_ano_mes || '-01')::date;
  v_mes_fim       date := ((p_ano_mes || '-01')::date + interval '1 month')::date;
BEGIN
  SELECT fechamento_id INTO v_fechamento_id
  FROM conciliacao.fechamentos_mensais
  WHERE tenant_id = p_tenant_id AND ano_mes = p_ano_mes;

  IF v_fechamento_id IS NULL THEN
    RAISE EXCEPTION 'Fechamento não encontrado: tenant=%, mes=%', p_tenant_id, p_ano_mes;
  END IF;

  IF EXISTS (SELECT 1 FROM conciliacao.voomp_snapshot WHERE fechamento_id = v_fechamento_id LIMIT 1) THEN
    RAISE EXCEPTION 'Snapshot já gerado para este mês. Delete o snapshot para regenerar.';
  END IF;

  PERFORM conciliacao.assert_mes_aberto(p_tenant_id, p_ano_mes);

  INSERT INTO conciliacao.voomp_snapshot (
    fechamento_id, tenant_id, ano_mes, contract_id, voomp_contrato_id,
    aluno_nome, aluno_nome_norm, cpf_cnpj, email, produto_nome, tipo_cobranca,
    data_pagamento, valor_cobrado, valor_recebido, reembolsado,
    voomp_venda_id, qtd_cobrancas, vendas_agrupadas
  )
  WITH base AS (
    SELECT ch.*
    FROM unipds.charges ch
    WHERE ch.tenant_id = p_tenant_id
      AND ch.categoria IN ('PAGO','REEMBOLSADO','CHARGEBACK')
      AND ch.data_pagamento IS NOT NULL
      AND ch.data_pagamento >= v_mes_inicio
      AND ch.data_pagamento <  v_mes_fim
  ),
  -- Assinatura: parcela 1, dedup por contrato com prioridade PAGO
  assinatura AS (
    SELECT DISTINCT ON (b.contract_id)
      b.contract_id, b.student_id, b.product_id,
      'Assinatura'::text AS tipo_cobranca,
      b.data_pagamento,
      b.valor_cobrado, b.valor_recebido,
      (b.categoria = 'REEMBOLSADO') AS reembolsado,
      b.voomp_venda_id,
      1::int AS qtd_cobrancas,
      NULL::text[] AS vendas_agrupadas
    FROM base b
    WHERE b.tipo_cobranca = 'Assinatura' AND COALESCE(b.numero_parcela, 1) = 1
    ORDER BY b.contract_id,
             CASE b.categoria WHEN 'PAGO' THEN 0 ELSE 1 END,
             b.data_pagamento
  ),
  -- Único: AGRUPADO por aluno+produto+situação (Achado A) — funde splits de pagamento
  unico AS (
    SELECT
      NULL::uuid AS contract_id,
      b.student_id, b.product_id,
      'Único'::text AS tipo_cobranca,
      min(b.data_pagamento) AS data_pagamento,
      sum(b.valor_cobrado)  AS valor_cobrado,   -- Achado B: valor cheio, sem zerar
      sum(b.valor_recebido) AS valor_recebido,
      (b.categoria = 'REEMBOLSADO') AS reembolsado,
      (array_agg(b.voomp_venda_id ORDER BY b.valor_cobrado DESC))[1] AS voomp_venda_id,
      count(*)::int AS qtd_cobrancas,
      CASE WHEN count(*) > 1
           THEN array_agg(b.voomp_venda_id ORDER BY b.valor_cobrado DESC)
           ELSE NULL END AS vendas_agrupadas
    FROM base b
    WHERE b.tipo_cobranca = 'Único'
    GROUP BY b.student_id, b.product_id, (b.categoria = 'REEMBOLSADO')
  ),
  unificado AS (
    SELECT * FROM assinatura
    UNION ALL
    SELECT * FROM unico
  )
  SELECT
    v_fechamento_id, p_tenant_id, p_ano_mes,
    u.contract_id, c.voomp_contrato_id,
    s.nome, conciliacao.normalizar_nome(s.nome), s.cpf_cnpj, s.email,
    p.nome, u.tipo_cobranca, u.data_pagamento,
    -- Valor gerencial: contrato cheio (Achado B: vale também para reembolsados)
    CASE WHEN u.tipo_cobranca = 'Assinatura' AND c.recorrencia_total IS NOT NULL
         THEN u.valor_cobrado * c.recorrencia_total::numeric
         ELSE u.valor_cobrado END,
    CASE WHEN u.tipo_cobranca = 'Assinatura' AND c.recorrencia_total IS NOT NULL
         THEN u.valor_recebido * c.recorrencia_total::numeric
         ELSE u.valor_recebido END,
    u.reembolsado,
    u.voomp_venda_id, u.qtd_cobrancas, u.vendas_agrupadas
  FROM unificado u
  LEFT JOIN unipds.contracts c ON c.contract_id = u.contract_id
  JOIN unipds.students  s ON s.student_id = u.student_id
  JOIN unipds.products  p ON p.product_id = u.product_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  UPDATE conciliacao.fechamentos_mensais
  SET snapshot_gerado_em = now()
  WHERE fechamento_id = v_fechamento_id;

  RETURN v_rows;
END;
$function$;
```

*(Conferir a lista de colunas do INSERT contra a versão em produção — se a v2 do mentor já insere `voomp_venda_id`/`voomp_contrato_id` em posições próprias, ajustar a ordem.)*

**Opcional:** expor `qtd_cobrancas` e `vendas_agrupadas` em `v_cruzamento` (acrescentar **ao final** das colunas) — o front mostraria "2 cobranças agrupadas" no detalhe.

---

## Regeneração de maio/IA (recomendada — mês ainda ABERTO)

Aplicar v3 e regenerar para limpar os falsos MATERIAIS antes do fechamento:

```sql
-- 1. limpar snapshot atual (cascateia links via FK)
DELETE FROM conciliacao.voomp_snapshot vs
USING conciliacao.fechamentos_mensais f
WHERE vs.fechamento_id = f.fechamento_id
  AND f.tenant_id = 'e717e24d-fb30-4ed0-83d3-bb8ea0b66783' AND f.ano_mes = '2026-05';

UPDATE conciliacao.fechamentos_mensais
SET snapshot_gerado_em = NULL
WHERE tenant_id = 'e717e24d-fb30-4ed0-83d3-bb8ea0b66783' AND ano_mes = '2026-05';

-- 2. usuário regenera pela UI (botão Snapshot) e re-roda o cruzamento
```

**Resultado esperado em maio/IA:**
- Snapshot: 855 → **~846** linhas (9 splits fundidos; pares com 2ª metade em junho permanecem)
- MATERIAIS: 15 → **~5** (9 splits somem; R$7,35 vira PEQUENA; sobram os splits de metade fora do mês + 1 caso real de R$868,59)
- Órfãos Voomp: 95 → **~86**
- Card Reembolsos: R$0 → **~R$184 mil** visível como redutor

## Resumo executivo

| # | O quê | Efeito |
|---|-------|--------|
| A | Agrupar cobranças Único por aluno+produto no snapshot (+2 colunas de rastro) | Elimina a maior fonte de falso MATERIAL/órfão (9–13 casos/mês) |
| B | Não zerar valores de reembolsados (regra gerencial confirmada pelo usuário) | R$184 mil/mês voltam a aparecer no card Reembolsos |
| C | Classe PEQUENA (≥R$1 e <5%) na régua + CHECK | MATERIAL volta a significar divergência real |
| — | Regenerar snapshot maio/IA com a v3 | Fechamento de maio sai limpo |
