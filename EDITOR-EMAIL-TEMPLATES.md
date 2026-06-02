# Supabase Auth email templates — OPT branded

Supabase's management API silently ignores email template PATCHes for the
runtime mailer. Templates MUST be set via the dashboard UI to take effect.

## Where to paste

URL: https://supabase.com/dashboard/project/kjfaqhmllagbxjdxlopm/auth/templates

You'll see tabs across the top: **Confirm signup · Invite user · Magic Link · Change Email Address · Reset Password · Reauthentication**.

Only two matter for the editor portal:

1. **Confirm signup** — sent when an editor logs in for the FIRST time (no Supabase Auth account yet)
2. **Magic Link** — sent on subsequent logins (account already exists)

Both should use the OPT-branded HTML below.

---

## Template 1 — "Confirm signup" tab

**Subject heading:**
```
[OPT] Your editor portal login link
```

**Message body (paste as-is, save):**
```html
<!doctype html>
<html><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4ede2;padding:40px 16px;color:#1a1a1a;">
  <div style="max-width:540px;margin:0 auto;background:#fbf6ec;border:1px solid #d9d1be;border-top:3px solid #f4e14a;padding:32px 28px;">
    <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#5a5a5a;margin-bottom:8px;">OPT Digital &middot; Editor portal</div>
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:500;line-height:1.3;color:#1a1a1a;">Log in to your editor portal</h1>
    <p style="margin:0 0 14px;font-size:14px;color:#1a1a1a;line-height:1.55;">You've been invited to the OPT Digital editor portal. Click the button below to log in &mdash; no password needed.</p>
    <a href="{{ .ConfirmationURL }}" style="display:inline-block;margin:8px 0 22px;padding:11px 18px;background:#1a1a1a;color:#fbf6ec;text-decoration:none;font-family:monospace;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;border-radius:2px;">Log in to OPT Editor Portal &rarr;</a>
    <p style="margin:0 0 6px;font-size:12px;color:#5a5a5a;line-height:1.55;">Or enter this 6-digit code at <strong>/editor-login</strong>:</p>
    <div style="margin:0 0 18px;padding:10px 14px;background:#fff;border:1px solid #d9d1be;border-left:3px solid #f4e14a;font-family:monospace;font-size:20px;font-weight:700;letter-spacing:0.16em;color:#1a1a1a;text-align:center;">{{ .Token }}</div>
    <div style="margin:0 0 14px;padding:12px 14px;background:#fff;border-left:3px solid #f4e14a;font-size:12.5px;color:#1a1a1a;line-height:1.55;">
      <strong style="display:block;margin-bottom:4px;font-family:monospace;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#5a5a5a;">What you'll see inside</strong>
      Your task queue, every other editor's projects (team view), upload edited cuts directly to assigned tasks, and notifications when feedback is left.
    </div>
    <div style="margin-top:18px;padding-top:16px;border-top:1px solid #d9d1be;font-size:11px;color:#7a7a7a;line-height:1.55;">
      Didn't request this? You can safely ignore the email &mdash; only the person who has your inbox can complete the login.<br><br>
      &mdash; OPT Digital
    </div>
  </div>
</body></html>
```

---

## Template 2 — "Magic Link" tab

**Subject heading:**
```
[OPT] Your editor portal login link
```

**Message body (paste as-is, save):**
```html
<!doctype html>
<html><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4ede2;padding:40px 16px;color:#1a1a1a;">
  <div style="max-width:540px;margin:0 auto;background:#fbf6ec;border:1px solid #d9d1be;border-top:3px solid #f4e14a;padding:32px 28px;">
    <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#5a5a5a;margin-bottom:8px;">OPT Digital &middot; Editor portal</div>
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:500;line-height:1.3;color:#1a1a1a;">Log in to your editor portal</h1>
    <p style="margin:0 0 16px;font-size:14px;color:#1a1a1a;line-height:1.55;">Click the button below to log in. This link is valid for one hour and can only be used once.</p>
    <a href="{{ .ConfirmationURL }}" style="display:inline-block;margin:8px 0 22px;padding:11px 18px;background:#1a1a1a;color:#fbf6ec;text-decoration:none;font-family:monospace;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;border-radius:2px;">Log in to OPT Editor Portal &rarr;</a>
    <p style="margin:0 0 6px;font-size:12px;color:#5a5a5a;line-height:1.55;">Or enter this 6-digit code at <strong>/editor-login</strong>:</p>
    <div style="margin:0 0 18px;padding:10px 14px;background:#fff;border:1px solid #d9d1be;border-left:3px solid #f4e14a;font-family:monospace;font-size:20px;font-weight:700;letter-spacing:0.16em;color:#1a1a1a;text-align:center;">{{ .Token }}</div>
    <div style="margin-top:22px;padding-top:16px;border-top:1px solid #d9d1be;font-size:11px;color:#7a7a7a;line-height:1.55;">
      Didn't request this? You can safely ignore the email &mdash; only the person who has your inbox can complete the login.<br><br>
      &mdash; OPT Digital
    </div>
  </div>
</body></html>
```

---

## After you save both

Tell me "saved" and I'll re-fire the 13 invites. This time they'll get the OPT-branded template (subject `[OPT] Your editor portal login link`, cream paper background, yellow accent border) instead of the default ugly one.

To verify it took, I'll send a test to a fresh `ben+optest3@opt.co.nz` alias first, query the Resend log to confirm the actual HTML body contains "OPT Digital" + the yellow accent color, THEN re-batch the 13.

(I am NOT trusting "subject saved in API GET = subject used at runtime" again. Twice burned by Supabase doing that with SMTP + templates this session.)
