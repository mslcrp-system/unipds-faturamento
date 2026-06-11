# Solicitação ao mentor — Conciliação v2 (travas, auditoria, matching, cross-tenant)

**Data:** 2026-06-11
**Solicitante:** sessão front/conciliação
**Contexto:** avaliação completa da arquitetura aprovada pelo usuário. Quatro mudanças no schema `conciliacao` para fechar os furos identificados. Nenhuma mudança em `unipds`, `cobranca`, `financeiro` ou `faturamento`.

**Ordem sugerida de aplicação:** itens 1 → 2 → 3 → 4 numa única janela. O front será atualizado depois que tudo estiver aplicado (os itens são retrocompatíveis — o front atual continua funcionando entre a aplicação e o deploy novo).

---

## Item 1 — Travas de mês fechado (prioridade máxima)

**Problema:** hoje é possível subir CSV Pipe (full replace), criar/apagar links e mexer no snapshot de um mês com `estado = 'FECHADO'`, alterando retroativamente números já reportados. A fotografia fiscal está protegida pela imutabilidade do snapshot, mas o lado comercial não tem trava nenhuma.

**Solução:** guard único + triggers nas três tabelas de dados.

```sql
-- Guard reutilizável
CREATE OR REPLACE FUNCTION conciliacao.assert_mes_aberto(p_tenant_id uuid, p_ano_mes text)
RETURNS void LANGUAGE plpgsql STABLE AS $$
DECLARE v_estado text;
BEGIN
  SELECT estado INTO v_estado
  FROM conciliacao.fechamentos_mensais
  WHERE tenant_id = p_tenant_id AND ano_mes = p_ano_mes;

  IF v_estado = 'FECHADO' THEN
    RAISE EXCEPTION 'Mês % está FECHADO — operação bloqueada. Reabra o fechamento para alterar.', p_ano_mes
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- Trigger genérico
CREATE OR REPLACE FUNCTION conciliacao.tg_bloquear_mes_fechado()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_tenant uuid; v_mes text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tenant := OLD.tenant_id; v_mes := OLD.ano_mes;
  ELSE
    v_tenant := NEW.tenant_id; v_mes := NEW.ano_mes;
  END IF;
  PERFORM conciliacao.assert_mes_aberto(v_tenant, v_mes);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bloquear_mes_fechado
  BEFORE INSERT OR UPDATE OR DELETE ON conciliacao.pipe_deals
  FOR EACH ROW EXECUTE FUNCTION conciliacao.tg_bloquear_mes_fechado();

CREATE TRIGGER bloquear_mes_fechado
  BEFORE INSERT OR UPDATE OR DELETE ON conciliacao.conciliacao_links
  FOR EACH ROW EXECUTE FUNCTION conciliacao.tg_bloquear_mes_fechado();

CREATE TRIGGER bloquear_mes_fechado
  BEFORE INSERT OR UPDATE OR DELETE ON conciliacao.voomp_snapshot
  FOR EACH ROW EXECUTE FUNCTION conciliacao.tg_bloquear_mes_fechado();
```

**Observações:**
- `executar_cruzamento` (DELETE+INSERT em links) passa a falhar automaticamente em mês fechado — comportamento desejado.
- `fechar_mes` só atualiza `fechamentos_mensais` (sem trigger) — não é afetada.
- Se você precisar regenerar um snapshot de mês fechado (correção excepcional), use `ALTER TABLE ... DISABLE TRIGGER` na janela de manutenção — a trava é para o app, não para você.
- **Reabertura:** sugerimos NÃO criar função exposta. Reabrir = você executar manualmente `UPDATE conciliacao.fechamentos_mensais SET estado = 'REABERTO' WHERE ...`. Mantém a governança no seu papel.

**Validação:** com um mês FECHADO, `INSERT INTO conciliacao.pipe_deals (...)` deve falhar com a mensagem da trava.

---

## Item 2 — Auditoria de import do CSV Pipe

**Problema:** o lado fiscal tem `unipds.raw_imports` (hash SHA256, contagens, linhas rejeitadas). O lado comercial não registra nada — não sabemos qual arquivo gerou os `pipe_deals` atuais nem quantas linhas o parser descartou.

