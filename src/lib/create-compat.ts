import { format } from "date-fns";
import type { Collection } from "@callumalpass/mdbase";
import type { FieldMapping } from "./field-mapping.js";
import { denormalizeFrontmatter, resolveField } from "./field-mapping.js";

type UnknownRecord = Record<string, unknown>;

interface TaskTypeDefLike {
  path_pattern?: string;
  match?: {
    path_glob?: string;
    where?: Record<string, unknown>;
  };
  fields?: Record<string, { type?: string; default?: unknown }>;
}

interface CreateInputLike {
  type: string;
  frontmatter: UnknownRecord;
  body?: string;
  path?: string;
}

interface CreateResultLike {
  path?: string;
  frontmatter?: UnknownRecord;
  error?: {
    code?: string;
    message: string;
  };
  warnings?: string[];
}

export async function createTaskWithCompat(
  collection: Collection,
  mapping: FieldMapping,
  roleFrontmatter: UnknownRecord,
  body?: string,
): Promise<CreateResultLike> {
  const taskType = getTaskTypeDef(collection);
  const denormalized = denormalizeFrontmatter(roleFrontmatter, mapping);

  applyFieldDefaults(denormalized, taskType);
  applyTimestampDefaults(denormalized, mapping, taskType);
  applyMatchDefaults(denormalized, taskType);

  const input: CreateInputLike = {
    type: "task",
    frontmatter: denormalized,
    body,
  };

  const firstAttempt = await (collection as any).create(input) as CreateResultLike;
  if (!firstAttempt.error || firstAttempt.error.code !== "path_required") {
    return firstAttempt;
  }

  const pathResolution = derivePathFromType(
    taskType,
    denormalized,
    mapping,
    new Date(),
  );
  if (!pathResolution.path) {
    if (pathResolution.missingKeys && pathResolution.missingKeys.length > 0) {
      const missing = pathResolution.missingKeys.join(", ");
      return {
        ...firstAttempt,
        warnings: [
          `Cannot resolve path_pattern "${pathResolution.template}": missing template values for ${missing}.`,
        ],
      };
    }
    return firstAttempt;
  }

  return await (collection as any).create({
    ...input,
    path: pathResolution.path,
  }) as CreateResultLike;
}

function getTaskTypeDef(collection: Collection): TaskTypeDefLike | undefined {
  const maybeCollection = collection as unknown as { typeDefs?: Map<string, TaskTypeDefLike> };
  if (!maybeCollection.typeDefs || typeof maybeCollection.typeDefs.get !== "function") {
    return undefined;
  }
  return maybeCollection.typeDefs.get("task");
}

function applyTimestampDefaults(
  frontmatter: UnknownRecord,
  mapping: FieldMapping,
  taskType: TaskTypeDefLike | undefined,
): void {
  const fields = taskType?.fields;
  if (!fields) return;

  const nowIso = new Date().toISOString();

  const createdField = resolveField(mapping, "dateCreated");
  if (fields[createdField] && !hasValue(frontmatter[createdField])) {
    frontmatter[createdField] = nowIso;
  }

  const modifiedField = resolveField(mapping, "dateModified");
  if (fields[modifiedField] && !hasValue(frontmatter[modifiedField])) {
    frontmatter[modifiedField] = nowIso;
  }
}

function applyFieldDefaults(
  frontmatter: UnknownRecord,
  taskType: TaskTypeDefLike | undefined,
): void {
  const fields = taskType?.fields;
  if (!fields) return;

  for (const [fieldName, fieldDef] of Object.entries(fields)) {
    if (fieldDef.default !== undefined && !hasValue(frontmatter[fieldName])) {
      frontmatter[fieldName] = fieldDef.default;
    }
  }
}

function applyMatchDefaults(
  frontmatter: UnknownRecord,
  taskType: TaskTypeDefLike | undefined,
): void {
  const where = taskType?.match?.where;
  if (!where || typeof where !== "object") return;

  for (const [field, condition] of Object.entries(where)) {
    if (condition === null || condition === undefined) continue;

    if (typeof condition !== "object" || Array.isArray(condition)) {
      if (!hasValue(frontmatter[field])) {
        frontmatter[field] = condition;
      }
      continue;
    }

    const ops = condition as Record<string, unknown>;
    if ("eq" in ops && !hasValue(frontmatter[field])) {
      frontmatter[field] = ops.eq;
      continue;
    }

    if ("contains" in ops) {
      const expected = ops.contains;
      const current = frontmatter[field];
      if (Array.isArray(current)) {
        if (!current.some((v) => String(v) === String(expected))) {
          current.push(expected);
          frontmatter[field] = current;
        }
        continue;
      }
      if (typeof current === "string") {
        if (!current.includes(String(expected))) {
          frontmatter[field] = `${current} ${String(expected)}`.trim();
        }
        continue;
      }
      if (!hasValue(current)) {
        frontmatter[field] = [expected];
      }
      continue;
    }

    if ("exists" in ops && ops.exists === true && !hasValue(frontmatter[field])) {
      frontmatter[field] = true;
    }
  }
}

