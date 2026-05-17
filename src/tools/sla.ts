import { ZendeskClient } from "../zendesk-client.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TicketMetric {
  id: number;
  ticket_id: number;
  created_at: string;
  updated_at: string;
  first_reply_time_in_minutes?: { calendar?: number; business?: number };
  first_resolution_time_in_minutes?: { calendar?: number; business?: number };
  full_resolution_time_in_minutes?: { calendar?: number; business?: number };
  reply_time_in_minutes?: { calendar?: number; business?: number };
  reopens?: number;
  replies?: number;
  latest_comment_added_at?: string;
}

interface ZendeskTicketStub {
  id: number;
  subject: string;
  status: string;
  priority: string | null;
  created_at: string;
  updated_at: string;
  assignee_id: number | null;
  group_id: number | null;
  tags: string[];
}

interface SLAPolicy {
  id: number;
  title: string;
  description?: string;
}

// ─── List SLA Breaches ────────────────────────────────────────────────────────

/**
 * Find open tickets whose SLA has likely been breached.
 * Strategy: search for open/pending tickets, sort by oldest updated_at,
 * cross-reference with their metric data.
 *
 * Note: Zendesk's native SLA breach detection requires SLA policies (Professional+).
 * This tool uses a heuristic approach that works on all plans:
 * long-waiting open tickets flagged as likely breaches.
 */
export async function listSlaBreaches(
  client: ZendeskClient,
  args: {
    since?: string; // ISO date
    limit?: number;
    group_id?: number;
  }
): Promise<string> {
  const limit = Math.min(args.limit ?? 20, 50);
  const since = args.since ?? getPastDate(7);

  let query = `type:ticket status:open updated<${since} order_by:updated_at sort:asc`;
  if (args.group_id) query += ` group:${args.group_id}`;

  const searchData = await client.get<{
    results: ZendeskTicketStub[];
    count: number;
  }>(
    `/search.json?query=${encodeURIComponent(query)}&per_page=${limit}`
  );

  if (!searchData.results.length) {
    return `## ✅ No SLA Breaches Detected\n\nNo open tickets found that haven't been updated since ${since}.\n\n> Note: Search index may lag up to a few minutes. Re-run if you suspect fresher data.`;
  }

  // Enrich with metrics
  const enriched = await Promise.allSettled(
    searchData.results.map(async (ticket) => {
      try {
        const m = await client.get<{ ticket_metric: TicketMetric }>(
          `/tickets/${ticket.id}/metrics.json`
        );
        return { ticket, metric: m.ticket_metric };
      } catch {
        return { ticket, metric: null };
      }
    })
  );

  const lines = [
    `## 🔴 SLA Breach Radar`,
    ``,
    `Found **${searchData.results.length}** open tickets not updated since **${since}**.`,
    `*(Oldest-first — highest breach risk at top)*`,
    ``,
  ];

  let rank = 1;
  for (const result of enriched) {
    if (result.status === "rejected") continue;
    const { ticket, metric } = result.value;

    const waitDays = daysSince(ticket.updated_at);
    const calFRT = metric?.first_reply_time_in_minutes?.calendar;
    const frtNote = calFRT !== undefined
      ? ` | First reply: ${formatMinutes(calFRT)}`
      : "";

    lines.push(
      `**${rank}. #${ticket.id}** — ${ticket.subject}`,
      `   Status: ${ticket.status} | Priority: ${ticket.priority ?? "none"} | Group: ${ticket.group_id ?? "unassigned"}`,
      `   ⏱ Last updated **${waitDays} day(s) ago**${frtNote}`,
      `   Tags: ${ticket.tags.join(", ") || "—"}`,
      ``
    );
    rank++;
  }

  lines.push(`---`);
  lines.push(`> ⚠️ Search index may lag a few minutes. Breach detection is heuristic — verify critical tickets directly.`);
  lines.push(`> Use \`explain_ticket_sla\` for full metric detail on any ticket.`);

  return lines.join("\n");
}

// ─── Explain Ticket SLA ───────────────────────────────────────────────────────

export async function explainTicketSla(
  client: ZendeskClient,
  args: { ticket_id: number }
): Promise<string> {
  const [ticketData, metricsData] = await Promise.all([
    client.get<{ ticket: ZendeskTicketStub }>(`/tickets/${args.ticket_id}.json`),
    client.get<{ ticket_metric: TicketMetric }>(
      `/tickets/${args.ticket_id}/metrics.json`
    ),
  ]);

  const ticket = ticketData.ticket;
  const metric = metricsData.ticket_metric;

  const ageHours = hoursSince(ticket.created_at);
  const waitHours = hoursSince(ticket.updated_at);

  const lines = [
    `## 📊 SLA Story — Ticket #${ticket.id}`,
    `**${ticket.subject}**`,
    ``,
    `### Ticket Context`,
    `- **Status**: ${ticket.status}`,
    `- **Priority**: ${ticket.priority ?? "not set"}`,
    `- **Created**: ${formatDate(ticket.created_at)} (${formatHours(ageHours)} ago)`,
    `- **Last updated**: ${formatDate(ticket.updated_at)} (${formatHours(waitHours)} ago)`,
    `- **Assignee**: ${ticket.assignee_id ?? "unassigned"}`,
    ``,
    `### SLA Metrics`,
  ];

  const frt = metric.first_reply_time_in_minutes;
  if (frt?.calendar !== undefined) {
    lines.push(`- **First reply time**: ${formatMinutes(frt.calendar)} (calendar) | ${formatMinutes(frt.business ?? 0)} (business hours)`);
  } else {
    lines.push(`- **First reply time**: Not yet recorded`);
  }

  const firstRes = metric.first_resolution_time_in_minutes;
  if (firstRes?.calendar !== undefined) {
    lines.push(`- **First resolution time**: ${formatMinutes(firstRes.calendar)} (calendar)`);
  } else {
    lines.push(`- **First resolution time**: Not yet achieved`);
  }

  const fullRes = metric.full_resolution_time_in_minutes;
  if (fullRes?.calendar !== undefined) {
    lines.push(`- **Full resolution time**: ${formatMinutes(fullRes.calendar)} (calendar)`);
  } else {
    lines.push(`- **Full resolution time**: Not yet achieved`);
  }

  lines.push(`- **Reopens**: ${metric.reopens ?? 0}`);
  lines.push(`- **Replies**: ${metric.replies ?? 0}`);
  lines.push(``);

  // Plain-language risk assessment
  lines.push(`### Risk Assessment`);

  if (ticket.status === "open" || ticket.status === "pending") {
    if (waitHours > 48) {
      lines.push(`> 🔴 **HIGH RISK**: Ticket has been waiting ${formatHours(waitHours)} without an update. Immediate attention recommended.`);
    } else if (waitHours > 24) {
      lines.push(`> 🟡 **MEDIUM RISK**: Over 24 hours since last update. Review priority and assignee.`);
    } else {
      lines.push(`> 🟢 **LOW RISK**: Recently updated. Monitor if approaching SLA deadline.`);
    }
  } else {
    lines.push(`> Ticket status is **${ticket.status}** — no active SLA clock running.`);
  }

  lines.push(``);
  lines.push(`> ℹ️ Detailed breach detection requires SLA Policies (Zendesk Professional+). These metrics are from the Ticket Metrics API. For policy-specific targets, check your Zendesk SLA configuration.`);

  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPastDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split("T")[0];
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
}

function hoursSince(iso: string): number {
  return Math.round((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60));
}

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

function formatHours(hours: number): string {
  if (hours < 24) return `${hours}h`;
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${d}d ${h}h` : `${d}d`;
}
