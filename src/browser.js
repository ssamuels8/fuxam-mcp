// Browser session layer.
//
// Fuxam has no public API. Its web app talks to first-party JSON routes under
// /api/, authenticated by the browser session (Clerk). Instead of copying
// cookies or tokens around, this server keeps its own Chromium profile on the
// student's machine: the student signs in once in a visible window, and every
// read afterwards is a fetch() made from inside that signed-in page.
// No password, cookie or token is ever read, stored or sent by this code.

import { chromium } from "playwright";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

// The bundled Chromium must match the installed Playwright, so name the version in the hint.
const PLAYWRIGHT_VERSION = createRequire(import.meta.url)("playwright/package.json").version;

export const BASE = (process.env.FUXAM_BASE_URL || "https://fuxam.app").replace(/\/+$/, "");
export const LOCALE = process.env.FUXAM_LOCALE || "en";
const PROFILE = process.env.FUXAM_PROFILE_DIR || path.join(os.homedir(), ".fuxam-mcp", "profile");
const HOME_PATH = `/${LOCALE}/dashboard/calendar`;

let ctx = null;
let page = null;

export class NotLoggedInError extends Error {
  constructor() {
    super("Not signed in to Fuxam. Run the fuxam_login tool: a browser window opens, the student signs in there, then retry.");
  }
}

async function launch(headless) {
  await close();
  fs.mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
  // The profile holds the signed-in session: keep it readable by this user only.
  try {
    fs.chmodSync(PROFILE, 0o700);
    if (!process.env.FUXAM_PROFILE_DIR) fs.chmodSync(path.dirname(PROFILE), 0o700);
  } catch {
    /* not supported on this filesystem (e.g. Windows) */
  }
  const opts = { headless, viewport: { width: 1440, height: 900 } };
  const missing = (e) => /executable doesn't exist|is not found at|playwright install/i.test(String(e?.message || e));
  try {
    ctx = await chromium.launchPersistentContext(PROFILE, { ...opts, channel: "chrome" });
  } catch (chromeError) {
    if (!missing(chromeError)) throw launchError(chromeError);
    // No Google Chrome on this computer: fall back to Playwright's own Chromium.
    try {
      ctx = await chromium.launchPersistentContext(PROFILE, opts);
    } catch (chromiumError) {
      if (missing(chromiumError)) {
        throw new Error(
          `No browser found. Install Google Chrome, or run this once in a terminal and try again: npx playwright@${PLAYWRIGHT_VERSION} install chromium`
        );
      }
      throw launchError(chromiumError);
    }
  }
  page = ctx.pages()[0] || (await ctx.newPage());
}

function launchError(e) {
  const first = String(e?.message || e).split("\n")[0];
  return new Error(
    `Could not start the browser (${first}). If another copy of fuxam-mcp is running, close it: only one can use the profile in ${PROFILE} at a time.`
  );
}

export async function close() {
  if (ctx) await ctx.close().catch(() => {});
  ctx = null;
  page = null;
}

const onDashboard = (p) => {
  try {
    const u = new URL(p.url());
    return u.origin === BASE && u.pathname.includes("/dashboard");
  } catch {
    return false;
  }
};

/**
 * Wait until the app's auth library has loaded, or until the page has left the
 * dashboard (redirect to sign-in). The app keeps connections open, so waiting
 * for "network idle" just burns the whole timeout.
 */
async function settle(p) {
  await p
    .waitForFunction(() => window.Clerk?.loaded === true || !location.pathname.includes("/dashboard"), null, { timeout: 20000 })
    .catch(() => {});
}

const signedIn = async (p) => onDashboard(p) && (await p.evaluate(() => !!window.Clerk?.user).catch(() => false));

/** Make sure a signed-in dashboard page is open. A live page keeps the session fresh. */
export async function ensureSession() {
  if (!ctx || page?.isClosed()) await launch(true);
  if (!(await signedIn(page))) {
    await page.goto(BASE + HOME_PATH, { waitUntil: "domcontentloaded", timeout: 45000 });
    await settle(page);
  }
  if (!(await signedIn(page))) throw new NotLoggedInError();
  return page;
}

