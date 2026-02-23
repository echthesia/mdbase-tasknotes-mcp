import { loadConfig, getType } from "@callumalpass/mdbase";
import {
  NaturalLanguageParserCore,
  type StatusConfig,
  type PriorityConfig,
} from "tasknotes-nlp-core";
import { buildFieldMapping } from "./field-mapping.js";

/**
 * Create an NLP parser from a collection path directly (no CLI config resolution).
 */
export async function createParser(collectionPath: string): Promise<NaturalLanguageParserCore> {
  const configResult = await loadConfig(collectionPath);
  if (!configResult.valid || !configResult.config) {
    throw new Error(`Failed to load mdbase config at ${collectionPath}: ${configResult.error?.message}`);
  }

  const typeResult = await getType(collectionPath, configResult.config, "task");
  if (!typeResult.valid || !typeResult.type) {
    throw new Error(`Failed to load task type definition: ${typeResult.error?.message}`);
  }

  const fields = typeResult.type.fields || {};
  const mapping = buildFieldMapping(fields);

  const statusConfigs: StatusConfig[] = [];
  const statusField = fields[mapping.roleToField.status];
  const completedSet = new Set(mapping.completedStatuses);
  if (statusField?.values) {
    statusField.values.forEach((value: string, index: number) => {
      const isCompleted = completedSet.has(value);
      statusConfigs.push({
        id: value,
        value,
        label: value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, " "),
        color: isCompleted ? "#888888" : "#ffffff",
        isCompleted,
        order: index,
        autoArchive: false,
        autoArchiveDelay: 0,
      });
    });
  }

  const priorityConfigs: PriorityConfig[] = [];
  const priorityField = fields[mapping.roleToField.priority];
  if (priorityField?.values) {
    priorityField.values.forEach((value: string, index: number) => {
      priorityConfigs.push({
        id: value,
        value,
        label: value.charAt(0).toUpperCase() + value.slice(1),
        color: "#ffffff",
        weight: index,
      });
    });
  }

  return new NaturalLanguageParserCore(statusConfigs, priorityConfigs, true, "en");
}
