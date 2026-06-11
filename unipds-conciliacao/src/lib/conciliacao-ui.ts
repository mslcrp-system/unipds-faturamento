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

/** Normaliza nome para comparação: minúsculas, sem acentos, só letras. */
export function normalizarNome(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Similaridade entre nomes (0–1): coeficiente de Dice sobre as palavras. */
export function similaridadeNomes(a: string, b: string): number {
  const wa = new Set(normalizarNome(a).split(" ").filter((w) => w.length > 1));
  const wb = new Set(normalizarNome(b).split(" ").filter((w) => w.length > 1));
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return (2 * inter) / (wa.size + wb.size);
}

/**
 * Score de candidato a vínculo manual (0–1):
 * 70% similaridade de nome + 30% proximidade de valor.
 */
export function scoreCandidato(
  nomeA: string | null, valorA: number | null,
  nomeB: string | null, valorB: number | null,
): number {
  const nome = similaridadeNomes(nomeA ?? "", nomeB ?? "");
  const valor =
    valorA != null && valorB != null && valorA !== 0
      ? Math.max(0, 1 - Math.abs(valorA - valorB) / Math.abs(valorA))
      : 0;
  return 0.7 * nome + 0.3 * valor;
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
