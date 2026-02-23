import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { normalizeFrontmatter, denormalizeFrontmatter, isCompletedStatus } from "../lib/field-mapping.js";
import { getCurrentDateString, resolveDateOrToday } from "../lib/date.js";
import { completeRecurringTask } from "../lib/recurrence.js";

export function registerTaskActionTools(server: McpServer, ctx: ServerContext): void {

  // --- tasknotes_toggle_status ---
  server.registerTool(
    "tasknotes_toggle_status",
    {
      description: "Cycle a task through status values (e.g., open -> in-progress -> done -> open). Automatically sets completedDate when transitioning to a completed status.",
      inputSchema: {
        id: z.string().describe("The file path of the task"),
      },
    },
    async ({ id }) => {
      const read = await ctx.collection.read(id);
      if (read.error) {
        return {
          content: [{ type: "text", text: `Error: ${read.error.message}` }],
          isError: true,
        };
      }

      const normalized = normalizeFrontmatter(
        read.frontmatter as Record<string, unknown>,
        ctx.mapping,
      );

      const currentStatus = (normalized.status as string) || "";
      const statusValues = ctx.statusValues;

      let nextStatus: string;
      if (statusValues.length > 0) {
        const currentIndex = statusValues.indexOf(currentStatus);
        const nextIndex = (currentIndex + 1) % statusValues.length;
        nextStatus = statusValues[nextIndex];
      } else {
        // Fallback cycle: open -> in-progress -> done -> open
        const fallback = ["open", "in-progress", "done"];
        const idx = fallback.indexOf(currentStatus);
        nextStatus = fallback[(idx + 1) % fallback.length];
      }

      const updated: Record<string, unknown> = { ...normalized, status: nextStatus };

      // Set completedDate when entering completed status
      if (isCompletedStatus(ctx.mapping, nextStatus) && !isCompletedStatus(ctx.mapping, currentStatus)) {
        updated.completedDate = getCurrentDateString();
      }
      // Clear completedDate when leaving completed status
      if (!isCompletedStatus(ctx.mapping, nextStatus) && isCompletedStatus(ctx.mapping, currentStatus)) {
        delete updated.completedDate;
      }

      const denormalized = denormalizeFrontmatter(updated, ctx.mapping);
      const result = await (ctx.collection as any).update({ path: id, fields: denormalized });

      if (result.error) {
        return {
          content: [{ type: "text", text: `Error: ${result.error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            toggled: true,
            id,
            previousStatus: currentStatus,
            newStatus: nextStatus,
          }, null, 2),
        }],
      };
    },
  );

  // --- tasknotes_toggle_archive ---
  server.registerTool(
    "tasknotes_toggle_archive",
    {
      description: "Toggle the archive status of a task. Adds or removes the 'archive' tag.",
      inputSchema: {
        id: z.string().describe("The file path of the task"),
      },
    },
    async ({ id }) => {
      const read = await ctx.collection.read(id);
      if (read.error) {
        return {
          content: [{ type: "text", text: `Error: ${read.error.message}` }],
          isError: true,
        };
      }

      const normalized = normalizeFrontmatter(
        read.frontmatter as Record<string, unknown>,
        ctx.mapping,
      );

      const tags: string[] = Array.isArray(normalized.tags)
        ? [...(normalized.tags as string[])]
        : [];

      const wasArchived = tags.includes("archive");
      if (wasArchived) {
        const idx = tags.indexOf("archive");
        tags.splice(idx, 1);
      } else {
        tags.push("archive");
      }

      const updated = { ...normalized, tags };
      const denormalized = denormalizeFrontmatter(updated, ctx.mapping);
      const result = await (ctx.collection as any).update({ path: id, fields: denormalized });

      if (result.error) {
        return {
          content: [{ type: "text", text: `Error: ${result.error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            toggled: true,
            id,
            archived: !wasArchived,
          }, null, 2),
        }],
      };
    },
  );

  // --- tasknotes_complete_recurring_instance ---
  server.registerTool(
    "tasknotes_complete_recurring_instance",
    {
      description: "Complete a recurring task for a specific date. Adds the date to completeInstances and recalculates the next scheduled/due dates.",
      inputSchema: {
        id: z.string().describe("The file path of the recurring task"),
        date: z.string().optional().describe("The date to complete (YYYY-MM-DD). Defaults to today."),
      },
    },
    async ({ id, date }) => {
      const read = await ctx.collection.read(id);
      if (read.error) {
        return {
          content: [{ type: "text", text: `Error: ${read.error.message}` }],
          isError: true,
        };
      }

      const normalized = normalizeFrontmatter(
        read.frontmatter as Record<string, unknown>,
        ctx.mapping,
      );

      const recurrence = normalized.recurrence as string | undefined;
      if (!recurrence) {
        return {
          content: [{ type: "text", text: "Error: Task has no recurrence rule." }],
          isError: true,
        };
      }

      const completionDate = resolveDateOrToday(date);
      const recResult = completeRecurringTask({
        recurrence,
        recurrenceAnchor: normalized.recurrenceAnchor as string | undefined,
        scheduled: normalized.scheduled as string | undefined,
        due: normalized.due as string | undefined,
        dateCreated: normalized.dateCreated as string | undefined,
        completionDate,
        completeInstances: normalized.completeInstances as string[] | undefined,
        skippedInstances: normalized.skippedInstances as string[] | undefined,
      });

      const updated: Record<string, unknown> = {
        ...normalized,
        recurrence: recResult.updatedRecurrence,
        completeInstances: recResult.completeInstances,
        skippedInstances: recResult.skippedInstances,
      };
      if (recResult.nextScheduled !== null) {
        updated.scheduled = recResult.nextScheduled;
      }
      if (recResult.nextDue !== null) {
        updated.due = recResult.nextDue;
      }

      const denormalized = denormalizeFrontmatter(updated, ctx.mapping);
      const result = await (ctx.collection as any).update({ path: id, fields: denormalized });

      if (result.error) {
        return {
          content: [{ type: "text", text: `Error: ${result.error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            completed: true,
            id,
            completionDate,
            nextScheduled: recResult.nextScheduled,
            nextDue: recResult.nextDue,
          }, null, 2),
        }],
      };
    },
  );
}
