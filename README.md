# zendesk-support-ops-mcp

> Production-safe Zendesk Support MCP with dry-run writes, SLA breach radar, natural-language macro authoring, and plain-language weekly ops summaries.

[![MCP Server](https://img.shields.io/badge/MCP-Server-blue)](https://mcpize.com/mcp/zendesk-support-ops-mcp)
[![Zendesk](https://img.shields.io/badge/Zendesk-API-green)](https://developer.zendesk.com)

## Why this exists

Zendesk powers 100,000+ brands. Teams connecting Claude (or any AI assistant) to Zendesk need four things existing MCP servers don't properly handle:

1. **Write-access with safety** — every write operation has a `dry_run` preview + explicit `confirm` gate
2. **SLA intelligence** — breach radar and per-ticket SLA explanation, not just ticket search
3. **Macro authoring at scale** — natural-language spec → validated `actions[]` → preview → apply
4. **Manager reporting** — plain-language weekly digest without learning Zendesk Explore

## Tools (MVP v1.0)

| Tool | Description |
|------|-------------|
| `zendesk_whoami` | Verify connection, auth, and user role |
| `search_tickets` | Full Zendesk search syntax with pagination |
| `get_ticket` | Full ticket context + SLA metrics |
| `preview_ticket_update` | **Dry-run** diff of proposed changes |
| `execute_ticket_update` | Apply changes (requires `confirm: true`) |
| `add_internal_note` | Add private comment (dry-run by default) |
| `list_sla_breaches` | Ranked list of tickets at breach risk |
| `explain_ticket_sla` | Plain-language SLA story for one ticket |
| `weekly_support_summary` | Manager-ready weekly ops digest |
| `create_macro_from_spec` | NL or JSON spec → macro (dry-run default) |
| `list_macros` | Browse macro library |
| `get_macro` | Fetch macro definition |

## Usage Scenarios

**Morning SLA sweep**
```
list_sla_breaches → prioritize_ticket_queue → agents work top-down
```

**Safe bulk update**
```
preview_ticket_update on tickets → review diff → execute_ticket_update confirm:true
```

**Macro from spec**
```
create_macro_from_spec dry_run:true → review → dry_run:false → list_macros to verify
```

**Monday leadership email**
```
weekly_support_summary week_start:2025-01-06 → paste into Notion or email
```

## Setup

### 1. Get a Zendesk API token

In Zendesk: **Admin → Apps & Integrations → APIs → Zendesk API → Add API token**

### 2. Configure Claude Desktop

Add to `claude_desktop_config.json`:

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

### 3. Or install globally

```bash
npm install -g zendesk-support-ops-mcp
```

Then use env vars or a `.env` file.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZENDESK_SUBDOMAIN` | ✅ | Your subdomain (e.g. `mycompany` for `mycompany.zendesk.com`) |
| `ZENDESK_EMAIL` | ✅ | Agent/admin email address |
| `ZENDESK_API_TOKEN` | ✅ | API token (not your password) |

## Safety Model

- **All write tools default to dry-run** — you see the diff before anything changes
- **`execute_ticket_update` requires explicit `confirm: true`** — no accidental bulk changes
- **`add_internal_note` defaults `dry_run: true`** — notes are previewed before posting
- **`create_macro_from_spec` defaults `dry_run: true`** — macros are validated and previewed
- Rate limit errors surface with `Retry-After` guidance, not silent failures

## Limitations

- SLA breach detection is heuristic (tickets not updated recently). Precise SLA policy targets require Zendesk Professional+ and are read from ticket SLA fields where available.
- Search API may lag a few minutes — noted in all relevant tool outputs.
- CSAT requires Zendesk plan support — tools degrade gracefully if unavailable.
- Zendesk's Search API returns a practical max of ~1,000 results per query.

## Development

```bash
git clone https://github.com/your-repo/zendesk-support-ops-mcp
cd zendesk-support-ops-mcp
npm install
npm run build
npm start
```

For development with hot reload:
```bash
npm run dev
```

## License

MIT — Built by [Md Rakibul Islam](https://github.com/mdrakibul)
