import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

function createPlaidClient(): PlaidApi {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = (process.env.PLAID_ENV ?? "sandbox") as keyof typeof PlaidEnvironments;

  if (!clientId || !secret) {
    throw new Error("PLAID_CLIENT_ID and PLAID_SECRET must be set");
  }

  const config = new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": clientId,
        "PLAID-SECRET": secret,
      },
    },
  });

  return new PlaidApi(config);
}

// Lazy singleton — only throws when first used, not at import time.
// This keeps test imports clean when PLAID_* env vars aren't set.
let _client: PlaidApi | undefined;

export function getPlaidClient(): PlaidApi {
  if (!_client) {
    _client = createPlaidClient();
  }
  return _client;
}
