import { ZendeskClient } from "../zendesk-client.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ZendeskTicket {
  id: number;
  subject: string;
  status: string;
  priority: string | null;
  type: string | null;
  tags: string[];
  assignee_id: number | null;
  group_id: number | null;
  requester_id: number;
  created_at: string;
  updated_at: string;
  description: string;
  custom_fields?: Array<{ id: number; value: unknown }>;
  via?: { channel: string };
}

interface ZendeskSearchResponse {
  results: ZendeskTicket[];
  next_page: string | null;
  previous_page: string | null;
  count: number;
}

interface TicketChanges {
  tags_add?: string[];
  tags_remove?: string[];
  priority?: "urgent" | "high" | "normal" | "low";
  status?: "open" | "pending" | "solved" | "closed" | "on-hold";
  assignee_id?: number;
  group_id?: number;
  custom_fields?: Array<{ id: number; value?: unknown }>;
  subject?: string;
}

// ─── Search Tickets ───────────────────────────────────────────────────────────

export async function searchTickets(
  client: ZendeskClient,
  args: {
    query: string;
    sort?: "created_at" | "updated_at" | "priority" | "status";
    page_size?: number;
    cursor?: string;
  }
): Promise<string> {
  const pageSize = Math.min(args.page_size ?? 25, 100);
  const sort = args.sort ?? "updated_at";

  let url = `/search.json?query=${encodeURIComponent(args.query)}&sort_by=${sort}&sort_order=desc&per_page=${pageSize}`;
  if (args.cursor) {
    url = args.cursor; // use next_page cursor directly
  }

  const data = await client.get<ZendeskSearchResponse>(url);

  if (data.results.length === 0) {
    return `No tickets found for query: \`${args.query}\``;
  }

  const lines = [
    `## Search Results — ${data.count} total`,
    `Showing ${data.results.length} tickets (sorted by ${sort})`,
    ``,
  ];

  for (const t of data.results) {
    lines.push(
      `**#${t.id}** — ${t.subject}`,
      `  Status: ${t.status} | Priority: ${t.priority ?? "none"} | Updated: ${formatDate(t.updated_at)}`,
      `  Tags: ${t.tags.length ? t.tags.join(", ") : "—"}`,
      ``
    );
  }

  if (data.next_page) {
    lines.push(`---`);
    lines.push(`**Next page cursor**: \`${data.next_page}\``);
    lines.push(`Use \`cursor: "${data.next_page}"\` to fetch next page.`);
  }

  return lines.join("\n");
}

// ─── Get Ticket ───────────────────────────────────────────────────────────────

