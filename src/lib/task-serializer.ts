import { basename } from "node:path";
import type { FieldMapping } from "./field-mapping.js";
import { normalizeFrontmatter } from "./field-mapping.js";
import { extractProjectNames } from "./mapper.js";
import type { TimeEntry } from "./types.js";

export interface SerializedTask {
  id: string;
  title: string;
  status: string;
  priority?: string;
  due?: string;
  scheduled?: string;
  tags?: string[];
  contexts?: string[];
  projects?: string[];
  timeEstimate?: number;
  recurrence?: string;
  recurrenceAnchor?: string;
  completeInstances?: string[];
  skippedInstances?: string[];
  completedDate?: string;
  dateCreated?: string;
  dateModified?: string;
  archived: boolean;
  timeEntries?: TimeEntry[];
  details?: string;
}

/**
 * Serialize a raw MDBase query result into a consistent MCP response shape.
 */
export function serializeTask(
  raw: { path: string; frontmatter?: Record<string, unknown>; body?: string | null },
  mapping: FieldMapping,
  includeBody = false,
): SerializedTask {
  const normalized = normalizeFrontmatter(
    (raw.frontmatter || {}) as Record<string, unknown>,
    mapping,
  ) as Record<string, unknown>;

  const tags = asStringArray(normalized.tags);
  const archived = tags.includes("archive");

  const result: SerializedTask = {
    id: raw.path,
    title: resolveTitle(normalized, raw.path),
    status: asString(normalized.status) || "unknown",
    archived,
  };

  const priority = asString(normalized.priority);
  if (priority) result.priority = priority;

  const due = asString(normalized.due);
  if (due) result.due = due;

  const scheduled = asString(normalized.scheduled);
  if (scheduled) result.scheduled = scheduled;

  if (tags.length > 0) result.tags = tags;

  const contexts = asStringArray(normalized.contexts);
  if (contexts.length > 0) result.contexts = contexts;

  const rawProjects = asStringArray(normalized.projects);
  if (rawProjects.length > 0) result.projects = extractProjectNames(rawProjects);

  const timeEstimate = asNumber(normalized.timeEstimate);
  if (timeEstimate !== undefined) result.timeEstimate = timeEstimate;

  const recurrence = asString(normalized.recurrence);
  if (recurrence) result.recurrence = recurrence;

  const recurrenceAnchor = asString(normalized.recurrenceAnchor);
  if (recurrenceAnchor) result.recurrenceAnchor = recurrenceAnchor;

  const completeInstances = asStringArray(normalized.completeInstances);
  if (completeInstances.length > 0) result.completeInstances = completeInstances;

  const skippedInstances = asStringArray(normalized.skippedInstances);
  if (skippedInstances.length > 0) result.skippedInstances = skippedInstances;

  const completedDate = asString(normalized.completedDate);
  if (completedDate) result.completedDate = completedDate;

  const dateCreated = asString(normalized.dateCreated);
  if (dateCreated) result.dateCreated = dateCreated;

  const dateModified = asString(normalized.dateModified);
  if (dateModified) result.dateModified = dateModified;

  const timeEntries = normalized.timeEntries;
  if (Array.isArray(timeEntries) && timeEntries.length > 0) {
    result.timeEntries = timeEntries as TimeEntry[];
  }

  if (includeBody && raw.body) {
    result.details = raw.body;
  }

  return result;
}

function resolveTitle(normalized: Record<string, unknown>, taskPath: string): string {
  const raw = normalized.title;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw;
  }
  const fromPath = basename(taskPath, ".md").trim();
  return fromPath.length > 0 ? fromPath : taskPath;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}
