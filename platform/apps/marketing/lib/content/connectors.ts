/**
 * The connector catalogue, as the marketing site shows it.
 *
 * SOURCE OF TRUTH: `packages/shared/src/crm-providers.ts`. That file holds 15
 * entries with `category: "crm"` (plus four automation targets - Zapier, Make,
 * n8n and a generic webhook - which are deliberately not shown here, because
 * "15 CRM connectors" is the claim and padding the grid with webhooks would
 * inflate it).
 *
 * The list is duplicated rather than imported for two reasons: the order below
 * is the Indian-SMB ordering doc 16 §3.7 specifies, which is not the catalogue's
 * order; and importing the full specs would pull every endpoint, auth scheme and
 * field map into a static marketing render for fifteen strings.
 *
 * If a connector is added to the catalogue, add it here. `CONNECTOR_COUNT` is
 * what the copy interpolates, so the number on the page cannot drift from the
 * list beside it.
 *
 * `oauthPending` marks the four providers that authenticate today with pasted
 * access tokens that expire in hours, with the OAuth refresh flow still unbuilt
 * (DEPLOYMENT.md §7.8, 08_ROAD_TO_10.md Stage 3). Doc 16 §3.7 is explicit that
 * this must be stated rather than glossed: Zoho is the market leader in India,
 * so it will be a common answer, and implying a turnkey integration that in
 * fact needs manual token rotation is how a sale becomes a refund.
 */

export interface Connector {
  name: string;
  oauthPending?: boolean;
}

export const CONNECTORS: Connector[] = [
  { name: "Zoho CRM", oauthPending: true },
  { name: "LeadSquared" },
  { name: "Kylas" },
  { name: "Freshsales" },
  { name: "HubSpot" },
  { name: "Salesforce", oauthPending: true },
  { name: "Bitrix24" },
  { name: "monday CRM", oauthPending: true },
  { name: "Pipedrive" },
  { name: "GoHighLevel" },
  { name: "Zendesk Sell" },
  { name: "Close" },
  { name: "Attio" },
  { name: "Keap" },
  { name: "Dynamics 365", oauthPending: true },
];

export const CONNECTOR_COUNT = CONNECTORS.length;
