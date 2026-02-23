import { isValid, parseISO } from "date-fns";

export function parseDateToUTC(dateString: string): Date {
  if (!dateString || dateString.trim().length === 0) {
    throw new Error("Date string cannot be empty");
  }

  const trimmed = dateString.trim();
  const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    const parsed = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));

    if (
      parsed.getUTCFullYear() !== y ||
      parsed.getUTCMonth() !== m - 1 ||
      parsed.getUTCDate() !== d
    ) {
      throw new Error(`Invalid date "${dateString}".`);
    }
    return parsed;
  }

  const parsed = parseISO(trimmed);
  if (!isValid(parsed)) {
    throw new Error(`Invalid date "${dateString}".`);
  }
  return parsed;
}

export function parseDateToLocal(dateString: string): Date {
  if (!dateString || dateString.trim().length === 0) {
    throw new Error("Date string cannot be empty");
  }

  const trimmed = dateString.trim();
  const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    const parsed = new Date(y, m - 1, d, 0, 0, 0, 0);

    if (
      parsed.getFullYear() !== y ||
      parsed.getMonth() !== m - 1 ||
      parsed.getDate() !== d
    ) {
      throw new Error(`Invalid date "${dateString}".`);
    }
    return parsed;
  }

  const parsed = parseISO(trimmed);
  if (!isValid(parsed)) {
    throw new Error(`Invalid date "${dateString}".`);
  }
  return parsed;
}

export function formatDateForStorage(date: Date): string {
  if (!date || Number.isNaN(date.getTime())) {
    return "";
  }
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function getCurrentDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function resolveDateOrToday(date?: string): string {
  if (!date) {
    return getCurrentDateString();
  }
  return validateDateString(date);
}

export function validateDateString(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date "${date}". Expected YYYY-MM-DD.`);
  }

  parseDateToUTC(date);
  return date;
}

export function hasTimeComponent(dateString: string | undefined): boolean {
  if (!dateString) return false;
  return /T\d{2}:\d{2}/.test(dateString);
}

export function getDatePart(dateString: string): string {
  if (!dateString) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    return dateString;
  }
  const tIndex = dateString.indexOf("T");
  if (tIndex > -1) {
    return dateString.slice(0, tIndex);
  }
  return formatDateForStorage(parseDateToUTC(dateString));
}

export function isSameDateSafe(date1: string, date2: string): boolean {
  try {
    const d1 = parseDateToUTC(getDatePart(date1));
    const d2 = parseDateToUTC(getDatePart(date2));
    return d1.getTime() === d2.getTime();
  } catch {
    return false;
  }
}

export function isBeforeDateSafe(date1: string, date2: string): boolean {
  try {
    const d1 = parseDateToUTC(getDatePart(date1));
    const d2 = parseDateToUTC(getDatePart(date2));
    return d1.getTime() < d2.getTime();
  } catch {
    return false;
  }
}
