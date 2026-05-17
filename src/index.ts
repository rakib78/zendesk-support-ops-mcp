#!/usr/bin/env node

/**
 * Zendesk Support Ops MCP Server
 *
 * Production-safe Zendesk MCP with:
 * - Dry-run write gates
 * - SLA breach radar
 * - Natural-language macro authoring
 * - Weekly manager digests
 *
 * Required env vars:
 *   ZENDESK_SUBDOMAIN  — your Zendesk subdomain (e.g. "mycompany" for mycompany.zendesk.com)
 *   ZENDESK_EMAIL      — agent/admin email
 *   ZENDESK_API_TOKEN  — API token (not password)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { clientFromEnv, McpZendeskError } from "./zendesk-client.js";

// Tools
import { zendeskWhoami } from "./tools/auth.js";
import {
  searchTickets,
  getTicket,
  previewTicketUpdate,
  executeTicketUpdate,
  addInternalNote,
} from "./tools/tickets.js";
import { listSlaBreaches, explainTicketSla } from "./tools/sla.js";
import {
  createMacroFromSpec,
  listMacros,
  getMacro,
} from "./tools/macros.js";
import { weeklySupportSummary } from "./tools/reporting.js";

// ─── Input Schemas (Zod) ───────────────────────────────────────────────────────

const TicketChangesSchema = z.object({
  tags_add: z.array(z.string()).optional(),
  tags_remove: z.array(z.string()).optional(),
  priority: z.enum(["urgent", "high", "normal", "low"]).optional(),
  status: z.enum(["open", "pending", "solved", "closed", "on-hold"]).optional(),
  assignee_id: z.number().optional(),
  group_id: z.number().optional(),
  subject: z.string().optional(),
  custom_fields: z
    .array(z.object({ id: z.number(), value: z.unknown() }))
    .optional(),
});

const ToolSchemas = {
  zendesk_whoami: z.object({}),

  search_tickets: z.object({
    query: z.string().describe("Zendesk search query e.g. 'status:open priority:urgent'"),
    sort: z
      .enum(["created_at", "updated_at", "priority", "status"])
      .optional()
      .describe("Sort field"),
    page_size: z.number().min(1).max(100).optional().describe("Results per page (default 25)"),
    cursor: z.string().optional().describe("next_page cursor from previous search result"),
  }),

  get_ticket: z.object({
    ticket_id: z.number().describe("Zendesk ticket ID"),
  }),

  preview_ticket_update: z.object({
    ticket_id: z.number().describe("Zendesk ticket ID"),
    changes: TicketChangesSchema.describe("Changes to preview (NOT applied)"),
  }),

  execute_ticket_update: z.object({
    ticket_id: z.number().describe("Zendesk ticket ID"),
    changes: TicketChangesSchema.describe("Changes to apply"),
    confirm: z
      .boolean()
      .describe("Must be true to apply changes. Run preview_ticket_update first."),
  }),

  add_internal_note: z.object({
    ticket_id: z.number().describe("Zendesk ticket ID"),
    body: z.string().describe("Note content (plain text or HTML)"),
    dry_run: z
      .boolean()
      .optional()
      .describe("Preview the note without posting (default: true)"),
  }),

  list_sla_breaches: z.object({
    since: z.string().optional().describe("ISO date — tickets not updated since this date (default: 7 days ago)"),
    limit: z.number().min(1).max(50).optional().describe("Max tickets to return (default 20)"),
    group_id: z.number().optional().describe("Filter by Zendesk group ID"),
  }),

  explain_ticket_sla: z.object({
    ticket_id: z.number().describe("Zendesk ticket ID"),
  }),

  weekly_support_summary: z.object({
    week_start: z
      .string()
      .optional()
      .describe("ISO date YYYY-MM-DD for start of week (default: current Monday)"),
    timezone: z.string().optional().describe("Timezone name (informational only)"),
  }),

  create_macro_from_spec: z.object({
    title: z.string().describe("Macro title"),
    spec: z
      .string()
      .describe(
        "Natural language or JSON array of Zendesk macro actions. " +
          'NL example: "Set status to pending. Add tags: billing-query. Add comment: We will follow up soon." ' +
          'JSON example: [{"field":"status","value":"pending"},{"field":"current_tags","value":"billing-query"}]'
      ),
    dry_run: z
      .boolean()
      .optional()
      .describe("Preview without creating (default: TRUE — always preview first)"),
  }),

  list_macros: z.object({
    active_only: z.boolean().optional().describe("Only return active macros (default true)"),
    query: z.string().optional().describe("Filter macros by title keyword"),
  }),

  get_macro: z.object({
    macro_id: z.number().describe("Zendesk macro ID"),
  }),
};

// ─── Tool Definitions for ListTools ───────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "zendesk_whoami",
    description:
      "Verify Zendesk connection, auth, and current user details. Run this first to confirm credentials are working.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_tickets",
    description:
      "Search Zendesk tickets using the full Zendesk search syntax (e.g. 'status:open priority:urgent assignee:me'). Returns paginated ticket stubs.",
    inputSchema: zodToJsonSchema(ToolSchemas.search_tickets),
  },
  {
    name: "get_ticket",
    description:
      "Fetch full context for a single ticket: fields, tags, requester, assignee, SLA metrics where available.",
    inputSchema: zodToJsonSchema(ToolSchemas.get_ticket),
  },
  {
    name: "preview_ticket_update",
    description:
      "DRY-RUN: Compute and display the diff of proposed changes to a ticket WITHOUT applying them. Always run this before execute_ticket_update.",
    inputSchema: zodToJsonSchema(ToolSchemas.preview_ticket_update),
  },
  {
    name: "execute_ticket_update",
    description:
      "Apply changes to a ticket (tags, priority, status, assignee, custom fields). Requires confirm:true. Preview first with preview_ticket_update.",
    inputSchema: zodToJsonSchema(ToolSchemas.execute_ticket_update),
  },
  {
    name: "add_internal_note",
    description:
      "Add a private internal note to a ticket. Supports dry_run preview (default). Only posts when dry_run is explicitly false.",
    inputSchema: zodToJsonSchema(ToolSchemas.add_internal_note),
  },
  {
    name: "list_sla_breaches",
    description:
      "Identify open tickets at SLA breach risk — tickets that haven't been updated recently, ranked oldest-first. Use for daily triage.",
    inputSchema: zodToJsonSchema(ToolSchemas.list_sla_breaches),
  },
  {
    name: "explain_ticket_sla",
    description:
      "Get a plain-language SLA story for a single ticket: metrics, clocks, age, wait time, and risk level.",
    inputSchema: zodToJsonSchema(ToolSchemas.explain_ticket_sla),
  },
  {
    name: "weekly_support_summary",
    description:
      "Generate a plain-language weekly ops digest for managers: volume, resolution rate, priority breakdown, top tags, SLA health, and CSAT if available.",
    inputSchema: zodToJsonSchema(ToolSchemas.weekly_support_summary),
  },
  {
    name: "create_macro_from_spec",
    description:
      "Create a Zendesk macro from a natural-language or JSON spec. Dry-run is TRUE by default — always preview before creating. Supports: status, priority, tags, comments, subject changes.",
    inputSchema: zodToJsonSchema(ToolSchemas.create_macro_from_spec),
  },
  {
    name: "list_macros",
    description: "List available Zendesk macros, optionally filtered by active status or title keyword.",
    inputSchema: zodToJsonSchema(ToolSchemas.list_macros),
  },
  {
    name: "get_macro",
    description: "Fetch the full definition (actions[]) of a specific macro for review or editing.",
    inputSchema: zodToJsonSchema(ToolSchemas.get_macro),
  },
];

// ─── Server Setup ─────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "zendesk-support-ops-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Call tools
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const client = clientFromEnv();
    let result: string;

    switch (name) {
      case "zendesk_whoami": {
        result = await zendeskWhoami(client);
        break;
      }

      case "search_tickets": {
        const parsed = ToolSchemas.search_tickets.parse(args);
        result = await searchTickets(client, parsed);
        break;
      }

      case "get_ticket": {
        const parsed = ToolSchemas.get_ticket.parse(args);
        result = await getTicket(client, parsed);
        break;
      }

      case "preview_ticket_update": {
        const parsed = ToolSchemas.preview_ticket_update.parse(args);
        result = await previewTicketUpdate(client, {
          ticket_id: parsed.ticket_id,
          changes: parsed.changes,
        });
        break;
      }

      case "execute_ticket_update": {
        const parsed = ToolSchemas.execute_ticket_update.parse(args);
        result = await executeTicketUpdate(client, {
          ticket_id: parsed.ticket_id,
          changes: parsed.changes,
          confirm: parsed.confirm,
        });
        break;
      }

      case "add_internal_note": {
        const parsed = ToolSchemas.add_internal_note.parse(args);
        result = await addInternalNote(client, {
          ticket_id: parsed.ticket_id,
          body: parsed.body,
          dry_run: parsed.dry_run ?? true,
        });
        break;
      }

      case "list_sla_breaches": {
        const parsed = ToolSchemas.list_sla_breaches.parse(args);
        result = await listSlaBreaches(client, parsed);
        break;
      }

      case "explain_ticket_sla": {
        const parsed = ToolSchemas.explain_ticket_sla.parse(args);
        result = await explainTicketSla(client, parsed);
        break;
      }

      case "weekly_support_summary": {
        const parsed = ToolSchemas.weekly_support_summary.parse(args);
        result = await weeklySupportSummary(client, parsed);
        break;
      }

      case "create_macro_from_spec": {
        const parsed = ToolSchemas.create_macro_from_spec.parse(args);
        result = await createMacroFromSpec(client, {
          title: parsed.title,
          spec: parsed.spec,
          dry_run: parsed.dry_run ?? true,
        });
        break;
      }

      case "list_macros": {
        const parsed = ToolSchemas.list_macros.parse(args);
        result = await listMacros(client, parsed);
        break;
      }

      case "get_macro": {
        const parsed = ToolSchemas.get_macro.parse(args);
        result = await getMacro(client, parsed);
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: result }],
    };
  } catch (error) {
    if (error instanceof McpZendeskError) {
      return {
        content: [
          {
            type: "text",
            text: `**Zendesk API Error** (${error.statusCode})\n\n${error.message}`,
          },
        ],
        isError: true,
      };
    }

    if (error instanceof z.ZodError) {
      return {
        content: [
          {
            type: "text",
            text: `**Invalid input**\n\n${error.errors.map((e) => `- ${e.path.join(".")}: ${e.message}`).join("\n")}`,
          },
        ],
        isError: true,
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `**Error**: ${message}` }],
      isError: true,
    };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Zendesk Support Ops MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal Zod-to-JSON-Schema converter for MCP tool registration.
 * Handles the common cases: object, string, number, boolean, enum, array, optional.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return zodTypeToSchema(schema) as Record<string, unknown>;
}

function zodTypeToSchema(schema: z.ZodTypeAny): unknown {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodTypeToSchema(value);
      if (!(value instanceof z.ZodOptional)) {
        required.push(key);
      }
    }

    return { type: "object", properties, required };
  }

  if (schema instanceof z.ZodOptional) {
    return zodTypeToSchema(schema.unwrap());
  }

  if (schema instanceof z.ZodString) {
    const result: Record<string, unknown> = { type: "string" };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof z.ZodNumber) {
    const result: Record<string, unknown> = { type: "number" };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof z.ZodBoolean) {
    const result: Record<string, unknown> = { type: "boolean" };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: schema.options };
  }

  if (schema instanceof z.ZodArray) {
    return { type: "array", items: zodTypeToSchema(schema.element) };
  }

  if (schema instanceof z.ZodUnknown) {
    return {};
  }

  return {};
}