export async function getTicket(
  client: ZendeskClient,
  args: { ticket_id: number }
): Promise<string> {
  const data = await client.get<{ ticket: ZendeskTicket }>(
    `/tickets/${args.ticket_id}.json`
  );
  const t = data.ticket;

  // Also fetch SLA-relevant metric if available
  let slaInfo = "";
  try {
    const metrics = await client.get<{
      ticket_metric: {
        first_resolution_time_in_minutes?: { calendar?: number };
        full_resolution_time_in_minutes?: { calendar?: number };
        reply_time_in_minutes?: { calendar?: number };
      };
    }>(`/tickets/${args.ticket_id}/metrics.json`);
    const m = metrics.ticket_metric;
    const parts = [];
    if (m.reply_time_in_minutes?.calendar !== undefined) {
      parts.push(`FRT: ${formatMinutes(m.reply_time_in_minutes.calendar)}`);
    }
    if (m.first_resolution_time_in_minutes?.calendar !== undefined) {
      parts.push(
        `First resolution: ${formatMinutes(m.first_resolution_time_in_minutes.calendar)}`
      );
    }
    if (parts.length) slaInfo = `\n- **SLA metrics**: ${parts.join(" | ")}`;
  } catch {
    // Metrics may not be available — skip
  }

  return [
    `## Ticket #${t.id}: ${t.subject}`,
    ``,
    `- **Status**: ${t.status}`,
    `- **Priority**: ${t.priority ?? "not set"}`,
    `- **Type**: ${t.type ?? "not set"}`,
    `- **Requester ID**: ${t.requester_id}`,
    `- **Assignee ID**: ${t.assignee_id ?? "unassigned"}`,
    `- **Group ID**: ${t.group_id ?? "none"}`,
    `- **Channel**: ${t.via?.channel ?? "unknown"}`,
    `- **Tags**: ${t.tags.length ? t.tags.join(", ") : "none"}`,
    `- **Created**: ${formatDate(t.created_at)}`,
    `- **Updated**: ${formatDate(t.updated_at)}`,
    slaInfo,
    ``,
    `### Description`,
    t.description ?? "(no description)",
    ``,
    t.custom_fields?.length
      ? `### Custom Fields\n${t.custom_fields
          .map((f) => `- Field ${f.id}: ${JSON.stringify(f.value)}`)
          .join("\n")}`
      : "",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

// ─── Preview Ticket Update (Dry-run) ──────────────────────────────────────────

export async function previewTicketUpdate(
  client: ZendeskClient,
  args: { ticket_id: number; changes: TicketChanges }
): Promise<string> {
  // Fetch current state
  const data = await client.get<{ ticket: ZendeskTicket }>(
    `/tickets/${args.ticket_id}.json`
  );
  const current = data.ticket;
  const changes = args.changes;

  const diff: string[] = [];
  const warnings: string[] = [];

  // Tag changes
  if (changes.tags_add?.length || changes.tags_remove?.length) {
    const currentTags = new Set(current.tags);
    const addedTags = changes.tags_add ?? [];
    const removedTags = changes.tags_remove ?? [];

    const alreadyPresent = addedTags.filter((t) => currentTags.has(t));
    const notPresent = removedTags.filter((t) => !currentTags.has(t));

    if (alreadyPresent.length)
      warnings.push(`Tags already present (no-op): ${alreadyPresent.join(", ")}`);
    if (notPresent.length)
      warnings.push(`Tags not on ticket (no-op remove): ${notPresent.join(", ")}`);

    const resultTags = [...currentTags, ...addedTags].filter(
      (t) => !removedTags.includes(t)
    );
    diff.push(
      `**Tags**`,
      `  Before: [${current.tags.join(", ")}]`,
      `  After:  [${resultTags.join(", ")}]`,
      `  Add: ${addedTags.join(", ") || "—"} | Remove: ${removedTags.join(", ") || "—"}`
    );
  }

  // Priority
  if (changes.priority && changes.priority !== current.priority) {
    diff.push(
      `**Priority**: ${current.priority ?? "none"} → ${changes.priority}`
    );
  } else if (changes.priority === current.priority) {
    warnings.push(`Priority already set to ${changes.priority} (no-op)`);
  }

  // Status
  if (changes.status && changes.status !== current.status) {
    if (current.status === "closed") {
      warnings.push(
        `⚠️ Attempting to change status of a CLOSED ticket — Zendesk blocks this via API`
      );
    }
    diff.push(`**Status**: ${current.status} → ${changes.status}`);
  }

  // Assignee
  if (changes.assignee_id !== undefined && changes.assignee_id !== current.assignee_id) {
    diff.push(
      `**Assignee ID**: ${current.assignee_id ?? "unassigned"} → ${changes.assignee_id}`
    );
  }

  // Group
  if (changes.group_id !== undefined && changes.group_id !== current.group_id) {
    diff.push(`**Group ID**: ${current.group_id ?? "none"} → ${changes.group_id}`);
  }

  // Custom fields
  if (changes.custom_fields?.length) {
    diff.push(`**Custom fields to update**: ${changes.custom_fields.length} field(s)`);
    for (const f of changes.custom_fields) {
      const existing = current.custom_fields?.find((cf) => cf.id === f.id);
      diff.push(
        `  Field ${f.id}: ${JSON.stringify(existing?.value ?? null)} → ${JSON.stringify(f.value)}`
      );
    }
  }

  if (diff.length === 0 && warnings.length === 0) {
    return `No effective changes detected for ticket #${args.ticket_id}. All values are already as specified.`;
  }

  return [
    `## 🔍 Dry-Run Preview — Ticket #${args.ticket_id}`,
    `**No changes have been applied.**`,
    ``,
    diff.length ? `### Changes` : "",
    ...diff,
    ``,
    warnings.length ? `### ⚠️ Warnings` : "",
    ...warnings.map((w) => `- ${w}`),
    ``,
    `---`,
    `To apply these changes, call \`execute_ticket_update\` with \`confirm: true\`.`,
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

// ─── Execute Ticket Update ────────────────────────────────────────────────────

export async function executeTicketUpdate(
  client: ZendeskClient,
  args: {
    ticket_id: number;
    changes: TicketChanges;
    confirm: boolean;
  }
): Promise<string> {
  if (!args.confirm) {
    return [
      `⛔ Execution blocked: \`confirm\` must be \`true\` to apply changes.`,
      ``,
      `Run \`preview_ticket_update\` first to review the diff, then re-call with \`confirm: true\`.`,
    ].join("\n");
  }

  // Fetch current tags to compute final tag set
  const currentData = await client.get<{ ticket: ZendeskTicket }>(
    `/tickets/${args.ticket_id}.json`
  );
  const current = currentData.ticket;
  const changes = args.changes;

  const updatePayload: Record<string, unknown> = {};

  if (changes.tags_add?.length || changes.tags_remove?.length) {
    const currentTags = new Set(current.tags);
    (changes.tags_add ?? []).forEach((t) => currentTags.add(t));
    (changes.tags_remove ?? []).forEach((t) => currentTags.delete(t));
    updatePayload.tags = [...currentTags];
  }

  if (changes.priority) updatePayload.priority = changes.priority;
  if (changes.status) updatePayload.status = changes.status;
  if (changes.assignee_id !== undefined) updatePayload.assignee_id = changes.assignee_id;
  if (changes.group_id !== undefined) updatePayload.group_id = changes.group_id;
  if (changes.subject) updatePayload.subject = changes.subject;
  if (changes.custom_fields) updatePayload.custom_fields = changes.custom_fields;

  const result = await client.put<{ ticket: ZendeskTicket }>(
    `/tickets/${args.ticket_id}.json`,
    { ticket: updatePayload }
  );

  const t = result.ticket;

  return [
    `## ✅ Ticket #${args.ticket_id} Updated`,
    ``,
    `- **Status**: ${t.status}`,
    `- **Priority**: ${t.priority ?? "none"}`,
    `- **Tags**: ${t.tags.join(", ") || "none"}`,
    `- **Assignee ID**: ${t.assignee_id ?? "unassigned"}`,
    `- **Updated at**: ${formatDate(t.updated_at)}`,
    ``,
    `Changes applied successfully.`,
  ].join("\n");
}

// ─── Add Internal Note ────────────────────────────────────────────────────────

export async function addInternalNote(
  client: ZendeskClient,
  args: {
    ticket_id: number;
    body: string;
    dry_run?: boolean;
  }
): Promise<string> {
  if (args.dry_run) {
    return [
      `## 🔍 Dry-Run — Internal Note Preview`,
      `**Ticket**: #${args.ticket_id}`,
      `**Type**: Private / internal comment`,
      ``,
      `**Note content**:`,
      args.body,
      ``,
      `No note has been added. Set \`dry_run: false\` to post it.`,
    ].join("\n");
  }

  const result = await client.put<{ ticket: ZendeskTicket }>(
    `/tickets/${args.ticket_id}.json`,
    {
      ticket: {
        comment: {
          body: args.body,
          public: false,
        },
      },
    }
  );

  return [
    `## ✅ Internal Note Added — Ticket #${args.ticket_id}`,
    ``,
    `Note posted as private comment.`,
    `Updated at: ${formatDate(result.ticket.updated_at)}`,
  ].join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }) + " UTC";
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
