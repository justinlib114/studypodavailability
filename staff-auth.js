
"use strict";

// Google Workspace authentication for the Study Pod Dashboard.
// Access is restricted to individual staff email addresses.

const crypto = require("node:crypto");
const cookieSession = require("cookie-session");
const { OAuth2Client } = require("google-auth-library");

module.exports = function enableStaffAuth(app) {
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const SESSION_SECRET = process.env.SESSION_SECRET;

  const WORKSPACE_DOMAIN = String(
    process.env.GOOGLE_WORKSPACE_DOMAIN || ""
  ).trim().toLowerCase();

  const ALLOWED_EMAILS = new Set(
    String(process.env.ALLOWED_STAFF_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );

  const REDIRECT_URI =
    process.env.GOOGLE_REDIRECT_URI ||
    "https://studypodavailability-v6hy.onrender.com/auth/google/callback";

  const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
  const LOGIN_DURATION_MS = 10 * 60 * 1000;

  if (
    !CLIENT_ID ||
    !CLIENT_SECRET ||
    !SESSION_SECRET ||
    SESSION_SECRET.length < 32 ||
    !WORKSPACE_DOMAIN ||
    ALLOWED_EMAILS.size === 0
  ) {
    throw new Error(
      "Google staff authentication is not configured. Check the Google OAuth, " +
      "SESSION_SECRET, GOOGLE_WORKSPACE_DOMAIN, and ALLOWED_STAFF_EMAILS " +
      "environment variables."
    );
  }

  // Render terminates HTTPS before forwarding to Express.
  app.set("trust proxy", 1);

  const google = new OAuth2Client(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );

  app.use(
    cookieSession({
      name: "gpl_study_pods_auth",
      keys: [SESSION_SECRET],
      maxAge: SESSION_DURATION_MS,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/"
    })
  );

  app.get("/login", (req, res) => {
    if (isAuthorized(req.session?.user)) {
      return res.redirect("/dashboard");
    }

    res.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; " +
      "form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    );

    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Staff sign-in | Study Pods</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      padding: 24px;
      min-height: 85vh;
      display: grid;
      place-items: center;
      background: #f4f6f9;
    }
    main {
      max-width: 400px;
      width: 100%;
      padding: 30px;
      background: white;
      border: 1px solid #dbe0e6;
      border-radius: 12px;
    }
    h1 { margin-top: 0; font-size: 1.7rem; }
    p { line-height: 1.5; }
    button {
      padding: 12px 16px;
      font: inherit;
      border-radius: 6px;
      border: 1px solid #555;
      background: white;
      cursor: pointer;
    }
    button:focus-visible {
      outline: 3px solid #1769c2;
      outline-offset: 3px;
    }
  </style>
</head>
<body>
  <main>
    <h1>Study Pod Dashboard</h1>
    <p>Sign in with your authorized library Google Workspace account.</p>
    <form action="/auth/google" method="get">
      <button type="submit">Sign in with Google</button>
    </form>
  </main>
</body>
</html>`);
  });

  app.get("/auth/google", async (req, res) => {
    try {
      const { codeVerifier, codeChallenge } =
        await google.generateCodeVerifierAsync();

      const state = crypto.randomBytes(32).toString("hex");
      const nonce = crypto.randomBytes(32).toString("hex");

      req.session = {
        oauth: {
          state,
          nonce,
          codeVerifier,
          startedAt: Date.now()
        }
      };

      const url = google.generateAuthUrl({
        scope: ["openid", "email"],
        response_type: "code",
        access_type: "online",
        prompt: "select_account",
        hd: WORKSPACE_DOMAIN,
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256"
      });

      return res.redirect(url);
    } catch (error) {
      console.error(
        "Could not start Google sign-in:",
        error.message
      );
      return res.status(500).send(
        "Could not start staff sign-in."
      );
    }
  });

  app.get("/auth/google/callback", async (req, res) => {
    const challenge = req.session?.oauth;

    // Discard the one-time login challenge.
    req.session = null;

    const code =
      typeof req.query.code === "string"
        ? req.query.code
        : "";

    const state =
      typeof req.query.state === "string"
        ? req.query.state
        : "";

    if (
      !challenge ||
      !code ||
      !state ||
      state !== challenge.state ||
      !challenge.nonce ||
      !challenge.codeVerifier ||
      Date.now() - challenge.startedAt > LOGIN_DURATION_MS ||
      Date.now() < challenge.startedAt
    ) {
      return res.status(400).send(
        "Invalid or expired sign-in. Return to /login."
      );
    }

    try {
      const { tokens } = await google.getToken({
        code,
        codeVerifier: challenge.codeVerifier,
        redirect_uri: REDIRECT_URI
      });

      if (!tokens.id_token) {
        return res.status(401).send(
          "Google did not return an identity token."
        );
      }

      const ticket = await google.verifyIdToken({
        idToken: tokens.id_token,
        audience: CLIENT_ID
      });

      const identity = ticket.getPayload();

      const email = String(
        identity?.email || ""
      ).trim().toLowerCase();

      const domain = String(
        identity?.hd || ""
      ).trim().toLowerCase();

      if (
        !identity?.sub ||
        identity?.nonce !== challenge.nonce ||
        identity?.email_verified !== true ||
        domain !== WORKSPACE_DOMAIN ||
        !ALLOWED_EMAILS.has(email)
      ) {
        return res.status(403).send(
          "Your Google account is not authorized to use this dashboard."
        );
      }

      req.session = {
        user: {
          sub: identity.sub,
          email,
          signedInAt: Date.now()
        }
      };

      return res.redirect(303, "/dashboard");
    } catch (error) {
      console.error(
        "Google sign-in failed:",
        error.message
      );

      return res.status(401).send(
        "Sign-in failed. Return to /login and retry."
      );
    }
  });

  app.get("/logout", (req, res) => {
    req.session = null;
    res.redirect("/login");
  });

  function isAuthorized(user) {
    return !!(
      user &&
      typeof user.sub === "string" &&
      user.sub.length > 0 &&
      typeof user.email === "string" &&
      ALLOWED_EMAILS.has(user.email.toLowerCase()) &&
      Number.isFinite(user.signedInAt) &&
      Date.now() - user.signedInAt < SESSION_DURATION_MS &&
      Date.now() >= user.signedInAt
    );
  }

  // Protect all routes registered after this middleware.
  app.use((req, res, next) => {
    if (req.path === "/ping") {
      return next();
    }

    if (isAuthorized(req.session?.user)) {
      return next();
    }

    req.session = null;

    if (req.path.startsWith("/api/")) {
      return res.status(401).json({
        error: "Staff sign-in required."
      });
    }

    return res.redirect("/login");
  });
};