**Solução:** tabela de auditoria + coluna de referência nos deals.

```sql
CREATE TABLE conciliacao.pipe_imports (
  import_id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES unipds.tenants(tenant_id),
  ano_mes            text        NOT NULL CHECK (ano_mes ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  nome_arquivo       text        NOT NULL,
  sha256_hash        text        NOT NULL,
  total_linhas_csv   integer,
  linhas_importadas  integer,
  linhas_descartadas integer,
  descarte_detalhe   jsonb,      -- ex: {"funis_desconhecidos":["X"],"sem_data":3,"sem_id_ou_valor":1}
  imported_by        uuid,
  imported_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON conciliacao.pipe_imports (tenant_id, ano_mes);

ALTER TABLE conciliacao.pipe_deals
  ADD COLUMN import_id uuid REFERENCES conciliacao.pipe_imports(import_id);

-- Permissões (mesmo padrão das demais)
GRANT SELECT, INSERT ON conciliacao.pipe_imports TO authenticated;
GRANT ALL ON conciliacao.pipe_imports TO service_role;
ALTER TABLE conciliacao.pipe_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated full access" ON conciliacao.pipe_imports
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
```

**Quem preenche:** o front (vou implementar) — calcula SHA256 do arquivo no browser, insere o registro em `pipe_imports` e grava o `import_id` em cada deal do full replace. `import_id` é nullable para os dados já existentes.

**Validação:** `\d conciliacao.pipe_imports` existe; `pipe_deals.import_id` existe e aceita NULL.

---

## Item 3 — Passe de matching por email + criterio novo

**Problema:** o motor usa só CPF (95) e nome (70). Email existe limpo dos dois lados (`pipe_deals.email_clean`; `voomp_snapshot.email`) e não é usado. Em maio/IA ficaram 58 órfãos Pipe × 118 órfãos Voomp que um passe de email pode reduzir.

**Solução em duas partes:**

### 3a. Ampliar o CHECK de critério (também atende o Item 4)

```sql
ALTER TABLE conciliacao.conciliacao_links
  DROP CONSTRAINT conciliacao_links_criterio_check;
ALTER TABLE conciliacao.conciliacao_links
  ADD CONSTRAINT conciliacao_links_criterio_check
  CHECK (criterio IN ('AUTO_CPF','AUTO_EMAIL','AUTO_NOME','MANUAL','CROSS_TENANT'));
```
*(confirmar o nome real do constraint com `\d conciliacao.conciliacao_links` antes do DROP)*

### 3b. Nova `executar_cruzamento` com 3 passes (CPF 95 → EMAIL 85 → NOME 70)

