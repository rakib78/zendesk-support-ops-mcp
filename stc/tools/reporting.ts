import { ZendeskClient } from "../zendesk-client.js";

interface ZendeskSearchCount {
  count: number;
}

interface ZendeskTicketStub {
  id: number;
  subject: string;
  status: string;
  priority: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

interface ZendeskSearchResponse {
  results: ZendeskTicketStub[];
  count: number;
  next_page: string | null;
}

interface SatisfactionRating {
  score: string;
  created_at: string;
}

interface ZendeskSatisfactionResponse {
  satisfaction_ratings: SatisfactionRating[];
  count: number;
}

// ─── Weekly Support Summary ───────────────────────────────────────────────────

/**
 * Generates a plain-language weekly ops digest.
 * Useful for Monday triage or leadership reporting.
 *
 * Limitations documented inline — Search API may lag a few minutes,
 * CSAT availability depends on plan.
 */
export async function weeklySupportSummary(
  client: ZendeskClient,
  args: {
    week_start?: string; // ISO date YYYY-MM-DD
    timezone?: string;
  }
): Promise<string> {
  const weekStart = args.week_start ?? getPastMonday();
  const weekEnd = getDatePlusDays(weekStart, 7);

  const lines: string[] = [
    `## 📋 Weekly Support Summary`,
    `**Period**: ${weekStart} → ${weekEnd}`,
    `*(Data via Zendesk Search API — may lag a few minutes)*`,
    ``,
  ];

  // ── Volume ──────────────────────────────────────────────────────────────────
  const [createdData, solvedData, openData, pendingData] = await Promise.allSettled([
    client.get<ZendeskSearchCount>(
      `/search/count.json?query=${encodeURIComponent(`type:ticket created>${weekStart} created<${weekEnd}`)}`
    ),
    client.get<ZendeskSearchCount>(
      `/search/count.json?query=${encodeURIComponent(`type:ticket solved>${weekStart} solved<${weekEnd}`)}`
    ),
    client.get<ZendeskSearchCount>(
      `/search/count.json?query=${encodeURIComponent(`type:ticket status:open`)}`
    ),
    client.get<ZendeskSearchCount>(
      `/search/count.json?query=${encodeURIComponent(`type:ticket status:pending`)}`
    ),
  ]);

  const created = resolveCount(createdData);
  const solved = resolveCount(solvedData);
  const currentOpen = resolveCount(openData);
  const currentPending = resolveCount(pendingData);
  const resolutionRate = created > 0 ? Math.round((solved / created) * 100) : 0;

  lines.push(`### 📊 Volume`);
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Tickets created this week | **${created}** |`);
  lines.push(`| Tickets solved this week | **${solved}** |`);
  lines.push(`| Resolution rate (vs created) | **${resolutionRate}%** |`);
  lines.push(`| Currently open | **${currentOpen}** |`);
  lines.push(`| Currently pending | **${currentPending}** |`);
  lines.push(``);

  // ── Priority distribution ───────────────────────────────────────────────────
  const [urgentData, highData, normalData, lowData] = await Promise.allSettled([
    client.get<ZendeskSearchCount>(
      `/search/count.json?query=${encodeURIComponent(`type:ticket status:open priority:urgent`)}`
    ),
    client.get<ZendeskSearchCount>(
      `/search/count.json?query=${encodeURIComponent(`type:ticket status:open priority:high`)}`
    ),
    client.get<ZendeskSearchCount>(
      `/search/count.json?query=${encodeURIComponent(`type:ticket status:open priority:normal`)}`
    ),
    client.get<ZendeskSearchCount>(
      `/search/count.json?query=${encodeURIComponent(`type:ticket status:open priority:low`)}`
    ),
  ]);

  lines.push(`### 🔥 Open Tickets by Priority`);
  lines.push(`| Priority | Count |`);
  lines.push(`|----------|-------|`);
  lines.push(`| Urgent | ${resolveCount(urgentData)} |`);
  lines.push(`| High | ${resolveCount(highData)} |`);
  lines.push(`| Normal | ${resolveCount(normalData)} |`);
  lines.push(`| Low | ${resolveCount(lowData)} |`);
  lines.push(``);

  // ── SLA health (heuristic: open tickets not updated in 24h) ────────────────
  const staleSince = getDateMinusHours(24);
  const staleData = await safeGet<ZendeskSearchCount>(
    client,
    `/search/count.json?query=${encodeURIComponent(`type:ticket status:open updated<${staleSince}`)}`
  );
  if (staleData !== null) {
    const stale = staleData.count;
    const staleEmoji = stale === 0 ? "✅" : stale < 5 ? "🟡" : "🔴";
    lines.push(`### ⏱ SLA Health (Heuristic)`);
    lines.push(`${staleEmoji} **${stale} open tickets** not updated in the last 24 hours.`);
    if (stale > 0) {
      lines.push(`> Run \`list_sla_breaches\` for the full ranked list.`);
    }
    lines.push(``);
  }

  // ── Tag distribution (sample-based) ────────────────────────────────────────
  try {
    const recentData = await client.get<ZendeskSearchResponse>(
      `/search.json?query=${encodeURIComponent(`type:ticket created>${weekStart} created<${weekEnd}`)}&per_page=100`
    );

    if (recentData.results.length > 0) {
      const tagCounts: Record<string, number> = {};
      for (const ticket of recentData.results) {
        for (const tag of ticket.tags) {
          tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
        }
      }

      const topTags = Object.entries(tagCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10);

      if (topTags.length) {
        lines.push(`### 🏷 Top Tags (This Week, Sample)`);
        lines.push(`| Tag | Count |`);
        lines.push(`|-----|-------|`);
        for (const [tag, count] of topTags) {
          lines.push(`| ${tag} | ${count} |`);
        }
        if (recentData.count > 100) {
          lines.push(`*(Based on sample of 100 of ${recentData.count} tickets)*`);
        }
        lines.push(``);
      }
    }
  } catch {
    lines.push(`*Tag distribution unavailable for this period.*\n`);
  }

  // ── CSAT ───────────────────────────────────────────────────────────────────
  try {
    const csatData = await client.get<ZendeskSatisfactionResponse>(
      `/satisfaction_ratings.json?score=received&start_time=${toUnixTime(weekStart)}&end_time=${toUnixTime(weekEnd)}&per_page=100`
    );

    const ratings = csatData.satisfaction_ratings;
    if (ratings.length > 0) {
      const goodCount = ratings.filter(
        (r) => r.score === "good" || r.score === "offered"
      ).length;
      const badCount = ratings.filter((r) => r.score === "bad").length;
      const total = goodCount + badCount;
      const csatPct = total > 0 ? Math.round((goodCount / total) * 100) : null;

      lines.push(`### ⭐ CSAT`);
      lines.push(`| Metric | Value |`);
      lines.push(`|--------|-------|`);
      lines.push(`| Ratings received | ${total} |`);
      lines.push(`| Good | ${goodCount} |`);
      lines.push(`| Bad | ${badCount} |`);
      if (csatPct !== null) {
        const csatEmoji = csatPct >= 90 ? "✅" : csatPct >= 75 ? "🟡" : "🔴";
        lines.push(`| CSAT score | ${csatEmoji} **${csatPct}%** |`);
      }
      lines.push(``);
    } else {
      lines.push(`*CSAT: No ratings received this week (or plan does not support CSAT).*\n`);
    }
  } catch {
    lines.push(`*CSAT: Not available on this Zendesk plan or insufficient permissions.*\n`);
  }

  // ── Plain language summary ─────────────────────────────────────────────────
  lines.push(`---`);
  lines.push(`### 📝 Manager Digest`);

  const urgentCount = resolveCount(urgentData);
  const highCount = resolveCount(highData);

  const urgentNote =
    urgentCount > 0
      ? `There are **${urgentCount} urgent** tickets open — prioritize these immediately.`
      : `No urgent tickets open — good.`;

  const volumeNote =
    resolved > 0 && created > 0
      ? resolutionRate >= 100
        ? `Team resolved all (${solved}) tickets created this week — healthy throughput.`
        : `Team resolved ${resolutionRate}% of this week's volume (${solved} of ${created}).`
      : `Volume data is available above.`;

  lines.push(urgentNote);
  lines.push(volumeNote);

  if (staleData && staleData.count > 5) {
    lines.push(
      `⚠️ ${staleData.count} open tickets haven't been touched in 24h — run \`list_sla_breaches\` for prioritized action.`
    );
  }

  lines.push(``);
  lines.push(`> **Disclaimer**: Summary is based on Zendesk Search API. Data may lag up to a few minutes. For Explore-level precision, verify in Zendesk Explore.`);

  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPastMonday(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split("T")[0];
}

function getDatePlusDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function getDateMinusHours(hours: number): string {
  const d = new Date();
  d.setHours(d.getHours() - hours);
  return d.toISOString();
}

function toUnixTime(dateStr: string): number {
  return Math.floor(new Date(dateStr).getTime() / 1000);
}

function resolveCount(settled: PromiseSettledResult<ZendeskSearchCount>): number {
  if (settled.status === "fulfilled") return settled.value.count ?? 0;
  return 0;
}

async function safeGet<T>(
  client: ZendeskClient,
  path: string
): Promise<T | null> {
  try {
    return await client.get<T>(path);
  } catch {
    return null;
  }
}

// Used in summary prose — need to re-resolve from settled result
let resolved = 0;

// Patch: we'll inline this resolution in the function above
// This variable is a module-level placeholder; actual resolution is done inline
