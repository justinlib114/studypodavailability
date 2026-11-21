
"use strict";

// Staff-only Google Workspace sign-in for the Study Pod Dashboard.
// Uses an explicit email allowlist. No Google Groups or Admin SDK required.

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

  const APP_ORIGIN = new URL(REDIRECT_URI).origin;
  const LIBCAL_ORIGIN = "https://greenburghlibrary.libcal.com";
  const FRAME_POLICY = `frame-ancestors 'self' ${LIBCAL_ORIGIN}`;

  const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
  const LOGIN_DURATION_MS = 10 * 60 * 1000;

  // --------------------------------------------------
  // Validate configuration
  // --------------------------------------------------

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

  // Render terminates HTTPS before requests reach Express.
  app.set("trust proxy", 1);

  const google = new OAuth2Client(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );

  // --------------------------------------------------
  // Secure session configuration
  // --------------------------------------------------

  app.use(
    cookieSession({
      name: "gpl_study_pods_auth",
      keys: [SESSION_SECRET],
      maxAge: SESSION_DURATION_MS,
      httpOnly: true,
      secure: true,

      // Needed for embedding inside LibCal.
      // Browsers that block third-party cookies may
      // still require staff to open the dashboard directly.
      sameSite: "none",

      path: "/"
    })
  );

  // --------------------------------------------------
  // Allow embedding from LibCal
  // --------------------------------------------------

  app.use((req, res, next) => {
    res.set("Content-Security-Policy", FRAME_POLICY);
    res.removeHeader("X-Frame-Options");
    next();
  });

  // --------------------------------------------------
  // Staff login page
  // --------------------------------------------------

  app.get("/login", (req, res) => {
    if (isAuthorized(req.session?.user)) {
      return res.redirect("/dashboard");
    }

    res.set(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; ${FRAME_POLICY}`
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

    h1 {
      margin-top: 0;
      font-size: 1.7rem;
    }

    p {
      line-height: 1.5;
    }

    a.signin-link {
      display: inline-block;
      padding: 12px 16px;
      font: inherit;
      border-radius: 6px;
      border: 1px solid #555;
      background: white;
      color: #111;
      text-decoration: none;
      cursor: pointer;
    }

    a.signin-link:focus-visible,
    a.reload-link:focus-visible {
      outline: 3px solid #1769c2;
      outline-offset: 3px;
    }

    a.reload-link {
      display: inline-block;
      margin-top: 4px;
      color: #005ea2;
    }

    .tip {
      color: #404040;
      font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <main>
    <h1>Study Pod Dashboard</h1>

    <p>
      Full-time staff and Reference Librarians can sign in
      with their library Google account to view study pod
      dashboard reservations.
    </p>

    <a
      class="signin-link"
      href="/auth/google"
      target="_blank"
      rel="noopener noreferrer"
    >
      Sign in with Google (new tab)
    </a>

    <p>
      After signing in, return to this page and select
      <strong>Reload Dashboard</strong>.
    </p>

    <a class="reload-link" href="/dashboard">
      Reload Dashboard
    </a>

    <p class="tip">
      If this page still asks you to sign in, your browser
      may be blocking third-party cookies for the embedded
      dashboard.
    </p>
  </main>
</body>
</html>`);
  });

  // --------------------------------------------------
  // Begin Google sign-in
  // --------------------------------------------------

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

  // --------------------------------------------------
  // Google OAuth callback
  // --------------------------------------------------

  app.get("/auth/google/callback", async (req, res) => {
    const challenge = req.session?.oauth;

    // Discard the one-time challenge.
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

      // Store only a minimal identity.
      // Google tokens are not saved in the session.
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

  // --------------------------------------------------
  // Logout
  // --------------------------------------------------

  app.get("/logout", (req, res) => {
    req.session = null;
    res.redirect("/login");
  });

  // --------------------------------------------------
  // Check authorized staff session
  // --------------------------------------------------

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

  // --------------------------------------------------
  // Authentication and API protection
  // --------------------------------------------------

  app.use((req, res, next) => {

    // Render health check does not expose patron information.
    if (req.path === "/ping") {
      return next();
    }

    // ------------------------------------------------
    // PUBLIC READ-ONLY ENDPOINT FOR LIBCAL TABLETS
    //
    // Allows Pod 1, 2 and 3 tablets to poll for
    // overtime alerts without Google authentication.
    //
    // Only GET requests with numeric pod IDs are
    // exempted from staff authentication.
    //
    // Patron details and alert creation remain protected.
    // ------------------------------------------------

    if (
      req.method === "GET" &&
      /^\/api\/pod-alert\/\d+$/.test(req.path)
    ) {
      return next();
    }

    // ------------------------------------------------
    // AUTHENTICATED STAFF
    // ------------------------------------------------

    if (isAuthorized(req.session?.user)) {

      // Protect actions against cross-site requests.
      // Both reservation actions and manual alert
      // creation must originate from our dashboard.

      if (
        req.method === "POST" &&
        (
          req.path === "/api/reservation-action" ||
          req.path === "/api/pod-alert"
        )
      ) {

        if (req.get("Origin") !== APP_ORIGIN) {
          return res.status(403).json({
            ok: false,
            error: "Action blocked: invalid request origin."
          });
        }

        if (
          !/^application\/json(?:\s*;|$)/i.test(
            req.get("Content-Type") || ""
          )
        ) {
          return res.status(415).json({
            ok: false,
            error: "Action requires JSON."
          });
        }
      }

      return next();
    }

    // ------------------------------------------------
    // UNAUTHORIZED REQUESTS
    // ------------------------------------------------

    req.session = null;

    // Block all other unauthenticated API requests.
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({
        error: "Staff sign-in required."
      });
    }

    // Redirect unauthorized page visitors to login.
    return res.redirect("/login");

  });
};
