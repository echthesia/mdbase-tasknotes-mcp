import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { serializeTask } from "../lib/task-serializer.js";
import { denormalizeFrontmatter, normalizeFrontmatter } from "../lib/field-mapping.js";
import { createTaskWithCompat } from "../lib/create-compat.js";
import { mapToFrontmatter } from "../lib/mapper.js";

export function registerTaskCrudTools(server: McpServer, ctx: ServerContext): void {

  // --- tasknotes_list_tasks ---
  server.registerTool(
    "tasknotes_list_tasks",
    {
      description: "List tasks with optional pagination. Returns an array of task summaries.",
      inputSchema: {
        limit: z.number().optional().describe("Maximum number of tasks to return (default: 50)"),
        offset: z.number().optional().describe("Number of tasks to skip for pagination"),
      },
    },
    async ({ limit, offset }) => {
      const result = await ctx.collection.query({
        types: ["task"],
        limit: limit ?? 50,
        offset: offset ?? 0,
      });

      const tasks = ((result.results || []) as any[]).map((t) =>
        serializeTask(t, ctx.mapping),
      );

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

  // --- tasknotes_get_task ---
  server.registerTool(
    "tasknotes_get_task",
    {
      description: "Get a single task by its file path (id). Returns full task details including body content.",
      inputSchema: {
        id: z.string().describe("The file path of the task (e.g., 'tasks/my-task.md')"),
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

      const task = serializeTask(
        { path: id, frontmatter: read.frontmatter as Record<string, unknown>, body: read.body },
        ctx.mapping,
        true,
      );

      return {
        content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
      };
    },
  );

  // --- tasknotes_create_task ---
  server.registerTool(
    "tasknotes_create_task",
    {
      description: "Create a new task from structured input fields.",
      inputSchema: {
        title: z.string().describe("Task title"),
        status: z.string().optional().describe("Task status (e.g., 'open', 'in-progress', 'done')"),
        priority: z.string().optional().describe("Task priority (e.g., 'low', 'normal', 'high', 'urgent')"),
        due: z.string().optional().describe("Due date in YYYY-MM-DD format"),
        scheduled: z.string().optional().describe("Scheduled date in YYYY-MM-DD format"),
        tags: z.array(z.string()).optional().describe("Tags for the task"),
        contexts: z.array(z.string()).optional().describe("Contexts (e.g., 'home', 'office')"),
        projects: z.array(z.string()).optional().describe("Project names"),
        recurrence: z.string().optional().describe("RRULE recurrence string (e.g., 'FREQ=WEEKLY;BYDAY=MO')"),
        timeEstimate: z.number().optional().describe("Estimated time in minutes"),
        details: z.string().optional().describe("Task body/details in markdown"),
      },
    },
    async (params) => {
      const roleFrontmatter: Record<string, unknown> = { title: params.title };
      if (params.status !== undefined) roleFrontmatter.status = params.status;
      if (params.priority !== undefined) roleFrontmatter.priority = params.priority;
      if (params.due !== undefined) roleFrontmatter.due = params.due;
      if (params.scheduled !== undefined) roleFrontmatter.scheduled = params.scheduled;
      if (params.tags !== undefined) roleFrontmatter.tags = params.tags;
      if (params.contexts !== undefined) roleFrontmatter.contexts = params.contexts;
      if (params.projects !== undefined) {
        roleFrontmatter.projects = params.projects.map((p) => `[[projects/${p}]]`);
      }
      if (params.recurrence !== undefined) roleFrontmatter.recurrence = params.recurrence;
      if (params.timeEstimate !== undefined) roleFrontmatter.timeEstimate = params.timeEstimate;

      const result = await createTaskWithCompat(
        ctx.collection,
        ctx.mapping,
        roleFrontmatter,
        params.details,
      );

      if (result.error) {
        const msg = result.warnings
          ? `${result.error.message}\n${result.warnings.join("\n")}`
          : result.error.message;
        return {
          content: [{ type: "text", text: `Error creating task: ${msg}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            created: true,
            id: result.path,
            title: params.title,
          }, null, 2),
        }],
      };
    },
  );

  // --- tasknotes_create_task_from_text ---
  server.registerTool(
    "tasknotes_create_task_from_text",
    {
      description: "Create a task from natural language text. Parses dates, tags (#tag), contexts (@context), projects (+project), priority, recurrence, and time estimates.",
      inputSchema: {
        text: z.string().describe("Natural language task description (e.g., 'Buy groceries tomorrow #shopping @errands high priority')"),
      },
    },
    async ({ text }) => {
      const parsed = ctx.parser.parseInput(text);
      const { frontmatter: roleFm, body } = mapToFrontmatter(parsed);

      const result = await createTaskWithCompat(
        ctx.collection,
        ctx.mapping,
        roleFm as Record<string, unknown>,
        body,
      );

      if (result.error) {
        const msg = result.warnings
          ? `${result.error.message}\n${result.warnings.join("\n")}`
          : result.error.message;
        return {
          content: [{ type: "text", text: `Error creating task: ${msg}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            created: true,
            id: result.path,
            parsed: {
              title: parsed.title,
              dueDate: parsed.dueDate,
              scheduledDate: parsed.scheduledDate,
              priority: parsed.priority,
              tags: parsed.tags,
              contexts: parsed.contexts,
              projects: parsed.projects,
              recurrence: parsed.recurrence,
              estimate: parsed.estimate,
            },
          }, null, 2),
        }],
      };
    },
  );

  // --- tasknotes_update_task ---
  server.registerTool(
    "tasknotes_update_task",
    {
      description: "Update task fields. Pass null for a field to clear it. Only provided fields are changed.",
      inputSchema: {
        id: z.string().describe("The file path of the task"),
        title: z.string().nullable().optional().describe("New title, or null to clear"),
        status: z.string().nullable().optional().describe("New status, or null to clear"),
        priority: z.string().nullable().optional().describe("New priority, or null to clear"),
        due: z.string().nullable().optional().describe("New due date (YYYY-MM-DD), or null to clear"),
        scheduled: z.string().nullable().optional().describe("New scheduled date (YYYY-MM-DD), or null to clear"),
        tags: z.array(z.string()).nullable().optional().describe("New tags array, or null to clear"),
        contexts: z.array(z.string()).nullable().optional().describe("New contexts array, or null to clear"),
        projects: z.array(z.string()).nullable().optional().describe("New project names, or null to clear"),
        recurrence: z.string().nullable().optional().describe("New RRULE string, or null to clear"),
        timeEstimate: z.number().nullable().optional().describe("New estimate in minutes, or null to clear"),
        details: z.string().nullable().optional().describe("New body content, or null to clear"),
      },
    },
    async (params) => {
      const read = await ctx.collection.read(params.id);
      if (read.error) {
        return {
          content: [{ type: "text", text: `Error: ${read.error.message}` }],
          isError: true,
        };
      }

      const currentNorm = normalizeFrontmatter(
        read.frontmatter as Record<string, unknown>,
        ctx.mapping,
      );

      // Merge updates
      const updated: Record<string, unknown> = { ...currentNorm };
      const fieldKeys = [
        "title", "status", "priority", "due", "scheduled",
        "tags", "contexts", "recurrence", "timeEstimate",
      ] as const;

      for (const key of fieldKeys) {
        if (params[key] !== undefined) {
          if (params[key] === null) {
            delete updated[key];
          } else {
            updated[key] = params[key];
          }
        }
      }

      // Handle projects with wikilink wrapping
      if (params.projects !== undefined) {
        if (params.projects === null) {
          delete updated.projects;
        } else {
          updated.projects = params.projects.map((p) => `[[projects/${p}]]`);
        }
      }

      const denormalized = denormalizeFrontmatter(updated, ctx.mapping);

      const updateInput: Record<string, unknown> = {
        path: params.id,
        fields: denormalized,
      };

      if (params.details !== undefined) {
        updateInput.body = params.details;
      }

      const result = await (ctx.collection as any).update(updateInput);
      if (result.error) {
        return {
          content: [{ type: "text", text: `Error: ${result.error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ updated: true, id: params.id }, null, 2),
        }],
      };
    },
  );

  // --- tasknotes_delete_task ---
  server.registerTool(
    "tasknotes_delete_task",
    {
      description: "Delete a task by its file path (id).",
      inputSchema: {
        id: z.string().describe("The file path of the task to delete"),
      },
    },
    async ({ id }) => {
      const result = await (ctx.collection as any).delete(id);
      if (result?.error) {
        return {
          content: [{ type: "text", text: `Error: ${result.error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ deleted: true, id }, null, 2),
        }],
      };
    },
  );
}
