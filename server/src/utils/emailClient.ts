import { EmailClient } from "@azure/communication-email";

const connectionString = process.env.COMMUNICATION_CONNECTION_STRING ?? "";
const senderAddress =
  process.env.COMMUNICATION_SENDER ?? "DoNotReply@cloudphoto.azurecomm.net";

let _client: EmailClient | null = null;

function getClient(): EmailClient {
  if (!_client) {
    if (!connectionString) throw new Error("COMMUNICATION_CONNECTION_STRING is not set");
    _client = new EmailClient(connectionString);
  }
  return _client;
}

export async function sendGroupInviteEmail(params: {
  toEmail: string;
  inviterName: string;
  groupName: string;
  inviteUrl: string;
}): Promise<void> {
  const { toEmail, inviterName, groupName, inviteUrl } = params;
  const poller = await getClient().beginSend({
    senderAddress,
    recipients: { to: [{ address: toEmail }] },
    content: {
      subject: `[Cloud Photo] ${inviterName} 邀请您加入群组「${groupName}」`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
          <h2 style="color:#0078d4;margin-top:0">加入 Cloud Photo 群组</h2>
          <p><strong>${inviterName}</strong> 邀请您加入共享相册群组 <strong>「${groupName}」</strong>。</p>
          <p style="margin:24px 0">
            <a href="${inviteUrl}"
               style="display:inline-block;padding:12px 28px;background:#0078d4;color:#fff;
                      border-radius:8px;text-decoration:none;font-weight:600;font-size:0.95rem">
              接受邀请
            </a>
          </p>
          <p style="color:#9ca3af;font-size:0.82rem">
            此链接 7 天内有效。若您不认识 ${inviterName}，请忽略此邮件。
          </p>
        </div>`,
      plainText: `${inviterName} 邀请您加入 Cloud Photo 群组「${groupName}」。\n\n接受邀请：${inviteUrl}\n\n此链接 7 天内有效。`,
    },
  });
  await poller.pollUntilDone();
}
