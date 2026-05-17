import { ZendeskClient } from "../zendesk-client.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MacroAction {
  field: string;
  value: string | string[] | null;
}

interface ZendeskMacro {
  id: number;
  title: string;
  active: boolean;
  actions: MacroAction[];
  restriction?: { type: string } | null;
  created_at?: string;
  updated_at?: string;
}

// ─── Known action fields (from Zendesk docs) ─────────────────────────────────

const VALID_ACTION_FIELDS = new Set([
  "status",
  "priority",
  "type",
  "assignee_id",
  "group_id",
  "follower",
  "subject",
  "comment_mode_is_public",
  "comment_value",
  "comment_value_html",
  "current_tags",
  "remove_tags",
  "set_tags",
  "satisfaction",
  "ticket_form_id",
  "custom_fields",
]);

const VALID_STATUSES = new Set(["open", "pending", "solved", "closed", "on-hold"]);
const VALID_PRIORITIES = new Set(["urgent", "high", "normal", "low"]);
const VALID_TYPES = new Set(["question", "incident", "problem", "task"]);

// ─── NL Spec Parser ───────────────────────────────────────────────────────────

/**
 * Parse a natural-language or structured spec into Zendesk macro actions[].
 * This parser handles common patterns. For complex specs, the LLM calling this
 * tool should pre-format the spec.
 */
function parseSpec(spec: string): { actions: MacroAction[]; warnings: string[] } {
  const actions: MacroAction[] = [];
  const warnings: string[] = [];

  const lower = spec.toLowerCase();

  // Status
  for (const status of VALID_STATUSES) {
    if (lower.includes(`status: ${status}`) || lower.includes(`set status to ${status}`) || lower.includes(`mark as ${status}`)) {
      actions.push({ field: "status", value: status });
      break;
    }
  }

  // Priority
  for (const priority of VALID_PRIORITIES) {
    if (lower.includes(`priority: ${priority}`) || lower.includes(`set priority to ${priority}`) || lower.includes(`${priority} priority`)) {
      actions.push({ field: "priority", value: priority });
      break;
    }
  }

  // Type
  for (const type of VALID_TYPES) {
    if (lower.includes(`type: ${type}`) || lower.includes(`set type to ${type}`)) {
      actions.push({ field: "type", value: type });
      break;
    }
  }

  // Tags to add
  const addTagMatch = spec.match(/add\s+tags?[:\s]+([^\n.;]+)/i);
  if (addTagMatch) {
    const tags = addTagMatch[1].split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (tags.length) actions.push({ field: "current_tags", value: tags.join(" ") });
  }

  // Set tags (replace)
  const setTagMatch = spec.match(/set\s+tags?[:\s]+([^\n.;]+)/i);
  if (setTagMatch) {
    const tags = setTagMatch[1].split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (tags.length) actions.push({ field: "set_tags", value: tags.join(" ") });
  }

  // Remove tags
  const removeTagMatch = spec.match(/remove\s+tags?[:\s]+([^\n.;]+)/i);
  if (removeTagMatch) {
    const tags = removeTagMatch[1].split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (tags.length) actions.push({ field: "remove_tags", value: tags.join(" ") });
  }

  // Comment body
  const commentMatch = spec.match(/(?:add\s+)?(?:public\s+)?comment[:\s]+"?([^"\n]+)"?/i);
  if (commentMatch) {
    actions.push({ field: "comment_value", value: commentMatch[1].trim() });
    // Detect if public or private
    if (lower.includes("internal") || lower.includes("private")) {
      actions.push({ field: "comment_mode_is_public", value: "false" });
    } else {
      actions.push({ field: "comment_mode_is_public", value: "true" });
    }
  }

  // Subject change
  const subjectMatch = spec.match(/(?:set\s+)?subject[:\s]+"?([^"\n]+)"?/i);
  if (subjectMatch) {
    actions.push({ field: "subject", value: subjectMatch[1].trim() });
  }

  if (actions.length === 0) {
    warnings.push(
      "Could not parse any actions from spec. Try a more explicit format like:\n" +
        '  "Set status to pending. Add tags: billing-query. Add comment: \\"We are looking into your issue.\\""'
    );
  }

  return { actions, warnings };
}