/** Open a visible window and wait (up to 5 minutes) for the student to sign in. */
export async function interactiveLogin() {
  await launch(false);
  await page.goto(BASE + HOME_PATH, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForURL((u) => u.origin === BASE && u.pathname.includes("/dashboard"), { timeout: 5 * 60 * 1000 });
  await page.waitForFunction(() => !!window.Clerk?.user, null, { timeout: 60000 });
  const who = await whoAmI().catch(() => null);
  await launch(true); // back to a background browser, same profile
  return who;
}

/**
 * Open a visible window so the student can sign in to their school Google
 * account themselves. Only needed for submitting Google Assignments. The
 * session stays in the same local profile; this code never sees the password.
 */
export async function interactiveGoogleLogin() {
  await launch(false);
  try {
    await page.goto("https://accounts.google.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    const done = page.waitForURL((u) => u.hostname === "myaccount.google.com", { timeout: 5 * 60 * 1000 }).then(() => "ok");
    const refused = page
      .getByText(/browser or app may not be secure|couldn.t sign you in/i)
      .first()
      .waitFor({ timeout: 5 * 60 * 1000 })
      .then(() => "refused");
    const result = await Promise.race([done, refused]);
    done.catch(() => {});
    refused.catch(() => {});
    if (result === "refused") {
      throw new Error("Google refused to sign in inside this server's browser window. Nothing was saved. Submit this assignment in your normal browser instead.");
    }
    return { googleSignedIn: true };
  } finally {
    await launch(true); // back to a background browser, same profile
  }
}

export async function whoAmI() {
  const p = await ensureSession();
  return p.evaluate(() => {
    const u = window.Clerk.user;
    return { userId: u.id, name: u.fullName || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || null };
  });
}

function buildApiUrl(apiPath, query) {
  if (typeof apiPath !== "string" || !apiPath.startsWith("/api/") || apiPath.includes("..") || apiPath.includes("//")) {
    throw new Error("Path must start with /api/ and stay on the Fuxam origin.");
  }
  const u = new URL(BASE + apiPath);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  if (u.origin !== BASE) throw new Error("Refusing to call a non-Fuxam origin.");
  return u.pathname + u.search;
}

/** Read-only GET against Fuxam's own JSON routes, from inside the signed-in page. */
export async function apiGet(apiPath, query) {
  const url = buildApiUrl(apiPath, query);
  const p = await ensureSession();
  const run = () =>
    p.evaluate(async (u) => {
      const r = await fetch(u, {
        method: "GET",
        credentials: "include",
        headers: { "x-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone },
      });
      return { status: r.status, contentType: r.headers.get("content-type") || "", text: await r.text() };
    }, url);

  let res = await run();
  if (res.status === 401 || res.status === 403) {
    // Session token may have gone stale: reload once so the app refreshes it.
    await p.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await settle(p);
    if (!(await signedIn(p))) throw new NotLoggedInError();
    res = await run();
  }
  if (res.status === 401) throw new NotLoggedInError();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Fuxam returned HTTP ${res.status} for ${url}: ${res.text.slice(0, 300)}`);
  }
  if (res.contentType.includes("json")) {
    try {
      return JSON.parse(res.text);
    } catch {
      /* fall through */
    }
  }
  return res.text;
}

/** Open a dashboard page in a temporary tab and run fn(page) on it. */
export async function withPage(dashPath, fn) {
  if (typeof dashPath !== "string" || !dashPath.startsWith("/") || dashPath.includes("//") || !dashPath.includes("/dashboard")) {
    throw new Error(`Path must be a Fuxam dashboard path such as /${LOCALE}/dashboard/my-studies`);
  }
  await ensureSession();
  const tab = await ctx.newPage();
  try {
    await tab.goto(BASE + dashPath, { waitUntil: "domcontentloaded", timeout: 45000 });
    await settle(tab);
    if (!(await signedIn(tab))) throw new NotLoggedInError();
    await tab.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    return await fn(tab);
  } finally {
    await tab.close().catch(() => {});
  }
}
