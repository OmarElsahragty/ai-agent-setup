# CloudCLI Access hardening (F4) — owner dashboard steps

Why: `${AI_SETUP_DOMAIN}` gives a root-capable Claude session. Today the only gate is a single-factor
Cloudflare Access login (finding F4, audit IC-35 / IE-35, MASTER M-117). These steps add a second factor,
shorten sessions, and stop a stolen Access cookie from being reused. Agents cannot click these for you:
they need the Cloudflare dashboard (or an API token with Access edit rights, which agents do not hold).

Paths follow the current Cloudflare One docs (checked 2026-10-10 via exa):
- Independent MFA: https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/
- Enforce MFA: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/
- Cookie settings: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/
- Sessions: https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/

## 1. Turn on independent MFA for the organization (once)
1. Cloudflare dashboard -> Zero Trust -> Access controls -> Access settings.
2. Under **Allow multi-factor authentication (MFA)**, turn it on and allow **Security key** and **Biometrics**
   (FIDO2/WebAuthn: phishing-resistant). Leave TOTP off unless you need a fallback.
3. **Authentication duration**: 8h (or "Require every login" if you prefer).
4. Save, then enroll your key / Touch ID on the next login when Access prompts.

## 2. Require MFA on the "Allow Omar" policy
1. Zero Trust -> Access controls -> Policies -> **Allow Omar** -> Configure.
2. Under **Multi-factor authentication (MFA)** choose **Custom MFA settings**: allowed methods Security key +
   Biometrics, authentication duration 8h.
3. **Session duration** (policy): 8 hours.
4. Save. (Policy MFA overrides application and organization settings.)

## 3. Application cookie settings for ${AI_SETUP_DOMAIN}
1. Zero Trust -> Access controls -> Applications -> the ${AI_SETUP_DOMAIN} application -> Configure.
2. **Session duration**: 8 hours (or lower).
3. Advanced settings / Cookie settings:
   - **SameSite attribute: Lax** (Strict can cause ERR_TOO_MANY_REDIRECTS; Lax keeps CSRF protection).
   - **HTTP Only: on**.
   - **Enable Binding Cookie: on** (a stolen CF_Authorization cookie is useless without CF_Binding;
     stripped at the edge, never reaches the origin). Do not enable it if you turn on Zaraz / Google tag
     gateway on this hostname or use non-browser clients through this app (redirect loops).
4. Save.

## 4. Pin the Access email claim at the origin (CloudCLI, P12)
The live P12 check (`modules/auth/access-jwt.js`) already supports an email pin; it is OFF until set.
1. Add one line to `${AI_SETUP_ROOT}/cloudcli/.env`: `CF_ACCESS_EMAIL=<the exact email you log in to Access with>`.
2. Restart without killing sessions: `${AI_SETUP_ROOT}/scripts/safe-restart.sh cloudcli --reason "F4 email pin"`.
3. A request whose Access assertion carries another email is then refused even if the AUD matches.

## 5. Verify (after the clicks)
- New private window -> https://${AI_SETUP_DOMAIN} -> IdP login -> **MFA prompt** -> CloudCLI loads.
- DevTools -> Application -> Cookies: `CF_Authorization` (SameSite Lax, HttpOnly) and `CF_Binding` present.
- Session ends after <= 8 h (or log out at `https://${AI_SETUP_DOMAIN}/cdn-cgi/access/logout`).
- From the host: `curl -sI https://${AI_SETUP_DOMAIN} | head -1` -> `HTTP/2 302` (Access login), and
  `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3011/` -> `401` (origin JWT guard).

## Rollback
Each setting is reversible in the same dashboard screen (choose "Respect global enforcement setting" /
turn MFA off / restore 24h sessions / turn the binding cookie off). Remove the `CF_ACCESS_EMAIL` line and
safe-restart cloudcli to drop the origin pin.
