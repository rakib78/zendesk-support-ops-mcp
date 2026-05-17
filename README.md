# Zendesk Support Ops MCP

> Production-safe Zendesk MCP for Claude, Cursor, and any MCP-compatible AI assistant.
> Dry-run ticket writes · SLA breach radar · NL macro authoring · Weekly manager digest.

[![MCPize](https://img.shields.io/badge/MCPize-Marketplace-blue)](https://mcpize.com/mcp/zendesk-support-ops-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## Why this server exists

Zendesk powers 100,000+ support teams. Every existing MCP server for Zendesk falls into the same pattern: ticket search plus basic reads, with write access bolted on as an afterthought. None of them treat **safety**, **SLA intelligence**, or **macro authoring** as first-class product features.

This server is built for teams where an AI making an unreviewed edit to a live ticket is a real problem — not a theoretical one.

**Four things it solves that others don't:**

| Gap | What this server does |
|-----|-----------------------|
| Write access without guardrails | Every write defaults to dry-run. Execution requires `confirm: true`. |
| Manual SLA hunting | `list_sla_breaches` surfaces at-risk tickets ranked by wait time |
| Macro authoring via UI clicking | Natural language or JSON → validated `actions[]` → preview → create |
| Explore reports only | `weekly_support_summary` gives a paste-ready Monday digest in one call |

---

## Quick Start

### 1. Get a Zendesk API token

In Zendesk: **Admin Center → Apps and Integrations → APIs → Zendesk API → Add API token**

Keep your subdomain handy — it's the part before `.zendesk.com`.

### 2. Add to Claude Desktop

Open `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) and add:

```json
{
  "mcpServers": {
    "zendesk-support-ops": {
      "command": "npx",
      "args": ["-y", "zendesk-support-ops-mcp"],
      "env": {
        "ZENDESK_SUBDOMAIN": "your-subdomain",
        "ZENDESK_EMAIL": "you@yourcompany.com",
        "ZENDESK_API_TOKEN": "your_api_token_here"
      }
    }
  }
}
```

Restart Claude Desktop. Run `zendesk_whoami` to confirm the connection.

### 3. Or use via MCPize

Subscribe at [mcpize.com/mcp/zendesk-support-ops-mcp](https://mcpize.com/mcp/zendesk-support-ops-mcp) — enter your credentials once, get an MCP endpoint you can use in any compatible client.

---

## Tools

### Connection

| Tool | What it does |
|------|-------------|
| `zendesk_whoami` | Verify subdomain, auth, and user role. Run this first. |

### Tickets

| Tool | What it does |
|------|-------------|
| `search_tickets` | Full Zendesk search syntax with pagination cursor support |
| `get_ticket` | Full ticket context: fields, tags, SLA metrics, channel, assignee |
| `preview_ticket_update` | **Dry-run** — shows exact diff for tag/priority/status/assignee changes, no execution |
| `execute_ticket_update` | Apply changes (requires `confirm: true`) |
| `add_internal_note` | Add private comment — dry-run previews by default |

### SLA

| Tool | What it does |
|------|-------------|
| `list_sla_breaches` | Open tickets ranked by breach risk (oldest-wait-first) |
| `explain_ticket_sla` | Plain-language SLA story: FRT, resolution time, wait, risk verdict |

### Macros

| Tool | What it does |
|------|-------------|
| `create_macro_from_spec` | NL or JSON spec → validated `actions[]` → optional create. **Dry-run default: true** |
| `list_macros` | Browse macro library, filter by active/title |
| `get_macro` | Fetch full macro definition for review or editing |

### Reporting

| Tool | What it does |
|------|-------------|
| `weekly_support_summary` | Monday digest: volume, resolution rate, priority breakdown, top tags, SLA health, CSAT |

---

## Example Conversations

**Morning triage:**
```
"Show me all SLA breaches from the last 3 days for group 12345"
→ list_sla_breaches since:2025-01-13 group_id:12345

"Explain the SLA situation on ticket 98765"
→ explain_ticket_sla ticket_id:98765
```

**Safe ticket update:**
```
"Preview adding tag 'escalated' and changing priority to urgent on ticket 11111"
→ preview_ticket_update ticket_id:11111 changes:{tags_add:["escalated"], priority:"urgent"}

"Looks good, apply it"
→ execute_ticket_update ticket_id:11111 changes:{...} confirm:true
```

**Macro from spec:**
```
"Create a macro called 'Billing Hold': set status pending, add tag billing-query,
 add public comment 'We are reviewing your billing question and will respond within 24 hours.'"
→ create_macro_from_spec title:"Billing Hold" spec:"..." dry_run:true
→ [review the actions[]]
→ create_macro_from_spec ... dry_run:false
```

**Weekly report:**
```
"Generate the weekly support summary for the week starting 2025-01-13"
→ weekly_support_summary week_start:2025-01-13
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZENDESK_SUBDOMAIN` | ✅ | Subdomain only — e.g. `acme` for `acme.zendesk.com` |
| `ZENDESK_EMAIL` | ✅ | Agent or admin email for API token auth |
| `ZENDESK_API_TOKEN` | ✅ | API token (not your password) |

---

## Safety Model

This server treats safety as a product feature, not an afterthought:

- **Default dry-run on all writes** — `preview_ticket_update`, `add_internal_note`, and `create_macro_from_spec` all preview by default
- **Explicit confirm gate** — `execute_ticket_update` requires `confirm: true` or it blocks
- **Structured permission errors** — if your token lacks scope for an operation, you get a clear message explaining what's missing, not a silent failure
- **Rate limit handling** — 429 responses surface with `Retry-After` guidance; the client backs off automatically with exponential retry

---

## Limitations

- **SLA breach detection is heuristic** — tickets not updated recently are flagged as at-risk. Precise policy breach times require Zendesk Professional+ with SLA policies configured. `explain_ticket_sla` uses the Ticket Metrics API which is available on all plans.
- **Search index lag** — Zendesk's Search API can lag a few minutes. All relevant tools note this in their output.
- **CSAT availability** — depends on your Zendesk plan. `weekly_support_summary` degrades gracefully if satisfaction ratings are unavailable.
- **Search result cap** — Zendesk Search API has a practical limit of ~1,000 results per query. Use filters to narrow large instances.

---

## Local Development

```bash
git clone https://github.com/rakib78/zendesk-support-ops-mcp
cd zendesk-support-ops-mcp
npm install

# Set credentials
export ZENDESK_SUBDOMAIN=your-subdomain
export ZENDESK_EMAIL=you@yourcompany.com
export ZENDESK_API_TOKEN=your_token

# Run in dev mode
npm run dev

# Build for production
npm run build && npm start
```

Test with [MCP Inspector](https://github.com/modelcontextprotocol/inspector):
```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

---

## License

MIT — Built by [Md Rakibul Islam](https://mdrakibulislam.com)

Zendesk Top Admin · Upwork Top Rated Plus · 21,000+ hours · 50+ CRM implementations across HubSpot, Zendesk, Freshdesk, and Salesforce.
