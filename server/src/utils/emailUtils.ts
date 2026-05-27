import { EmailClient } from "@azure/communication-email";
import { DefaultAzureCredential } from "@azure/identity";

/**
 * Sends a group invitation email to a newly-added member.
 * Uses Managed Identity in production (ACS_ENDPOINT) or falls back to
 * connection string (ACS_CONNECTION_STRING) for local dev without managed identity.
 * Silently skips if neither is configured.
 */
export async function sendGroupInviteEmail(opts: {
  toEmail: string;
  toName: string;
  groupName: string;
  inviterName: string;
}): Promise<void> {
  const endpoint = process.env.ACS_ENDPOINT;
  const connStr = process.env.ACS_CONNECTION_STRING;
  const sender = process.env.ACS_SENDER_ADDRESS;

  if (!sender || (!endpoint && !connStr)) {
    console.log("[email] ACS not configured — skipping invite email");
    return;
  }

  const { toEmail, toName, groupName, inviterName } = opts;
  const appUrl = process.env.APP_BASE_URL ?? "https://cloudphoto.azurestaticapps.net";

  try {
    // Prefer Managed Identity (endpoint only, no secret); fall back to connection string for local dev
    const client = endpoint
      ? new EmailClient(endpoint, new DefaultAzureCredential())
      : new EmailClient(connStr!);
    const poller = await client.beginSend({
      senderAddress: sender,
      recipients: { to: [{ address: toEmail, displayName: toName }] },
      content: {
        subject: `${inviterName} 邀请你加入群组「${groupName}」— Cloud Photo`,
        html: `
<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:32px 24px;border:1px solid #e5e7eb;border-radius:8px;">
  <h2 style="color:#0078d4;margin-top:0;">📷 Cloud Photo</h2>
  <p>Hi <strong>${toName}</strong>，</p>
  <p>
    <strong>${inviterName}</strong> 已将你添加到群组
    <strong>「${groupName}」</strong>，现在你可以查看并上传群组共享照片了。
  </p>
  <div style="margin:28px 0;text-align:center;">
    <a href="${appUrl}"
       style="background:#0078d4;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:15px;">
      进入 Cloud Photo
    </a>
  </div>
  <p style="color:#6b7280;font-size:12px;">
    如果按钮无法点击，请复制以下链接访问：<br/>${appUrl}
  </p>
</div>`,
        plainText: `Hi ${toName}，\n\n${inviterName} 已将你添加到群组「${groupName}」。\n\n请访问 ${appUrl} 查看共享照片。\n\n— Cloud Photo`,
      },
    });
    await poller.pollUntilDone();
  } catch (err) {
    // Email failure must never block the add-member API response
    console.error("[email] Failed to send group invite email:", err);
  }
}