// ─── Create Macro From Spec ───────────────────────────────────────────────────

export async function createMacroFromSpec(
  client: ZendeskClient,
  args: {
    title: string;
    spec: string;
    dry_run?: boolean;
  }
): Promise<string> {
  const dryRun = args.dry_run !== false; // Default TRUE — safety first

  // Try to parse as JSON first (structured spec)
  let actions: MacroAction[];
  let warnings: string[] = [];

  try {
    const parsed = JSON.parse(args.spec) as MacroAction[];
    if (Array.isArray(parsed)) {
      actions = parsed;

      // Validate action fields
      for (const action of actions) {
        if (!VALID_ACTION_FIELDS.has(action.field)) {
          warnings.push(
            `⚠️ Unknown action field: "${action.field}". This may cause a Zendesk API error.`
          );
        }
      }
    } else {
      throw new Error("Not an array");
    }
  } catch {
    // Not JSON — parse as natural language
    const parsed = parseSpec(args.spec);
    actions = parsed.actions;
    warnings = parsed.warnings;
  }

  const macroPayload = {
    macro: {
      title: args.title,
      actions,
      active: true,
    },
  };

  if (dryRun) {
    return [
      `## 🔍 Dry-Run — Macro Preview`,
      `**Title**: ${args.title}`,
      `**Mode**: Preview only — macro NOT created`,
      ``,
      `### Actions to be created:`,
      "```json",
      JSON.stringify(actions, null, 2),
      "```",
      ``,
      warnings.length ? `### ⚠️ Warnings\n${warnings.map((w) => `- ${w}`).join("\n")}` : "",
      ``,
      `---`,
      `To create this macro, call \`create_macro_from_spec\` with \`dry_run: false\`.`,
      `Or modify the spec and preview again first.`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Validate before posting
  if (actions.length === 0) {
    return [
      `❌ Cannot create macro with 0 actions.`,
      ``,
      warnings.length ? warnings.join("\n") : "",
      `Revise your spec and try again.`,
    ].join("\n");
  }

  const result = await client.post<{ macro: ZendeskMacro }>(
    "/macros.json",
    macroPayload
  );

  const macro = result.macro;

  return [
    `## ✅ Macro Created — #${macro.id}`,
    `**Title**: ${macro.title}`,
    `**Active**: ${macro.active ? "Yes" : "No"}`,
    ``,
    `### Actions:`,
    "```json",
    JSON.stringify(macro.actions, null, 2),
    "```",
    ``,
    warnings.length ? `### ⚠️ Notes\n${warnings.map((w) => `- ${w}`).join("\n")}` : "",
    ``,
    `You can now use \`preview_macro_apply\` to test this macro against a specific ticket before applying.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── List Macros ──────────────────────────────────────────────────────────────

export async function listMacros(
  client: ZendeskClient,
  args: {
    active_only?: boolean;
    query?: string;
  }
): Promise<string> {
  let url = "/macros.json?per_page=50";
  if (args.active_only !== false) url += "&active=true";
  if (args.query) url += `&query=${encodeURIComponent(args.query)}`;

  const data = await client.get<{ macros: ZendeskMacro[]; count: number }>(url);

  if (!data.macros.length) {
    return `No macros found${args.query ? ` matching "${args.query}"` : ""}.`;
  }

  const lines = [
    `## Macros (${data.macros.length} shown of ${data.count} total)`,
    ``,
  ];

  for (const m of data.macros) {
    lines.push(
      `**#${m.id}** — ${m.title}`,
      `  Active: ${m.active ? "Yes" : "No"} | Actions: ${m.actions.length}`,
      ``
    );
  }

  return lines.join("\n");
}

// ─── Get Macro ────────────────────────────────────────────────────────────────

export async function getMacro(
  client: ZendeskClient,
  args: { macro_id: number }
): Promise<string> {
  const data = await client.get<{ macro: ZendeskMacro }>(
    `/macros/${args.macro_id}.json`
  );
  const m = data.macro;

  return [
    `## Macro #${m.id}: ${m.title}`,
    `- **Active**: ${m.active ? "Yes" : "No"}`,
    ``,
    `### Actions:`,
    "```json",
    JSON.stringify(m.actions, null, 2),
    "```",
  ].join("\n");
}
