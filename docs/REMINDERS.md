# Reminders: email + WhatsApp

LaunchLoop sends three kinds of reminders:

| Reminder | When | Link |
|---|---|---|
| **Post due** | A scheduled Share Kit post reaches its time | Opens that post's Share Kit |
| **Publish failed** | An automatic post fails 3 times | Opens the post to retry or use the Share Kit |
| **Daily digest** | Once a day at your chosen time, in your time zone | Today's posts, tasks due, overdue tasks, reviews waiting, yesterday's signups |

Each reminder is sent once per channel. Turn each one on or off, and set the recipients, under **Product source → Reminders**.

Nothing is sent until the provider keys below are added in **Render → Environment**. Until then the card shows "not set up on server".

## Email (Resend), about 15 minutes

1. Sign up at **resend.com**.
2. Go to **Domains → Add Domain** and enter `applaunchloop.com`.
3. Resend shows a few DNS records, usually an MX and a TXT for SPF on a `send` subdomain, and a TXT for DKIM. In **Namecheap → Advanced DNS**, add each one exactly as shown, then click **Verify** in Resend. These records don't affect your website's A and CNAME records.
4. Go to **API Keys → Create API Key** and choose "Sending access". Copy the key.
5. In **Render → Environment**, add:
   - `RESEND_API_KEY` = the key
   - `NOTIFY_EMAIL_FROM` = `LaunchLoop <reminders@applaunchloop.com>`
6. Save. When the deploy finishes, click **Test email** in LaunchLoop.

## WhatsApp (Meta WhatsApp Cloud API), about 30 minutes plus template approval

WhatsApp only lets businesses start conversations with **approved message templates**. That's why LaunchLoop sends a template.

1. At **developers.facebook.com**, create an app (type **Business**) and add the **WhatsApp** product.
2. On **WhatsApp → API Setup**:
   - Copy the **Phone number ID**. That's `WHATSAPP_PHONE_NUMBER_ID`.
   - For testing, Meta gives you a test number and a temporary token. Add your own WhatsApp number under "To" as an allowed recipient.
   - For real use, add your own business phone number, and create a **permanent token**: Business Settings → System users → add a user → Generate token, with the `whatsapp_business_messaging` permission. The temporary token expires in 24 hours.
3. In **WhatsApp Manager → Message templates → Create template**:
   - Category **Utility**, name `launchloop_reminder`, language **English**.
   - Body (copy exactly):
     `Hi, this is your LaunchLoop reminder: {{1}}. Details: {{2}}. Open LaunchLoop to take action: {{3}}. You can change these reminders anytime in your LaunchLoop settings.`
   - Sample values: `Your TikTok post is due now` / `PassportBatch reel, open the Share Kit to post it` / `https://applaunchloop.com/#/review`
   - Submit, and wait for approval. Usually minutes, sometimes longer.
4. In **Render → Environment**, add:
   - `WHATSAPP_TOKEN` = the permanent token
   - `WHATSAPP_PHONE_NUMBER_ID` = the phone number ID
   - `WHATSAPP_TEMPLATE` = `launchloop_reminder`
   - `WHATSAPP_TEMPLATE_LANG` = `en` (use `en_US` if you picked "English (US)" for the template)
5. Save. When the deploy finishes, enter your number with its country code (e.g. `+233 24 123 4567`) and click **Test WhatsApp**.

Meta charges per conversation for business-initiated messages, depending on the country. Check Meta's current WhatsApp pricing for Ghana and Nigeria.

## Troubleshooting

The **Recent reminders** list on the card shows each message and any error from the provider:
- `Resend 403`: the domain isn't verified yet, or `NOTIFY_EMAIL_FROM` uses a different domain.
- `WhatsApp 401`: the token has expired (temporary tokens last 24 hours). Use a permanent System User token.
- `WhatsApp 404` or a template error: the template name or language doesn't match what's approved.
- `Recipient not in allowed list`: in test mode, add your number in API Setup.