```sql
CREATE OR REPLACE FUNCTION conciliacao.executar_cruzamento(
  p_tenant_id uuid,
  p_ano_mes   text
) RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_fechamento_id uuid;
  v_links         int := 0;
  v_n             int;
BEGIN
  SELECT fechamento_id INTO v_fechamento_id
  FROM conciliacao.fechamentos_mensais
  WHERE tenant_id = p_tenant_id AND ano_mes = p_ano_mes;

  IF v_fechamento_id IS NULL THEN
    RAISE EXCEPTION 'Fechamento não encontrado: tenant=%, mes=%', p_tenant_id, p_ano_mes;
  END IF;

  -- Trava de mês fechado (redundante com trigger, mas falha mais cedo e com mensagem clara)
  PERFORM conciliacao.assert_mes_aberto(p_tenant_id, p_ano_mes);

  -- Limpar links automáticos anteriores; preservar MANUAL e CROSS_TENANT
  DELETE FROM conciliacao.conciliacao_links
  WHERE tenant_id = p_tenant_id
    AND ano_mes = p_ano_mes
    AND criterio NOT IN ('MANUAL','CROSS_TENANT');

  -- ── Pass 1: CPF exato (confiança 95) ────────────────────────────
  INSERT INTO conciliacao.conciliacao_links (
    tenant_id, ano_mes, pipe_deal_id, snapshot_id,
    criterio, confianca, divergencia_valor, divergencia_classe
  )
  SELECT DISTINCT ON (pd.pipe_deal_id)
    p_tenant_id, p_ano_mes, pd.pipe_deal_id, vs.snapshot_id,
    'AUTO_CPF', 95,
    round((pd.valor - vs.valor_cobrado)::numeric, 2),
    CASE
      WHEN pd.valor = vs.valor_cobrado                                                  THEN 'IDENTICO'
      WHEN abs(pd.valor - vs.valor_cobrado) < 1                                         THEN 'CENTAVOS'
      WHEN abs(pd.valor - vs.valor_cobrado) / NULLIF(pd.valor,0) BETWEEN 0.05 AND 0.20  THEN 'CUPOM_PROVAVEL'
      ELSE 'MATERIAL'
    END
  FROM conciliacao.pipe_deals pd
  JOIN conciliacao.voomp_snapshot vs
    ON vs.fechamento_id = v_fechamento_id
    AND vs.cpf_cnpj = pd.cpf_clean
  WHERE pd.tenant_id = p_tenant_id AND pd.ano_mes = p_ano_mes AND pd.status = 'Ganho'
    AND pd.cpf_clean IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM conciliacao.conciliacao_links cl
                    WHERE cl.tenant_id = p_tenant_id AND cl.ano_mes = p_ano_mes
                      AND cl.pipe_deal_id = pd.pipe_deal_id)
    AND NOT EXISTS (SELECT 1 FROM conciliacao.conciliacao_links cl
                    WHERE cl.snapshot_id = vs.snapshot_id)
  ORDER BY pd.pipe_deal_id, abs(pd.valor - vs.valor_cobrado)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_links := v_links + v_n;

  -- ── Pass 2: EMAIL exato (confiança 85) ──────────────────────────
  INSERT INTO conciliacao.conciliacao_links (
    tenant_id, ano_mes, pipe_deal_id, snapshot_id,
    criterio, confianca, divergencia_valor, divergencia_classe
  )
  SELECT DISTINCT ON (pd.pipe_deal_id)
    p_tenant_id, p_ano_mes, pd.pipe_deal_id, vs.snapshot_id,
    'AUTO_EMAIL', 85,
    round((pd.valor - vs.valor_cobrado)::numeric, 2),
    CASE
      WHEN pd.valor = vs.valor_cobrado                                                  THEN 'IDENTICO'
      WHEN abs(pd.valor - vs.valor_cobrado) < 1                                         THEN 'CENTAVOS'
      WHEN abs(pd.valor - vs.valor_cobrado) / NULLIF(pd.valor,0) BETWEEN 0.05 AND 0.20  THEN 'CUPOM_PROVAVEL'
      ELSE 'MATERIAL'
    END
  FROM conciliacao.pipe_deals pd
  JOIN conciliacao.voomp_snapshot vs
    ON vs.fechamento_id = v_fechamento_id
    AND lower(trim(vs.email)) = pd.email_clean
  WHERE pd.tenant_id = p_tenant_id AND pd.ano_mes = p_ano_mes AND pd.status = 'Ganho'
    AND pd.email_clean IS NOT NULL AND pd.email_clean <> ''
    AND NOT EXISTS (SELECT 1 FROM conciliacao.conciliacao_links cl
                    WHERE cl.tenant_id = p_tenant_id AND cl.ano_mes = p_ano_mes
                      AND cl.pipe_deal_id = pd.pipe_deal_id)
    AND NOT EXISTS (SELECT 1 FROM conciliacao.conciliacao_links cl
                    WHERE cl.snapshot_id = vs.snapshot_id)
  ORDER BY pd.pipe_deal_id, abs(pd.valor - vs.valor_cobrado)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_links := v_links + v_n;

  -- ── Pass 3: similaridade de nome (confiança 70) ─────────────────
  INSERT INTO conciliacao.conciliacao_links (
    tenant_id, ano_mes, pipe_deal_id, snapshot_id,
    criterio, confianca, divergencia_valor, divergencia_classe
  )
  SELECT DISTINCT ON (pd.pipe_deal_id)
    p_tenant_id, p_ano_mes, pd.pipe_deal_id, vs.snapshot_id,
    'AUTO_NOME', 70,
    round((pd.valor - vs.valor_cobrado)::numeric, 2),
    CASE
      WHEN pd.valor = vs.valor_cobrado                                                  THEN 'IDENTICO'
      WHEN abs(pd.valor - vs.valor_cobrado) < 1                                         THEN 'CENTAVOS'
      WHEN abs(pd.valor - vs.valor_cobrado) / NULLIF(pd.valor,0) BETWEEN 0.05 AND 0.20  THEN 'CUPOM_PROVAVEL'
      ELSE 'MATERIAL'
    END
  FROM conciliacao.pipe_deals pd
  JOIN conciliacao.voomp_snapshot vs
    ON vs.fechamento_id = v_fechamento_id
    AND similarity(pd.pessoa_nome_norm, vs.aluno_nome_norm) > 0.5
    AND abs(pd.valor - vs.valor_cobrado) / NULLIF(pd.valor, 0) < 0.25
  WHERE pd.tenant_id = p_tenant_id AND pd.ano_mes = p_ano_mes AND pd.status = 'Ganho'
    AND NOT EXISTS (SELECT 1 FROM conciliacao.conciliacao_links cl
                    WHERE cl.tenant_id = p_tenant_id AND cl.ano_mes = p_ano_mes
                      AND cl.pipe_deal_id = pd.pipe_deal_id)
    AND NOT EXISTS (SELECT 1 FROM conciliacao.conciliacao_links cl
                    WHERE cl.snapshot_id = vs.snapshot_id)
  ORDER BY pd.pipe_deal_id, similarity(pd.pessoa_nome_norm, vs.aluno_nome_norm) DESC
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_links := v_links + v_n;

  RETURN v_links;
END;
$$;
```

