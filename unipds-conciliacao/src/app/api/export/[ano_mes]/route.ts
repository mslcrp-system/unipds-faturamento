import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { TENANTS, tenantById } from "@/lib/tenants";
import ExcelJS from "exceljs";
import { createHash } from "node:crypto";

export const runtime = "nodejs";

// Paleta de cores por tipo de pendência
const COR = {
  CROSS_TENANT:  { argb: "FFFF4444" }, // vermelho
  MATERIAL:      { argb: "FFFF8C00" }, // laranja
  CUPOM_PROVAVEL:{ argb: "FFFFD700" }, // amarelo
  ORFAO:         { argb: "FFADD8E6" }, // azul claro
  OK:            { argb: "FFCCFFCC" }, // verde claro
} as const;

function rowFill(r: any): ExcelJS.Fill | undefined {
  if (r.cross_tenant)                                     return { type: "pattern", pattern: "solid", fgColor: COR.CROSS_TENANT };
  if (r.divergencia_classe === "MATERIAL")                return { type: "pattern", pattern: "solid", fgColor: COR.MATERIAL };
  if (r.divergencia_classe === "CUPOM_PROVAVEL")          return { type: "pattern", pattern: "solid", fgColor: COR.CUPOM_PROVAVEL };
  if (r.status_match === "ORFAO_PIPE" || r.status_match === "ORFAO_VOOMP" || r.venda_orfa === "SIM")
                                                          return { type: "pattern", pattern: "solid", fgColor: COR.ORFAO };
  return undefined;
}

function applyFill(row: ExcelJS.Row, fill: ExcelJS.Fill | undefined) {
  if (!fill) return;
  row.eachCell({ includeEmpty: true }, (cell) => { cell.fill = fill; });
}

function addSectionHeader(ws: ExcelJS.Worksheet, label: string, colCount: number) {
  const row = ws.addRow([label]);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF374151" } };
  row.height = 20;
  ws.mergeCells(row.number, 1, row.number, colCount);
  ws.addRow([]); // espaço
}