function derivePathFromType(
  taskType: TaskTypeDefLike | undefined,
  frontmatter: UnknownRecord,
  mapping: FieldMapping,
  now: Date,
): { path?: string; missingKeys?: string[]; template?: string } {
  if (!taskType || typeof taskType.path_pattern !== "string" || taskType.path_pattern.trim().length === 0) {
    return {};
  }

  const values = buildTemplateValues(frontmatter, mapping, now);
  const renderedPattern = renderTemplate(taskType.path_pattern, values);
  if (renderedPattern.path) {
    return { path: ensureMarkdownExt(renderedPattern.path), template: taskType.path_pattern };
  }
  return {
    template: taskType.path_pattern,
    missingKeys: renderedPattern.missingKeys,
  };
}

function renderTemplate(
  template: string,
  values: Record<string, string>,
): { path?: string; missingKeys: string[] } {
  const missingKeys = new Set<string>();

  const rendered = template.replace(/\{\{(\w+)\}\}|\{(\w+)\}/g, (_, a: string, b: string) => {
    const key = a ?? b;
    const value = values[key];
    if (value === undefined || value === null || String(value).trim().length === 0) {
      missingKeys.add(key);
      return "";
    }
    return String(value);
  });

  if (missingKeys.size > 0) {
    return { missingKeys: Array.from(missingKeys).sort() };
  }

  const normalized = normalizeRelativePath(rendered);
  if (!normalized || normalized.includes("..") || normalized.includes("\0")) {
    return { missingKeys: [] };
  }
  return { path: normalized, missingKeys: [] };
}

function buildTemplateValues(
  frontmatter: UnknownRecord,
  mapping: FieldMapping,
  now: Date,
): Record<string, string> {
  const values: Record<string, string> = {};

  const titleField = resolveField(mapping, "title");
  const priorityField = resolveField(mapping, "priority");
  const statusField = resolveField(mapping, "status");
  const dueField = resolveField(mapping, "due");
  const scheduledField = resolveField(mapping, "scheduled");

  const rawTitle = readString(frontmatter[titleField]) || readString(frontmatter.title) || "task";
  const title = sanitizeForPathSegment(rawTitle);
  const priority = sanitizeForPathSegment(
    readString(frontmatter[priorityField]) || readString(frontmatter.priority) || "normal",
  );
  const status = sanitizeForPathSegment(
    readString(frontmatter[statusField]) || readString(frontmatter.status) || "open",
  );

  const dueDate = readString(frontmatter[dueField]) || readString(frontmatter.due) || "";
  const scheduledDate = readString(frontmatter[scheduledField]) || readString(frontmatter.scheduled) || "";

  const titleLower = title.toLowerCase();
  const titleKebab = titleLower.replace(/\s+/g, "-");

  const base: Record<string, string> = {
    title,
    priority,
    status,
    dueDate,
    scheduledDate,
    date: format(now, "yyyy-MM-dd"),
    time: format(now, "HHmmss"),
    timestamp: format(now, "yyyy-MM-dd-HHmmss"),
    dateTime: format(now, "yyyy-MM-dd-HHmm"),
    year: format(now, "yyyy"),
    month: format(now, "MM"),
    day: format(now, "dd"),
    titleLower,
    titleKebab,
  };

  Object.assign(values, base);
  values[titleField] = title;
  values[priorityField] = priority;
  values[statusField] = status;
  values[dueField] = dueDate;
  values[scheduledField] = scheduledDate;

  for (const [key, value] of Object.entries(frontmatter)) {
    if (values[key] !== undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      values[key] = sanitizeForPathSegment(String(value));
    }
  }

  return values;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeForPathSegment(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[<>:"/\\|?*#[\]]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/^\.+|\.+$/g, "")
    .trim();
}

function normalizeRelativePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
}

function ensureMarkdownExt(pathValue: string): string {
  const normalized = normalizeRelativePath(pathValue);
  if (!normalized) return normalized;
  if (normalized.toLowerCase().endsWith(".md")) return normalized;
  return `${normalized}.md`;
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined;
}
