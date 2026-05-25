import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { TENANTS } from "@/lib/tenants";
import ExcelJS from "exceljs";
import { createHash } from "node:crypto";

export const runtime = "nodejs";

const COR = {
  MATERIAL:       { argb: "FFFF8C00" },
  CUPOM_PROVAVEL: { argb: "FFFFD700" },
  ORFAO:          { argb: "FFADD8E6" },
  REEMBOLSO:      { argb: "FFFFE4E4" },
  OK:             { argb: "FFCCFFCC" },
} as const;

function rowFill(r: any): ExcelJS.Fill | undefined {
  if (r.voomp_reembolsado)                              return { type: "pattern", pattern: "solid", fgColor: COR.REEMBOLSO };
  if (r.divergencia_classe === "MATERIAL")              return { type: "pattern", pattern: "solid", fgColor: COR.MATERIAL };
  if (r.divergencia_classe === "CUPOM_PROVAVEL")        return { type: "pattern", pattern: "solid", fgColor: COR.CUPOM_PROVAVEL };
  if (r.status_match === "ORFAO_PIPE" || r.status_match === "ORFAO_VOOMP")
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
  ws.addRow([]);
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

  const [{ data: cruzRows }, { data: fechamento }, { data: tenantInfo }] = await Promise.all([
    supabase.schema("conciliacao").from("v_cruzamento").select("*").eq("tenant_id", tenant_id).eq("ano_mes", ano_mes),
    supabase.schema("conciliacao").from("fechamentos_mensais").select("*").eq("tenant_id", tenant_id).eq("ano_mes", ano_mes).maybeSingle(),
    supabase.schema("unipds").from("tenants").select("nome,cnpj").eq("tenant_id", tenant_id).single(),
  ]);

  if (!fechamento) return new NextResponse("Fechamento não encontrado", { status: 404 });

  const rows  = (cruzRows ?? []) as any[];
  const pipe  = rows.filter((r) => r.status_match !== "ORFAO_VOOMP");
  const voomp = rows.filter((r) => r.status_match !== "ORFAO_PIPE");

  const materialRows    = rows.filter((r) => r.divergencia_classe === "MATERIAL");
  const cupomRows       = rows.filter((r) => r.divergencia_classe === "CUPOM_PROVAVEL");
  const orfaosPipe      = rows.filter((r) => r.status_match === "ORFAO_PIPE");
  const orfaosVoomp     = rows.filter((r) => r.status_match === "ORFAO_VOOMP");
  const reembolsos      = rows.filter((r) => r.voomp_reembolsado);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Unipds Conciliação";
  wb.created = new Date();

  // ── Aba 1: Capa ──────────────────────────────────────────────────
  const capa = wb.addWorksheet("Capa");
  capa.columns = [{ width: 36 }, { width: 50 }];

  const totalVoompCobrado = rows.reduce((s: number, r: any) => s + (Number(r.voomp_valor_cobrado) || 0), 0);
  const totalVoompRecebido= rows.reduce((s: number, r: any) => s + (Number(r.voomp_valor_recebido) || 0), 0);
  const totalReembolsos   = reembolsos.reduce((s: number, r: any) => s + (Number(r.voomp_valor_cobrado) || 0), 0);

  const capaData: [string, string, (ExcelJS.Fill | undefined)?][] = [
    ["Tenant",                     tenantInfo?.nome ?? ""],
    ["CNPJ",                       tenantInfo?.cnpj ?? ""],
    ["Mês de competência",         ano_mes],
    ["Estado fechamento",          fechamento.estado],
    ["Snapshot Voomp gerado em",   fechamento.snapshot_gerado_em
      ? new Date(fechamento.snapshot_gerado_em).toLocaleString("pt-BR") : "—"],
    ["Gerado em",                  new Date().toISOString()],
    ["Gerado por",                 user.email ?? user.id],
    ["", ""],
    ["── TOTAIS ──", ""],
    ["Deals Pipe (Ganho)",         String(pipe.length)],
    ["Contratos Voomp no snapshot",String(voomp.length)],
    ["Voomp cobrado (bruto)",      `R$ ${totalVoompCobrado.toFixed(2)}`],
    ["Voomp recebido (líquido)",   `R$ ${totalVoompRecebido.toFixed(2)}`],
    ["Reembolsos",                 `- R$ ${totalReembolsos.toFixed(2)}`],
    ["", ""],
    ["── PENDÊNCIAS ──", ""],
    ["Divergências materiais (> 5%)", String(materialRows.length),
      materialRows.length ? { type: "pattern", pattern: "solid", fgColor: COR.MATERIAL } : undefined],
    ["Cupons prováveis (5–20%)",      String(cupomRows.length),
      cupomRows.length    ? { type: "pattern", pattern: "solid", fgColor: COR.CUPOM_PROVAVEL } : undefined],
    ["Órfãos Pipe (sem contrato Voomp)", String(orfaosPipe.length),
      orfaosPipe.length   ? { type: "pattern", pattern: "solid", fgColor: COR.ORFAO } : undefined],
    ["Órfãos Voomp (sem deal Pipe)",    String(orfaosVoomp.length),
      orfaosVoomp.length  ? { type: "pattern", pattern: "solid", fgColor: COR.ORFAO } : undefined],
    ["Reembolsos no mês",               String(reembolsos.length),
      reembolsos.length   ? { type: "pattern", pattern: "solid", fgColor: COR.REEMBOLSO } : undefined],
  ];

  capaData.forEach(([k, v, fill]) => {
    const row = capa.addRow([k, v]);
    row.getCell(1).font = { bold: k.startsWith("──") || k === "Tenant" || k === "CNPJ" };
    if (fill) { row.getCell(1).fill = fill; row.getCell(2).fill = fill; }
  });

  // ── Aba 2: Pendências ─────────────────────────────────────────────
  const sPend = wb.addWorksheet("⚠ Pendências");
  const NCOLS = 9;

  function addPendHeader(row: ExcelJS.Row) {
    row.font = { bold: true };
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
  }

  if (materialRows.length > 0) {
    addSectionHeader(sPend, `DIVERGÊNCIAS MATERIAIS — diferença de valor > 5% (${materialRows.length})`, NCOLS);
    const h = sPend.addRow(["Deal Pipe", "Nome Pipe", "Nome Voomp", "Produto", "Pipe R$", "Voomp Cobrado", "Diferença R$", "Dif %", "Data pag."]);
    addPendHeader(h);
    materialRows.forEach((r: any) => {
      const pct = r.pipe_valor ? ((Math.abs(r.divergencia_valor ?? 0) / r.pipe_valor) * 100).toFixed(1) + "%" : "—";
      const row = sPend.addRow([
        r.pipe_deal_id ?? "—", r.pessoa_nome ?? "—", r.voomp_aluno_nome ?? "—",
        r.produto_nome ?? "—", r.pipe_valor ?? "—", r.voomp_valor_cobrado ?? "—",
        r.divergencia_valor, pct, r.voomp_data_pagamento ?? "—",
      ]);
      applyFill(row, { type: "pattern", pattern: "solid", fgColor: COR.MATERIAL });
    });
    sPend.addRow([]);
  }

  if (cupomRows.length > 0) {
    addSectionHeader(sPend, `CUPONS PROVÁVEIS — diferença entre 5% e 20% (${cupomRows.length})`, NCOLS);
    const h = sPend.addRow(["Deal Pipe", "Nome Pipe", "Nome Voomp", "Produto", "Pipe R$", "Voomp Cobrado", "Diferença R$", "Dif %", "Data pag."]);
    addPendHeader(h);
    cupomRows.forEach((r: any) => {
      const pct = r.pipe_valor ? ((Math.abs(r.divergencia_valor ?? 0) / r.pipe_valor) * 100).toFixed(1) + "%" : "—";
      const row = sPend.addRow([
        r.pipe_deal_id, r.pessoa_nome ?? "—", r.voomp_aluno_nome ?? "—",
        r.produto_nome ?? "—", r.pipe_valor, r.voomp_valor_cobrado,
        r.divergencia_valor, pct, r.voomp_data_pagamento ?? "—",
      ]);
      applyFill(row, { type: "pattern", pattern: "solid", fgColor: COR.CUPOM_PROVAVEL });
    });
    sPend.addRow([]);
  }

  if (orfaosPipe.length > 0) {
    addSectionHeader(sPend, `ÓRFÃOS PIPE — deal sem contrato Voomp correspondente (${orfaosPipe.length})`, NCOLS);
    const h = sPend.addRow(["Deal Pipe", "Nome Pipe", "CPF Pipe", "Valor Pipe", "Ganho em", "", "", "", ""]);
    addPendHeader(h);
    orfaosPipe.forEach((r: any) => {
      const row = sPend.addRow([r.pipe_deal_id, r.pessoa_nome ?? "—", r.pipe_cpf ?? "—", r.pipe_valor, r.voomp_data_pagamento ?? "—", "", "", "", ""]);
      applyFill(row, { type: "pattern", pattern: "solid", fgColor: COR.ORFAO });
    });
    sPend.addRow([]);
  }

  if (orfaosVoomp.length > 0) {
    addSectionHeader(sPend, `ÓRFÃOS VOOMP — contrato sem deal Pipe correspondente (${orfaosVoomp.length})`, NCOLS);
    const h = sPend.addRow(["Snapshot ID", "Aluno", "CPF", "Produto", "Tipo", "Cobrado", "Recebido", "Data pag.", ""]);
    addPendHeader(h);
    orfaosVoomp.forEach((r: any) => {
      const row = sPend.addRow([
        r.snapshot_id, r.voomp_aluno_nome ?? "—", r.voomp_cpf ?? "—",
        r.produto_nome ?? "—", r.tipo_cobranca ?? "—",
        r.voomp_valor_cobrado, r.voomp_valor_recebido,
        r.voomp_data_pagamento ?? "—", "",
      ]);
      applyFill(row, { type: "pattern", pattern: "solid", fgColor: COR.ORFAO });
    });
    sPend.addRow([]);
  }

  if (reembolsos.length > 0) {
    addSectionHeader(sPend, `REEMBOLSOS — contratos reembolsados no mês (${reembolsos.length})`, NCOLS);
    const h = sPend.addRow(["Deal Pipe", "Nome Pipe", "Aluno Voomp", "Produto", "Tipo", "Cobrado", "Recebido", "Data pag.", "Status"]);
    addPendHeader(h);
    reembolsos.forEach((r: any) => {
      const row = sPend.addRow([
        r.pipe_deal_id ?? "—", r.pessoa_nome ?? "—", r.voomp_aluno_nome ?? "—",
        r.produto_nome ?? "—", r.tipo_cobranca ?? "—",
        r.voomp_valor_cobrado, r.voomp_valor_recebido,
        r.voomp_data_pagamento ?? "—", r.status_match,
      ]);
      applyFill(row, { type: "pattern", pattern: "solid", fgColor: COR.REEMBOLSO });
    });
  }

  sPend.columns.forEach((col) => { col.width = 22; });

  // ── Aba 3: Comercial (Pipe) ───────────────────────────────────────
  const sComercial = wb.addWorksheet("Comercial (Pipe)");
  sComercial.columns = [
    { header: "Pipe Deal ID",    key: "pipe_deal_id",          width: 12 },
    { header: "Pessoa",          key: "pessoa_nome",            width: 32 },
    { header: "CPF Pipe",        key: "pipe_cpf",               width: 14 },
    { header: "Valor Pipe",      key: "pipe_valor",             width: 12 },
    { header: "Status match",    key: "status_match",           width: 14 },
    { header: "Critério",        key: "criterio",               width: 14 },
    { header: "Confiança",       key: "confianca",              width: 10 },
    { header: "Aluno Voomp",     key: "voomp_aluno_nome",       width: 32 },
    { header: "CPF Voomp",       key: "voomp_cpf",              width: 14 },
    { header: "Produto",         key: "produto_nome",           width: 28 },
    { header: "Tipo cobrança",   key: "tipo_cobranca",          width: 14 },
    { header: "Voomp Cobrado",   key: "voomp_valor_cobrado",    width: 16 },
    { header: "Voomp Recebido",  key: "voomp_valor_recebido",   width: 16 },
    { header: "Reembolsado",     key: "voomp_reembolsado",      width: 12 },
    { header: "Divergência R$",  key: "divergencia_valor",      width: 14 },
    { header: "Classe diverg.",  key: "divergencia_classe",     width: 18 },
    { header: "Data pagamento",  key: "voomp_data_pagamento",   width: 14 },
  ];
  sComercial.getRow(1).font = { bold: true };
  pipe.forEach((r: any) => {
    const row = sComercial.addRow(r);
    applyFill(row, rowFill(r));
  });

  // ── Aba 4: Financeiro (Voomp) ─────────────────────────────────────
  const sFin = wb.addWorksheet("Financeiro (Voomp)");
  sFin.columns = [
    { header: "Snapshot ID",     key: "snapshot_id",            width: 36 },
    { header: "Contrato Voomp",  key: "voomp_contrato_id",      width: 20 },
    { header: "Aluno",           key: "voomp_aluno_nome",       width: 32 },
    { header: "CPF",             key: "voomp_cpf",              width: 18 },
    { header: "Produto",         key: "produto_nome",           width: 28 },
    { header: "Tipo cobrança",   key: "tipo_cobranca",          width: 14 },
    { header: "Cobrado (bruto)", key: "voomp_valor_cobrado",    width: 16 },
    { header: "Recebido (líq.)", key: "voomp_valor_recebido",   width: 16 },
    { header: "Reembolsado",     key: "voomp_reembolsado",      width: 12 },
    { header: "Data pagamento",  key: "voomp_data_pagamento",   width: 14 },
    { header: "Status match",    key: "status_match",           width: 14 },
    { header: "Deal Pipe",       key: "pipe_deal_id",           width: 12 },
    { header: "Critério",        key: "criterio",               width: 14 },
    { header: "Divergência R$",  key: "divergencia_valor",      width: 14 },
    { header: "Classe",          key: "divergencia_classe",     width: 16 },
  ];
  sFin.getRow(1).font = { bold: true };
  voomp.forEach((r: any) => {
    const row = sFin.addRow(r);
    applyFill(row, rowFill(r));
  });

  // ── Hash ──────────────────────────────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const buf    = Buffer.from(buffer);
  const hash   = createHash("sha256").update(buf).digest("hex");

  // Fechar mês via RPC (congela fotografia financeira)
  const { error: fecharError } = await (supabase.schema("conciliacao") as any).rpc("fechar_mes", {
    p_tenant_id: tenant_id,
    p_ano_mes:   ano_mes,
  });
  if (fecharError) return new NextResponse(`Erro ao fechar: ${fecharError.message}`, { status: 500 });

  // Salvar hash no fechamento
  await supabase.schema("conciliacao").from("fechamentos_mensais")
    .update({ hash_relatorio: hash })
    .eq("tenant_id", tenant_id)
    .eq("ano_mes", ano_mes);

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="conciliacao_${ano_mes}.xlsx"`,
      "X-Report-Hash": hash,
    },
  });
}
