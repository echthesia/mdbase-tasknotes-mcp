import type { Collection } from "@callumalpass/mdbase";
import type { NaturalLanguageParserCore } from "tasknotes-nlp-core";
import type { FieldMapping } from "./lib/field-mapping.js";
import { openCollection } from "./lib/collection.js";
import { loadFieldMapping, getStatusValues } from "./lib/field-mapping.js";
import { createParser } from "./lib/nlp.js";

export interface ServerContext {
  collection: Collection;
  mapping: FieldMapping;
  parser: NaturalLanguageParserCore;
  collectionPath: string;
  statusValues: string[];
  completedStatuses: string[];
}

/**
 * Build the shared server context. Called once at startup.
 */
export async function createServerContext(collectionPath: string): Promise<ServerContext> {
  const collection = await openCollection(collectionPath);
  const mapping = await loadFieldMapping(collectionPath);
  const parser = await createParser(collectionPath);
  const statusValues = await getStatusValues(collectionPath);
  const completedStatuses = mapping.completedStatuses;

  return {
    collection,
    mapping,
    parser,
    collectionPath,
    statusValues,
    completedStatuses,
  };
}
