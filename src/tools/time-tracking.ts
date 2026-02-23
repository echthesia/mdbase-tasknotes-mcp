import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { normalizeFrontmatter, denormalizeFrontmatter, resolveDisplayTitle } from "../lib/field-mapping.js";
import { getCurrentDateString } from "../lib/date.js";
import { parseISO, differenceInMinutes } from "date-fns";
import type { TimeEntry } from "../lib/types.js";

export function registerTimeTrackingTools(server: McpServer, ctx: ServerContext): void {

  // --- tasknotes_start_time_tracking ---
  server.registerTool(
    "tasknotes_start_time_tracking",
    {
      description: "Start a timer on a task. Only one timer can run per task at a time.",
      inputSchema: {
        id: z.string().describe("The file path of the task"),
        description: z.string().optional().describe("Optional description of what you're working on"),
      },
    },
    async ({ id, description }) => {
      const read = await ctx.collection.read(id);
      if (read.error) {
        return {
          content: [{ type: "text", text: `Error: ${read.error.message}` }],
          isError: true,
        };
      }

      const fm = normalizeFrontmatter(read.frontmatter as Record<string, unknown>, ctx.mapping);
      const entries: TimeEntry[] = Array.isArray(fm.timeEntries)
        ? [...(fm.timeEntries as TimeEntry[])]
        : [];

      const running = entries.find((e) => e.startTime && !e.endTime);
      if (running) {
        return {
          content: [{ type: "text", text: `Error: Timer already running since ${running.startTime}. Stop it first.` }],
          isError: true,
        };
      }

      const newEntry: TimeEntry = {
        startTime: new Date().toISOString(),
      };
      if (description) {
        newEntry.description = description;
      }
      entries.push(newEntry);

      const result = await (ctx.collection as any).update({
        path: id,
        fields: denormalizeFrontmatter({ ...fm, timeEntries: entries }, ctx.mapping),
      });

      if (result.error) {
        return {
          content: [{ type: "text", text: `Error: ${result.error.message}` }],
          isError: true,
        };
      }

      const taskTitle = resolveDisplayTitle(fm, ctx.mapping, id) || id;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            started: true,
            id,
            title: taskTitle,
            startTime: newEntry.startTime,
          }, null, 2),
        }],
      };
    },
  );

  // --- tasknotes_stop_time_tracking ---
  server.registerTool(
    "tasknotes_stop_time_tracking",
    {
      description: "Stop the active timer. If id is provided, stops that task's timer. Otherwise finds and stops the currently running timer.",
      inputSchema: {
        id: z.string().optional().describe("The file path of the task (optional; if omitted, stops any running timer)"),
      },
    },
    async ({ id }) => {
      if (id) {
        return await stopTimerForTask(id);
      }

      // Find the task with a running timer
      const result = await ctx.collection.query({
        types: ["task"],
        limit: 500,
      });

      const rawTasks = (result.results || []) as any[];
      for (const task of rawTasks) {
        const fm = normalizeFrontmatter(task.frontmatter as Record<string, unknown>, ctx.mapping);
        const entries = Array.isArray(fm.timeEntries) ? (fm.timeEntries as TimeEntry[]) : [];
        const runningIdx = entries.findIndex((e) => e.startTime && !e.endTime);
        if (runningIdx !== -1) {
          return await stopTimerForTask(task.path);
        }
      }

      return {
        content: [{ type: "text", text: "Error: No running timer found." }],
        isError: true,
      };
    },
  );

  async function stopTimerForTask(taskId: string) {
    const read = await ctx.collection.read(taskId);
    if (read.error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${read.error.message}` }],
        isError: true,
      };
    }

    const fm = normalizeFrontmatter(read.frontmatter as Record<string, unknown>, ctx.mapping);
    const entries: TimeEntry[] = Array.isArray(fm.timeEntries)
      ? [...(fm.timeEntries as TimeEntry[])]
      : [];

    const runningIdx = entries.findIndex((e) => e.startTime && !e.endTime);
    if (runningIdx === -1) {
      return {
        content: [{ type: "text" as const, text: `Error: No running timer on task ${taskId}.` }],
        isError: true,
      };
    }

    const endTime = new Date();
    const entry = entries[runningIdx];
    const duration = differenceInMinutes(endTime, parseISO(entry.startTime));

    entries[runningIdx] = {
      ...entry,
      endTime: endTime.toISOString(),
    };

    const result = await (ctx.collection as any).update({
      path: taskId,
      fields: denormalizeFrontmatter({ ...fm, timeEntries: entries }, ctx.mapping),
    });

    if (result.error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${result.error.message}` }],
        isError: true,
      };
    }

    const taskTitle = resolveDisplayTitle(fm, ctx.mapping, taskId) || taskId;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          stopped: true,
          id: taskId,
          title: taskTitle,
          durationMinutes: duration,
        }, null, 2),
      }],
    };
  }

  // --- tasknotes_get_active_time_sessions ---
  server.registerTool(
    "tasknotes_get_active_time_sessions",
    {
      description: "Get all tasks with currently running timers.",
      inputSchema: {},
    },
    async () => {
      const result = await ctx.collection.query({
        types: ["task"],
        limit: 500,
      });

      const rawTasks = (result.results || []) as any[];
      const activeSessions: Array<{
        id: string;
        title: string;
        startTime: string;
        description?: string;
        elapsedMinutes: number;
      }> = [];

      const now = new Date();
      for (const task of rawTasks) {
        const fm = normalizeFrontmatter(task.frontmatter as Record<string, unknown>, ctx.mapping);
        const entries = Array.isArray(fm.timeEntries) ? (fm.timeEntries as TimeEntry[]) : [];
        const running = entries.find((e) => e.startTime && !e.endTime);
        if (running) {
          const elapsed = differenceInMinutes(now, parseISO(running.startTime));
          const title = resolveDisplayTitle(fm, ctx.mapping, task.path) || task.path;
          activeSessions.push({
            id: task.path,
            title,
            startTime: running.startTime,
            description: running.description,
            elapsedMinutes: elapsed,
          });
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            activeSessions,
            count: activeSessions.length,
          }, null, 2),
        }],
      };
    },
  );

  // --- tasknotes_get_time_summary ---
  server.registerTool(
    "tasknotes_get_time_summary",
    {
      description: "Get a time tracking summary for a period. Aggregates time per task and total.",
      inputSchema: {
        period: z.enum(["today", "week", "month", "all"]).optional().describe("Predefined period (default: 'all')"),
        from: z.string().optional().describe("Start date (YYYY-MM-DD) for custom range"),
        to: z.string().optional().describe("End date (YYYY-MM-DD) for custom range"),
      },
    },
    async ({ period, from, to }) => {
      const result = await ctx.collection.query({
        types: ["task"],
        limit: 500,
      });

      const rawTasks = (result.results || []) as any[];
      const allEntries: Array<{
        taskId: string;
        taskTitle: string;
        entry: TimeEntry;
      }> = [];

      for (const task of rawTasks) {
        const fm = normalizeFrontmatter(task.frontmatter as Record<string, unknown>, ctx.mapping);
        const entries = Array.isArray(fm.timeEntries) ? (fm.timeEntries as TimeEntry[]) : [];
        const title = resolveDisplayTitle(fm, ctx.mapping, task.path) || task.path;
        for (const entry of entries) {
          if (!entry.endTime) continue;
          allEntries.push({ taskId: task.path, taskTitle: title, entry });
        }
      }

      // Filter by date range
      let filtered = allEntries;
      if (from) {
        filtered = filtered.filter((e) => e.entry.startTime >= from);
      }
      if (to) {
        filtered = filtered.filter((e) => e.entry.startTime <= to + "T23:59:59");
      }

      const effectivePeriod = period || "all";
      if (effectivePeriod === "today") {
        const today = getCurrentDateString();
        filtered = filtered.filter((e) => e.entry.startTime.startsWith(today));
      } else if (effectivePeriod === "week") {
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        const weekStr = weekAgo.toISOString();
        filtered = filtered.filter((e) => e.entry.startTime >= weekStr);
      } else if (effectivePeriod === "month") {
        const monthAgo = new Date();
        monthAgo.setMonth(monthAgo.getMonth() - 1);
        const monthStr = monthAgo.toISOString();
        filtered = filtered.filter((e) => e.entry.startTime >= monthStr);
      }

      // Aggregate per task
      const perTask: Record<string, { title: string; totalMinutes: number; entryCount: number }> = {};
      let totalMinutes = 0;

      for (const { taskId, taskTitle, entry } of filtered) {
        const dur = differenceInMinutes(parseISO(entry.endTime!), parseISO(entry.startTime));
        totalMinutes += dur;
        if (!perTask[taskId]) {
          perTask[taskId] = { title: taskTitle, totalMinutes: 0, entryCount: 0 };
        }
        perTask[taskId].totalMinutes += dur;
        perTask[taskId].entryCount++;
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period: effectivePeriod,
            from: from || null,
            to: to || null,
            totalMinutes,
            totalEntries: filtered.length,
            perTask: Object.entries(perTask).map(([id, data]) => ({
              id,
              ...data,
            })),
          }, null, 2),
        }],
      };
    },
  );

  // --- tasknotes_get_task_time_data ---
  server.registerTool(
    "tasknotes_get_task_time_data",
    {
      description: "Get detailed time tracking data for a specific task, including all time entries with computed durations.",
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

      const fm = normalizeFrontmatter(read.frontmatter as Record<string, unknown>, ctx.mapping);
      const entries: TimeEntry[] = Array.isArray(fm.timeEntries)
        ? (fm.timeEntries as TimeEntry[])
        : [];

      const now = new Date();
      const detailed = entries.map((entry) => {
        const start = parseISO(entry.startTime);
        const end = entry.endTime ? parseISO(entry.endTime) : now;
        const durationMinutes = differenceInMinutes(end, start);
        return {
          startTime: entry.startTime,
          endTime: entry.endTime || null,
          description: entry.description || null,
          durationMinutes,
          isRunning: !entry.endTime,
        };
      });

      const totalMinutes = detailed.reduce((sum, e) => sum + e.durationMinutes, 0);
      const title = resolveDisplayTitle(fm, ctx.mapping, id) || id;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            id,
            title,
            entries: detailed,
            totalMinutes,
            entryCount: detailed.length,
          }, null, 2),
        }],
      };
    },
  );
}
