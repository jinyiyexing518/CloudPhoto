import { EmailClient } from "@azure/communication-email";
import { DefaultAzureCredential } from "@azure/identity";

function buildClient(): EmailClient {
  const endpoint = process.env.ACS_ENDPOINT;
  const connStr = process.env.ACS_CONNECTION_STRING;
  if (endpoint) return new EmailClient(endpoint, new DefaultAzureCredential());
  if (connStr) return new EmailClient(connStr);
  throw new Error("ACS not configured");
}

function isAcsConfigured(): boolean {
  return !!(process.env.ACS_SENDER_ADDRESS && (process.env.ACS_ENDPOINT || process.env.ACS_CONNECTION_STRING));
}

/**
 * Sends a group invite email with an accept/decline link (invite token).
 * Works for both registered and unregistered users.
 */
export async function sendInviteEmail(opts: {
  toEmail: string;
  groupName: string;
  inviterName: string;
  inviteUrl: string;   // e.g. https://app.azurestaticapps.net?invite=<token>
}): Promise<void> {
  if (!isAcsConfigured()) {
    console.log("[email] ACS not configured — skipping invite email");
    return;
  }
  const sender = process.env.ACS_SENDER_ADDRESS!;
  const { toEmail, groupName, inviterName, inviteUrl } = opts;
  try {
    const poller = await buildClient().beginSend({
      senderAddress: sender,
      recipients: { to: [{ address: toEmail }] },
      content: {
        subject: `${inviterName} 邀请你加入群组「${groupName}」— Cloud Photo`,
        html: `
<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:32px 24px;border:1px solid #e5e7eb;border-radius:8px;">
  <h2 style="color:#0078d4;margin-top:0;">📷 Cloud Photo</h2>
  <p><strong>${inviterName}</strong> 邀请你加入共享相册群组 <strong>「${groupName}」</strong>。</p>
  <p>点击下方按钮接受邀请（链接 7 天内有效）：</p>
  <div style="margin:28px 0;text-align:center;">
    <a href="${inviteUrl}"
       style="background:#0078d4;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:600;">
      接受邀请
    </a>
  </div>
  <p style="color:#6b7280;font-size:12px;">
    如果按钮无法点击，请复制以下链接到浏览器：<br/>${inviteUrl}
  </p>
  <p style="color:#6b7280;font-size:12px;">如果你不认识 ${inviterName}，请忽略此邮件。</p>
</div>`,
        plainText: `${inviterName} 邀请你加入 Cloud Photo 群组「${groupName}」。\n\n接受邀请：${inviteUrl}\n\n链接 7 天内有效。`,
      },
    });
    await poller.pollUntilDone();
  } catch (err) {
    console.error("[email] Failed to send invite email:", err);
  }
}

/**
 * @deprecated Use sendInviteEmail with a token link instead.
 * Kept for backward compatibility — notifies an existing member they were added directly.
 */
export async function sendGroupInviteEmail(opts: {
  toEmail: string;
  toName: string;
  groupName: string;
  inviterName: string;
}): Promise<void> {
  if (!isAcsConfigured()) return;
  const appUrl = process.env.APP_BASE_URL ?? "https://cloudphoto.azurestaticapps.net";
  const sender = process.env.ACS_SENDER_ADDRESS!;
  const { toEmail, toName, groupName, inviterName } = opts;
  try {
    const poller = await buildClient().beginSend({
      senderAddress: sender,
      recipients: { to: [{ address: toEmail, displayName: toName }] },
      content: {
        subject: `你已被添加到群组「${groupName}」— Cloud Photo`,
        html: `
<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:32px 24px;border:1px solid #e5e7eb;border-radius:8px;">
  <h2 style="color:#0078d4;margin-top:0;">📷 Cloud Photo</h2>
  <p>Hi <strong>${toName}</strong>，</p>
  <p><strong>${inviterName}</strong> 已将你添加到群组 <strong>「${groupName}」</strong>。</p>
  <div style="margin:28px 0;text-align:center;">
    <a href="${appUrl}" style="background:#0078d4;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:15px;">进入 Cloud Photo</a>
  </div>
</div>`,
        plainText: `Hi ${toName}，${inviterName} 已将你添加到群组「${groupName}」。访问 ${appUrl} 查看。`,
      },
    });
    await poller.pollUntilDone();
  } catch (err) {
    console.error("[email] Failed to send notification email:", err);
  }
}
