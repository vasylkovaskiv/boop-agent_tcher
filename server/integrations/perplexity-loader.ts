import { buildPerplexityIntegrationModule } from "../perplexity.js";
import { registerIntegration } from "./registry.js";

export function registerPerplexity(): void {
  // Perplexity is gated on having a residential proxy configured. Without
  // one, Cloudflare reliably 403s requests from datacenter IPs and we'd
  // immediately burn the user's cookies. Better to leave the integration
  // unregistered so the dispatcher never tries to spawn into it.
  if (!process.env.PERPLEXITY_PROXY_URL) {
    console.log("[perplexity] disabled — PERPLEXITY_PROXY_URL not set");
    return;
  }
  registerIntegration(buildPerplexityIntegrationModule());
  console.log("[perplexity] registered");
}