**Mudanças vs versão atual:** passe de email novo entre CPF e nome; `NOT EXISTS` em vez de `NOT IN` (mais seguro com NULLs e snapshot_id global); exclusão de snapshot por `snapshot_id` global (consistente com links cross-tenant do Item 4); preserva `CROSS_TENANT` além de `MANUAL` na limpeza.

**Validação:** re-rodar para maio/IA e comparar — esperado: total de links ≥ 737, com alguns `AUTO_EMAIL` aparecendo.

---

## Item 4 — Controle cross-tenant (deal fechado no funil errado)

**Problema:** o sistema antigo tinha `v_suspeitos_tenant_errado` (deal órfão do tenant A casando por CPF/email com aluno órfão do tenant B). A migração para o schema novo perdeu esse controle — e com Java Elite entrando no fluxo, esse é o erro operacional mais provável.

```sql
-- 4a. Coluna de marcação no link
ALTER TABLE conciliacao.conciliacao_links
  ADD COLUMN cross_tenant boolean NOT NULL DEFAULT false;

-- 4b. View de suspeitos
CREATE OR REPLACE VIEW conciliacao.v_suspeitos_tenant_errado AS
SELECT
  pd.tenant_id          AS tenant_pipe,
  vs.tenant_id          AS tenant_voomp,
  pd.ano_mes,
  pd.pipe_deal_id,
  pd.funil,
  pd.proprietario,
  pd.pessoa_nome        AS pipe_nome,
  vs.aluno_nome         AS voomp_nome,
  pd.valor              AS pipe_valor,
  vs.valor_cobrado      AS voomp_valor,
  vs.snapshot_id,
  vs.voomp_venda_id,
  CASE WHEN vs.cpf_cnpj = pd.cpf_clean THEN 'CPF' ELSE 'EMAIL' END AS criterio_suspeita
FROM conciliacao.pipe_deals pd
JOIN conciliacao.voomp_snapshot vs
  ON vs.ano_mes  = pd.ano_mes
  AND vs.tenant_id <> pd.tenant_id
  AND (
    (pd.cpf_clean IS NOT NULL AND vs.cpf_cnpj = pd.cpf_clean)
    OR (pd.email_clean IS NOT NULL AND pd.email_clean <> '' AND lower(trim(vs.email)) = pd.email_clean)
  )
WHERE pd.status = 'Ganho'
  AND NOT EXISTS (SELECT 1 FROM conciliacao.conciliacao_links cl
                  WHERE cl.tenant_id = pd.tenant_id AND cl.ano_mes = pd.ano_mes
                    AND cl.pipe_deal_id = pd.pipe_deal_id)
  AND NOT EXISTS (SELECT 1 FROM conciliacao.conciliacao_links cl
                  WHERE cl.snapshot_id = vs.snapshot_id);

-- 4c. v_cruzamento: expor cross_tenant + voomp_tenant_id
--     (colunas APENAS ao final, e exclusão de órfão Voomp passa a ser global por snapshot_id)
```

