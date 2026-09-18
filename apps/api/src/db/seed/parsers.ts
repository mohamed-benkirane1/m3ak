import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";

export function readCsvRows(filePath: string): Record<string, string>[] {
  const content = readFileSync(filePath, "utf8");
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: false,
    bom: true,
  }) as Record<string, string>[];
}

// Deterministic decimal-string -> integer centimes conversion. Never goes through
// floating point multiplication (Math.round(Number(v) * 100) would be exact for most
// values here but is not a safe general parser for arbitrary decimal strings).
const MONEY_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

export function parseMadToCents(value: string, context: string): number {
  const match = MONEY_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Malformed monetary value in ${context}: "${value}"`);
  }
  const whole = match[1] as string;
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const cents = BigInt(whole) * 100n + BigInt(fraction);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Monetary value out of safe range in ${context}: "${value}"`);
  }
  return Number(cents);
}

export function parseNonNegativeInteger(value: string, context: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Malformed integer in ${context}: "${value}"`);
  }
  return Number(value);
}

export function parseOptionalNonNegativeInteger(value: string, context: string): number | null {
  if (value === "") {
    return null;
  }
  return parseNonNegativeInteger(value, context);
}

// Passed straight through as a validated string, never converted to a JS Date:
// the pg driver sends it as-is and PostgreSQL parses it against the DATE column
// type, avoiding any timezone-shift risk that new Date(...) could introduce.
export function parseIsoDate(value: string, context: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Malformed date in ${context}: "${value}"`);
  }
  return value;
}

const LANGUAGE_MAP: Record<string, "french" | "darija" | "arabic"> = {
  fr: "french",
  darija: "darija",
  ar: "arabic",
};

export function mapLanguage(value: string, context: string): "french" | "darija" | "arabic" {
  const mapped = LANGUAGE_MAP[value];
  if (!mapped) {
    throw new Error(`Unknown langue_preferee value in ${context}: "${value}"`);
  }
  return mapped;
}

export function parseOuiNonBoolean(value: string, context: string): boolean {
  if (value === "oui") {
    return true;
  }
  if (value === "non") {
    return false;
  }
  throw new Error(`Unknown boolean vocabulary in ${context}: "${value}"`);
}
