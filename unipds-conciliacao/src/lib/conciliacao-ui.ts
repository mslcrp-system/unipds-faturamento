// Regras e rótulos compartilhados da UI de conciliação.
// A régua de divergência espelha a do banco (conciliacao.executar_cruzamento).

export function classificarDivergencia(pipeValor: number, voompValor: number): string {
  const div = pipeValor - voompValor;
  if (div === 0) return "IDENTICO";
  const abs = Math.abs(div);
  if (abs < 1) return "CENTAVOS";
  const pct = pipeValor !== 0 ? abs / pipeValor : 1;
  if (pct < 0.05) return "PEQUENA";
  if (pct <= 0.20) return "CUPOM_PROVAVEL";
  return "MATERIAL";
}

export const CLASSE_LABEL: Record<string, string> = {
  IDENTICO: "Idêntico",
  CENTAVOS: "Centavos",
  PEQUENA: "Pequena (<5%)",
  CUPOM_PROVAVEL: "Cupom provável",
  MATERIAL: "Material",
};

export const CLASSE_VARIANT: Record<string, "success" | "muted" | "warning" | "destructive"> = {
  IDENTICO: "success",
  CENTAVOS: "muted",
  PEQUENA: "muted",
  CUPOM_PROVAVEL: "warning",
  MATERIAL: "destructive",
};

export const CRITERIO_LABEL: Record<string, string> = {
  AUTO_CPF: "CPF",
  AUTO_EMAIL: "E-mail",
  AUTO_NOME: "Nome",
  MANUAL: "Manual",
  CROSS_TENANT: "Outro tenant",
};

export function fmtBRL(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

/** "2026-05" → "Maio de 2026" */
export function mesLabel(anoMes: string): string {
  const [ano, mes] = anoMes.split("-");
  const idx = parseInt(mes, 10) - 1;
  return MESES[idx] ? `${MESES[idx]} de ${ano}` : anoMes;
}