export async function POST(
  request: NextRequest,
  { params }: { params: { ano_mes: string } },
) {
  const { ano_mes } = params;
  const tenant_id = new URL(request.url).searchParams.get("tenant_id");
  if (!tenant_id) return new NextResponse("tenant_id obrigatório", { status: 400 });
  if (!TENANTS.some((t) => t.id === tenant_id)) return new NextResponse("tenant_id inválido", { status: 400 });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ano_mes)) return new NextResponse("ano_mes inválido", { status: 400 });

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Não autenticado", { status: 401 });

  const [{ data: pipeRows }, { data: voompRows }, { data: fechamento }, { data: tenantInfo }] = await Promise.all([
    supabase.schema("unipds").from("v_cruzamento_pipe").select("*").eq("tenant_id", tenant_id).eq("ano_mes", ano_mes),
    supabase.schema("unipds").from("v_cruzamento_voomp").select("*").eq("tenant_id", tenant_id).eq("ano_mes", ano_mes),
    supabase.schema("unipds").from("fechamentos_mensais").select("*").eq("tenant_id", tenant_id).eq("ano_mes", ano_mes).maybeSingle(),
    supabase.schema("unipds").from("tenants").select("nome,cnpj").eq("tenant_id", tenant_id).single(),
  ]);

  if (!fechamento) return new NextResponse("Fechamento não encontrado", { status: 404 });

  const pipe  = (pipeRows  ?? []) as any[];
  const voomp = (voompRows ?? []) as any[];

  // Segmentos para a aba Pendências
  const crossTenant    = pipe.filter(r => r.cross_tenant);
  const materialPipe   = pipe.filter(r => !r.cross_tenant && r.divergencia_classe === "MATERIAL");
  const materialVoomp  = voomp.filter(r => !r.cross_tenant && r.divergencia_classe === "MATERIAL");
  const cupomPipe      = pipe.filter(r => r.divergencia_classe === "CUPOM_PROVAVEL");
  const orfaosPipe     = pipe.filter(r => r.status_match === "ORFAO_PIPE");
  const orfaosVoomp    = voomp.filter(r => r.status_match === "ORFAO_VOOMP");

  const wb = new ExcelJS.Workbook();
  wb.creator = "Unipds Conciliação";
  wb.created = new Date();

  // ── Aba 1: Capa ─────────────────────────────────────────────────────────────
  const capa = wb.addWorksheet("Capa");
  capa.columns = [{ width: 36 }, { width: 50 }];

  const capaData: [string, string, (ExcelJS.Fill | undefined)?][] = [
    ["Tenant",                  tenantInfo?.nome ?? ""],
    ["CNPJ",                    tenantInfo?.cnpj ?? ""],
    ["Mês de competência",      ano_mes],
    ["Estado fechamento",       fechamento.estado],
    ["Gerado em",               new Date().toISOString()],
    ["Gerado por",              user.email ?? user.id],
    ["", ""],
    ["── TOTAIS ──", ""],
    ["Total deals Pipe (Ganho)",       String(pipe.length)],
    ["Total novos alunos Voomp",       String(voomp.length)],
    ["Matches automáticos",            String(pipe.filter(r => r.criterio && !["MANUAL","CROSS_TENANT"].includes(r.criterio)).length)],
    ["Matches manuais",                String(pipe.filter(r => r.criterio === "MANUAL").length)],
    ["", ""],
    ["── PENDÊNCIAS ──", ""],
    ["Erros de tenant (deal no produto errado)", String(crossTenant.length),   crossTenant.length    ? { type: "pattern", pattern: "solid", fgColor: COR.CROSS_TENANT   } : undefined],
    ["Divergências materiais (> 5%)",            String(materialPipe.length + materialVoomp.length), materialPipe.length + materialVoomp.length ? { type: "pattern", pattern: "solid", fgColor: COR.MATERIAL       } : undefined],
    ["Cupons prováveis (5–20%)",                 String(cupomPipe.length),    cupomPipe.length      ? { type: "pattern", pattern: "solid", fgColor: COR.CUPOM_PROVAVEL  } : undefined],
    ["Órfãos Pipe (sem aluno Voomp)",            String(orfaosPipe.length),   orfaosPipe.length     ? { type: "pattern", pattern: "solid", fgColor: COR.ORFAO           } : undefined],
    ["Órfãos Voomp (sem deal Pipe)",             String(orfaosVoomp.length),  orfaosVoomp.length    ? { type: "pattern", pattern: "solid", fgColor: COR.ORFAO           } : undefined],
  ];

  capaData.forEach(([k, v, fill]) => {
    const row = capa.addRow([k, v]);
    row.getCell(1).font = { bold: k.startsWith("──") || k === "Tenant" || k === "CNPJ" };
    if (fill) {
      row.getCell(1).fill = fill;
      row.getCell(2).fill = fill;
    }
  });

  // ── Aba 2: Pendências ────────────────────────────────────────────────────────
  const sPend = wb.addWorksheet("⚠ Pendências");
  const NCOLS_PEND = 10;

  function addPendHeader(row: ExcelJS.Row) {
    row.font = { bold: true };
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
  }

  // Seção 1 — Erros de tenant
  if (crossTenant.length > 0) {
    addSectionHeader(sPend, `ERROS DE TENANT — deal fechado no produto errado (${crossTenant.length})`, NCOLS_PEND);
    const h = sPend.addRow(["Deal Pipe", "Proprietário", "Funil (errado)", "Nome Pipe", "Nome Voomp", "Tenant Voomp", "Pipe R$", "Voomp R$", "Diferença R$", "Critério match"]);
    addPendHeader(h);
    crossTenant.forEach(r => {
      const row = sPend.addRow([
        r.pipe_deal_id, r.proprietario, r.funil, r.pessoa_nome, r.voomp_aluno_nome,
        tenantById(r.voomp_tenant_id)?.curto ?? r.voomp_tenant_id,
        r.pipe_valor, r.voomp_valor_contrato,
        r.divergencia_valor,
        r.criterio,
      ]);
      applyFill(row, { type: "pattern", pattern: "solid", fgColor: COR.CROSS_TENANT });
    });
    sPend.addRow([]);
  }

  // Seção 2 — Divergências materiais
  const todasMateriais = [
    ...materialPipe.map(r => ({ ...r, _origem: "Pipe" })),
    ...materialVoomp.map(r => ({ ...r, _origem: "Voomp" })),
  ];
  if (todasMateriais.length > 0) {
    addSectionHeader(sPend, `DIVERGÊNCIAS MATERIAIS — diferença de valor > 5% (${todasMateriais.length})`, NCOLS_PEND);
    const h = sPend.addRow(["Deal Pipe", "Proprietário", "Nome Pipe", "Nome Voomp", "Pipe R$", "Voomp R$", "Diferença R$", "Dif %", "Tipo cobrança", "Data pagamento"]);
    addPendHeader(h);
    todasMateriais.forEach(r => {
      const pct = r.pipe_valor ? ((Math.abs(r.divergencia_valor ?? 0) / r.pipe_valor) * 100).toFixed(1) + "%" : "—";
      const row = sPend.addRow([
        r.pipe_deal_id ?? "—", r.proprietario ?? "—", r.pessoa_nome ?? r.aluno_nome ?? "—",
        r.voomp_aluno_nome ?? r.aluno_nome ?? "—",
        r.pipe_valor ?? "—", r.voomp_valor_contrato ?? "—",
        r.divergencia_valor, pct,
        r.tipo_cobranca ?? "—", r.voomp_data_pagamento ?? r.data_pagamento ?? "—",
      ]);
      applyFill(row, { type: "pattern", pattern: "solid", fgColor: COR.MATERIAL });
    });
    sPend.addRow([]);
  }

  // Seção 3 — Cupons prováveis
  if (cupomPipe.length > 0) {
    addSectionHeader(sPend, `CUPONS PROVÁVEIS — diferença entre 5% e 20% (${cupomPipe.length})`, NCOLS_PEND);
    const h = sPend.addRow(["Deal Pipe", "Proprietário", "Nome Pipe", "Nome Voomp", "Pipe R$", "Voomp R$", "Diferença R$", "Dif %", "Tipo cobrança", "Data pagamento"]);
    addPendHeader(h);
    cupomPipe.forEach(r => {
      const pct = r.pipe_valor ? ((Math.abs(r.divergencia_valor ?? 0) / r.pipe_valor) * 100).toFixed(1) + "%" : "—";
      const row = sPend.addRow([
        r.pipe_deal_id, r.proprietario, r.pessoa_nome, r.voomp_aluno_nome,
        r.pipe_valor, r.voomp_valor_contrato,
        r.divergencia_valor, pct,
        r.tipo_cobranca ?? "—", r.voomp_data_pagamento ?? "—",
      ]);
      applyFill(row, { type: "pattern", pattern: "solid", fgColor: COR.CUPOM_PROVAVEL });
    });
    sPend.addRow([]);
  }

  // Seção 4 — Órfãos Pipe
  if (orfaosPipe.length > 0) {
    addSectionHeader(sPend, `ÓRFÃOS PIPE — deal sem aluno Voomp correspondente (${orfaosPipe.length})`, NCOLS_PEND);
    const h = sPend.addRow(["Deal Pipe", "Proprietário", "Funil", "Nome Pipe", "CPF", "Email", "Pipe R$", "Ganho em", "", ""]);
    addPendHeader(h);
    orfaosPipe.forEach(r => {
      const row = sPend.addRow([
        r.pipe_deal_id, r.proprietario, r.funil, r.pessoa_nome,
        r.pipe_cpf_clean ?? "—", r.pipe_email_clean ?? "—",
        r.pipe_valor, r.pipe_ganho_em, "", "",
      ]);
      applyFill(row, { type: "pattern", pattern: "solid", fgColor: COR.ORFAO });
    });
    sPend.addRow([]);
  }

  // Seção 5 — Órfãos Voomp
  if (orfaosVoomp.length > 0) {
    addSectionHeader(sPend, `ÓRFÃOS VOOMP — aluno sem deal Pipe correspondente (${orfaosVoomp.length})`, NCOLS_PEND);
    const h = sPend.addRow(["Contract ref", "Aluno", "CPF", "Email", "Voomp R$", "Tipo cobrança", "Data pagamento", "Método", "Produto", ""]);
    addPendHeader(h);
    orfaosVoomp.forEach(r => {
      const row = sPend.addRow([
        r.contract_ref, r.aluno_nome, r.cpf_cnpj ?? "—", r.email_clean ?? "—",
        r.voomp_valor_contrato, r.tipo_cobranca ?? "—",
        r.data_pagamento, r.metodo_pagamento ?? "—",
        r.produto_nome ?? "—", "",
      ]);
      applyFill(row, { type: "pattern", pattern: "solid", fgColor: COR.ORFAO });
    });
  }

  // Ajusta largura das colunas da aba Pendências
  sPend.columns.forEach(col => { col.width = 22; });

  // ── Aba 3: Comercial (Pipe) ──────────────────────────────────────────────────
  const sComercial = wb.addWorksheet("Comercial (Pipe)");
  sComercial.columns = [
    { header: "Pipe Deal ID",               key: "pipe_deal_id",                   width: 12 },
    { header: "Funil",                      key: "funil",                          width: 16 },
    { header: "Proprietário",               key: "proprietario",                   width: 20 },
    { header: "Pessoa",                     key: "pessoa_nome",                    width: 32 },
    { header: "CPF Pipe",                   key: "pipe_cpf_clean",                 width: 14 },
    { header: "Ganho em",                   key: "pipe_ganho_em",                  width: 18 },
    { header: "Valor Pipe",                 key: "pipe_valor",                     width: 12 },
    { header: "Status match",               key: "status_match",                   width: 14 },
    { header: "Alerta",                     key: "_alerta",                        width: 18 },
    { header: "Critério",                   key: "criterio",                       width: 14 },
    { header: "Confiança",                  key: "confianca",                      width: 10 },
    { header: "Aluno Voomp",                key: "voomp_aluno_nome",               width: 32 },
    { header: "Contract ref",               key: "contract_ref",                   width: 22 },
    { header: "Tipo cobrança",              key: "tipo_cobranca",                  width: 14 },
    { header: "Valor recebido Voomp (líq.)",key: "voomp_valor_contrato",           width: 22 },
    { header: "Divergência R$",             key: "divergencia_valor",              width: 14 },
    { header: "Classe divergência",         key: "divergencia_classe",             width: 18 },
    { header: "Data pagamento",             key: "voomp_data_pagamento",           width: 14 },
    { header: "Pendente financeiro",        key: "pendente_financeiro",            width: 18 },
  ];
  sComercial.getRow(1).font = { bold: true };
  pipe.forEach(r => {
    const alerta = r.cross_tenant ? "TENANT ERRADO"
      : r.divergencia_classe === "MATERIAL" ? "DIVERGÊNCIA MATERIAL"
      : r.divergencia_classe === "CUPOM_PROVAVEL" ? "CUPOM PROVÁVEL"
      : r.status_match === "ORFAO_PIPE" ? "SEM MATCH VOOMP"
      : "";
    const row = sComercial.addRow({ ...r, _alerta: alerta });
    applyFill(row, rowFill(r));
  });

  // ── Aba 4: Financeiro (Voomp) ────────────────────────────────────────────────
  const sFin = wb.addWorksheet("Financeiro (Voomp)");
  sFin.columns = [
    { header: "Contract ref",                    key: "contract_ref",                        width: 22 },
    { header: "Voomp contrato ID",               key: "voomp_contrato_id",                   width: 18 },
    { header: "Voomp venda ID 1ª parcela",       key: "voomp_venda_id_primeira_parcela",     width: 24 },
    { header: "Aluno",                           key: "aluno_nome",                          width: 32 },
    { header: "CPF",                             key: "cpf_cnpj",                            width: 18 },
    { header: "Email",                           key: "email_clean",                         width: 28 },
    { header: "Tipo cobrança",                   key: "tipo_cobranca",                       width: 14 },
    { header: "Recorrência total",               key: "recorrencia_total",                   width: 14 },
    { header: "Valor parcela",                   key: "voomp_valor_oferta_parcela",          width: 14 },
    { header: "Valor recebido (líq.)",           key: "voomp_valor_contrato",                width: 20 },
    { header: "Valor recebido 1ª parcela",       key: "voomp_valor_recebido_1a_parcela",     width: 20 },
    { header: "Data pagamento",                  key: "data_pagamento",                      width: 14 },
    { header: "Método",                          key: "metodo_pagamento",                    width: 14 },
    { header: "Status match",                    key: "status_match",                        width: 14 },
    { header: "Alerta",                          key: "_alerta",                             width: 22 },
    { header: "Pipe deal ID",                    key: "pipe_deal_id",                        width: 12 },
    { header: "Pipe valor",                      key: "pipe_valor",                          width: 12 },
    { header: "Critério",                        key: "criterio",                            width: 14 },
    { header: "Divergência R$",                  key: "divergencia_valor",                   width: 14 },
    { header: "Classe",                          key: "divergencia_classe",                  width: 16 },
    { header: "Venda órfã",                      key: "venda_orfa",                          width: 12 },
  ];
  sFin.getRow(1).font = { bold: true };
  voomp.forEach(r => {
    const alerta = r.cross_tenant ? "TENANT ERRADO"
      : r.divergencia_classe === "MATERIAL" ? "DIVERGÊNCIA MATERIAL"
      : r.divergencia_classe === "CUPOM_PROVAVEL" ? "CUPOM PROVÁVEL"
      : r.status_match === "ORFAO_VOOMP" ? "SEM MATCH PIPE"
      : "";
    const row = sFin.addRow({ ...r, _alerta: alerta });
    applyFill(row, rowFill(r));
  });

  // ── Hash + persistência ──────────────────────────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const buf = Buffer.from(buffer);
  const hash = createHash("sha256").update(buf).digest("hex");

  const { error: updateError } = await supabase.schema("unipds").from("fechamentos_mensais").update({
    hash_relatorio: hash,
    estado: "FECHADO",
    fechado_em: new Date().toISOString(),
    fechado_por: user.id,
    total_pipe_deals: pipe.length,
    total_voomp_alunos: voomp.length,
    total_matches: pipe.filter(r => r.status_match === "CASADO").length,
    total_orfaos_pipe: orfaosPipe.length,
    total_orfaos_voomp: orfaosVoomp.length,
  }).eq("fechamento_id", fechamento.fechamento_id);

  if (updateError) return new NextResponse(`Erro ao fechar: ${updateError.message}`, { status: 500 });

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="conciliacao_${ano_mes}.xlsx"`,
      "X-Report-Hash": hash,
    },
  });
}
