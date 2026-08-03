// Tier 2 posts to Slack for visibility, tier 3 posts asking for
// approval - both go through here. Uses a plain Slack Incoming Webhook
// URL (SLACK_WEBHOOK_URL), not the Slack Bot OAuth app - simplest thing
// that gives the blog's "posts to Slack for visibility" behaviour
// without standing up a full Slack app. If SLACK_WEBHOOK_URL isn't set,
// this just logs instead of throwing - notification is best-effort, it
// should never be why a tier-1/2 action fails.

export async function notifySlack(webhookUrl, text) {
  if (!webhookUrl) {
    console.log(`[notify] (no SLACK_WEBHOOK_URL set) ${text}`);
    return;
  }
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) {
      console.error(`[notify] Slack webhook returned ${resp.status}`);
    }
  } catch (err) {
    console.error(`[notify] Slack webhook failed: ${err.message}`);
  }
}