Para o 4c, recriar `conciliacao.v_cruzamento` igual à atual com três ajustes:
1. **Acrescentar ao final do SELECT** (os dois ramos do UNION): `cl.cross_tenant` (NULL no ramo órfão Voomp) e `vs.tenant_id AS voomp_tenant_id`.
2. No ramo ORFAO_VOOMP, trocar a exclusão por: `WHERE NOT EXISTS (SELECT 1 FROM conciliacao.conciliacao_links cl WHERE cl.snapshot_id = vs.snapshot_id)` — assim um snapshot linkado por deal de OUTRO tenant some dos órfãos.
3. Manter todas as colunas existentes nas mesmas posições (regra do `CREATE OR REPLACE VIEW`).

**Como o vínculo cross-tenant será criado (front):** insert em `conciliacao_links` com `tenant_id` = tenant do deal Pipe, `snapshot_id` do outro tenant, `criterio = 'CROSS_TENANT'`, `cross_tenant = true`, `confianca = 100`.

**Validação:** view existe; com dados de Java + IA no mesmo mês, deals do funil errado aparecem.

---

## Item 5 — `fechar_mes`: ajuste de consistência (1 linha)

Com links cross-tenant, a contagem de órfãos Voomp em `fechar_mes` precisa usar a exclusão global por `snapshot_id` (igual ao 4c-2). Na função atual, trocar o subquery de `total_orfaos_voomp`:

```sql
-- de:
--   AND vs.snapshot_id NOT IN (SELECT snapshot_id FROM conciliacao.conciliacao_links
--                              WHERE tenant_id = p_tenant_id AND ano_mes = p_ano_mes)
-- para:
--   AND NOT EXISTS (SELECT 1 FROM conciliacao.conciliacao_links cl
--                   WHERE cl.snapshot_id = vs.snapshot_id)
```

---

## Pós-aplicação

1. `NOTIFY pgrst, 'reload schema';` — tabela e colunas novas precisam entrar no cache do PostgREST.
2. Avisar a sessão front → eu atualizo o app (UX nova, captura de auditoria de import, painel cross-tenant, travas visuais de mês fechado).
3. **Maio/IA não precisa de reset nenhum:** snapshot (855) está correto e os 737 links são todos AUTO. Após o Item 3, re-rodamos o cruzamento pela UI (limpa AUTO, recria com o passe de email), revisamos os órfãos restantes e fechamos o mês pelo fluxo normal.

## Resumo executivo

| # | O quê | Por quê |
|---|-------|---------|
| 1 | Triggers de trava em `pipe_deals`/`conciliacao_links`/`voomp_snapshot` | Impedir alteração retroativa de mês FECHADO |
| 2 | Tabela `pipe_imports` + `pipe_deals.import_id` | Auditoria do CSV comercial igual à do fiscal |
| 3 | CHECK ampliado + `executar_cruzamento` com passe de EMAIL | Reduzir os 176 órfãos de maio sem custo de falso positivo |
| 4 | `cross_tenant` em links + `v_suspeitos_tenant_errado` + ajustes em `v_cruzamento` | Recuperar o controle de deal no funil errado antes do Java entrar |
| 5 | 1 linha em `fechar_mes` | Consistência da fotografia com links cross-tenant |
