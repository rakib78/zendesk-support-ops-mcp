import { ZendeskClient } from "../zendesk-client.js";

interface ZendeskCurrentUser {
  user: {
    id: number;
    name: string;
    email: string;
    role: string;
    active: boolean;
    subdomain?: string;
  };
}

interface ZendeskAccount {
  settings?: {
    account?: {
      subdomain?: string;
      name?: string;
    };
  };
}

export async function zendeskWhoami(client: ZendeskClient): Promise<string> {
  // Probe current user
  const userData = await client.get<ZendeskCurrentUser>("/users/me.json");
  const user = userData.user;

  let accountInfo = "";
  try {
    const accountData = await client.get<ZendeskAccount>("/account/settings.json");
    const acct = accountData?.settings?.account;
    if (acct?.name) {
      accountInfo = `\n- **Account name**: ${acct.name}`;
    }
  } catch {
    // Not all plans expose this — silently skip
  }

  const lines = [
    `## ✅ Zendesk Connection Verified`,
    ``,
    `- **User**: ${user.name} (${user.email})`,
    `- **Role**: ${user.role}`,
    `- **Active**: ${user.active ? "Yes" : "No"}`,
    accountInfo,
    ``,
    `**Auth type**: API Token (Basic)`,
    `**Status**: Connected and authenticated`,
    ``,
    user.role === "admin"
      ? `> Admin access confirmed — all tools available.`
      : `> Note: Non-admin tokens may restrict macro CRUD and some write operations. If tools return permission errors, use an admin token.`,
  ].filter((l) => l !== undefined);

  return lines.join("\n");
}
