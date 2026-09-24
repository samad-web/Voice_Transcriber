import { inviteMailContent, platformMailConfig, sendInviteMail } from "./invite-mail";

const FULL = {
  PLATFORM_SMTP_HOST: "smtp.example.com",
  PLATFORM_SMTP_USER: "mailer",
  PLATFORM_SMTP_PASSWORD: "secret",
  PLATFORM_MAIL_FROM: "no-reply@example.com",
} as NodeJS.ProcessEnv;

describe("platformMailConfig", () => {
  it("is off unless host, credentials and sender are all set", () => {
    expect(platformMailConfig({} as NodeJS.ProcessEnv)).toBeNull();
    for (const key of Object.keys(FULL)) {
      expect(platformMailConfig({ ...FULL, [key]: "" })).toBeNull();
    }
    expect(platformMailConfig(FULL)).not.toBeNull();
  });

  it("uses STARTTLS on 587 by default and implicit TLS on 465", () => {
    expect(platformMailConfig(FULL)?.smtp).toMatchObject({ port: 587, secure: false });
    expect(platformMailConfig({ ...FULL, PLATFORM_SMTP_PORT: "465" })?.smtp).toMatchObject({ port: 465, secure: true });
    expect(platformMailConfig({ ...FULL, PLATFORM_SMTP_SECURE: "true" })?.smtp.secure).toBe(true);
  });
});

describe("invite mail", () => {
  const input = {
    to: "asha@example.com",
    orgName: "Sirah Digital",
    inviterName: "Samad",
    roleLabel: "Telecaller",
    link: "https://app.example.com/admin/invite/tok",
    expiresAt: new Date("2026-09-27T12:00:00Z"),
  };

  it("names the workspace, the role, the link, the address and the expiry", () => {
    const { subject, body } = inviteMailContent(input);
    expect(subject).toBe("Samad invited you to Sirah Digital");
    expect(body).toContain("as Telecaller");
    expect(body).toContain(input.link);
    expect(body).toContain("asha@example.com");
    expect(body).toContain("Sun, 27 Sep 2026 12:00:00 UTC");
  });

  it("cannot be turned into a header injection by an org name", async () => {
    const sent: string[] = [];
    await sendInviteMail(
      platformMailConfig(FULL)!,
      { ...input, orgName: "Evil\r\nBcc: victim@example.com" },
      async (_config, message) => {
        sent.push(message.mime);
      },
    );
    const headers = sent[0]!.split("\r\n\r\n")[0]!;
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(headers).toContain("To: asha@example.com");
  });
});
