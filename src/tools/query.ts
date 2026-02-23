import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { serializeTask } from "../lib/task-serializer.js";
import { normalizeFrontmatter, isCompletedStatus, resolveField } from "../lib/field-mapping.js";
import { getCurrentDateString, isBeforeDateSafe } from "../lib/date.js";
import { parseISO, differenceInMinutes } from "date-fns";
import type { TimeEntry } from "../lib/types.js";

export function registerQueryTools(server: McpServer, ctx: ServerContext): void {

  // --- tasknotes_query_tasks ---
  server.registerTool(
    "tasknotes_query_tasks",
    {
      description: 'Query tasks using MDBase expression syntax. Example: where=\'status == "open" && priority == "high"\'. Supports sort, group, and pagination.',
      inputSchema: {
        where: z.string().optional().describe('MDBase where expression (e.g., \'status == "open" && due < "2026-03-01"\')'),
        sort_by: z.string().optional().describe("Field to sort by (e.g., 'due', 'priority', 'title')"),
        sort_direction: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
        group_by: z.string().optional().describe("Field to group results by (e.g., 'status', 'priority')"),
        limit: z.number().optional().describe("Maximum number of results (default: 50)"),
        offset: z.number().optional().describe("Number of results to skip"),
      },
    },
    async ({ where, sort_by, sort_direction, group_by, limit, offset }) => {
      const queryOpts: Record<string, unknown> = {
        types: ["task"],
        limit: limit ?? 50,
        offset: offset ?? 0,
      };

      if (where) {
        queryOpts.where = where;
      }

      if (sort_by) {
        // Resolve role name to actual field name
        const actualField = tryResolveField(sort_by);
        queryOpts.order_by = `${actualField} ${sort_direction || "asc"}`;
      }

      const result = await ctx.collection.query(queryOpts);
      const tasks = ((result.results || []) as any[]).map((t) =>
        serializeTask(t, ctx.mapping),
      );

      // Post-process grouping
      if (group_by) {
        const groups: Record<string, typeof tasks> = {};
        for (const task of tasks) {
          const groupValue = String((task as any)[group_by] ?? "unset");
          if (!groups[groupValue]) groups[groupValue] = [];
          groups[groupValue].push(task);
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              grouped_by: group_by,
              groups,
              total: result.meta?.total_count ?? tasks.length,
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            tasks,
            total: result.meta?.total_count ?? tasks.length,
            limit: limit ?? 50,
            offset: offset ?? 0,
          }, null, 2),
        }],
      };
    },
  );

  // --- tasknotes_get_filter_options ---
  server.registerTool(
    "tasknotes_get_filter_options",
    {
      description: "Get available values for filtering tasks. Returns distinct statuses, priorities, tags, contexts, and projects found in the collection.",
      inputSchema: {},
    },
    async () => {
      const result = await ctx.collection.query({
        types: ["task"],
        limit: 1000,
      });

      const rawTasks = (result.results || []) as any[];
      const statuses = new Set<string>();
      const priorities = new Set<string>();
      const tags = new Set<string>();
      const contexts = new Set<string>();
      const projects = new Set<string>();

      for (const raw of rawTasks) {
        const norm = normalizeFrontmatter(raw.frontmatter as Record<string, unknown>, ctx.mapping);
        if (typeof norm.status === "string") statuses.add(norm.status);
        if (typeof norm.priority === "string") priorities.add(norm.priority);
        if (Array.isArray(norm.tags)) {
          for (const t of norm.tags) if (typeof t === "string") tags.add(t);
        }
        if (Array.isArray(norm.contexts)) {
          for (const c of norm.contexts) if (typeof c === "string") contexts.add(c);
        }
        if (Array.isArray(norm.projects)) {
          for (const p of norm.projects) {
            if (typeof p === "string") {
              const match = p.match(/\[\[(?:.*\/)?([^\]]+)\]\]/);
              projects.add(match ? match[1] : p);
            }
          }
        }
      }

      // Include enum values from type definition
      for (const s of ctx.statusValues) statuses.add(s);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            statuses: [...statuses].sort(),
            priorities: [...priorities].sort(),
            tags: [...tags].sort(),
            contexts: [...contexts].sort(),
            projects: [...projects].sort(),
          }, null, 2),
        }],
      };
    },
  );

  // --- tasknotes_get_stats ---
  server.registerTool(
    "tasknotes_get_stats",
    {
      description: "Get aggregate task statistics: total, by status, by priority, overdue count, completion rate, and total time tracked.",
      inputSchema: {},
    },
    async () => {
      const result = await ctx.collection.query({
        types: ["task"],
        limit: 1000,
      });

      const rawTasks = (result.results || []) as any[];
      const total = rawTasks.length;

      if (total === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ total: 0, message: "No tasks found." }, null, 2),
          }],
        };
      }

      const byStatus: Record<string, number> = {};
      const byPriority: Record<string, number> = {};
      let overdue = 0;
      let completedCount = 0;
      let totalMinutes = 0;
      const today = getCurrentDateString();

      for (const raw of rawTasks) {
        const norm = normalizeFrontmatter(raw.frontmatter as Record<string, unknown>, ctx.mapping);

        const status = (norm.status as string) || "unknown";
        byStatus[status] = (byStatus[status] || 0) + 1;

        const priority = (norm.priority as string) || "unset";
        byPriority[priority] = (byPriority[priority] || 0) + 1;

        if (isCompletedStatus(ctx.mapping, status)) {
          completedCount++;
        }

        if (
          norm.due &&
          typeof norm.due === "string" &&
          isBeforeDateSafe(norm.due, today) &&
          !isCompletedStatus(ctx.mapping, status)
        ) {
          overdue++;
        }

        const entries = norm.timeEntries;
        if (Array.isArray(entries)) {
          for (const entry of entries as TimeEntry[]) {
            if (entry.endTime) {
              totalMinutes += differenceInMinutes(parseISO(entry.endTime), parseISO(entry.startTime));
            }
          }
        }
      }

      const completionRate = Math.round((completedCount / total) * 100);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total,
            completedCount,
            completionRate,
            overdue,
            byStatus,
            byPriority,
            totalTimeTrackedMinutes: totalMinutes,
          }, null, 2),
        }],
      };
    },
  );

  function tryResolveField(name: string): string {
    try {
      return resolveField(ctx.mapping, name as any);
    } catch {
      return name;
    }
  }
}
