#!/usr/bin/env node
// fuxam-mcp: unofficial MCP server for a student's own Fuxam account.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { BASE, LOCALE, apiGet, close, interactiveLogin, whoAmI, withPage } from "./browser.js";

const MAX_CHARS = 60000;
const MY_STUDIES = `/${LOCALE}/dashboard/my-studies`;

const text = (value) => {
  let s = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS) + `\n…[truncated at ${MAX_CHARS} characters; narrow the request]`;
  return { content: [{ type: "text", text: s }] };
};
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e?.message || e}` }], isError: true });
// One browser, one profile: run tool calls one at a time so two calls can never
// race to launch or relaunch the browser.
let queue = Promise.resolve();
const tool = (fn) => (args) => {
  const run = queue.then(async () => {
    try {
      return text(await fn(args || {}));
    } catch (e) {
      return fail(e);
    }
  });
  queue = run;
  return run;
};

const endOf = (iso, minutes) => (iso && minutes ? new Date(new Date(iso).getTime() + minutes * 60000).toISOString() : null);

function slimAppointment(a) {
  return {
    id: a.id,
    title: a.title,
    start: a.dateTime,
    end: endOf(a.dateTime, a.duration),
    durationMinutes: a.duration,
    room: a.room?.name || null,
    address: a.address || a.room?.address || null,
    online: !!a.isOnline,
    hybrid: !!a.isHybrid,
    onlineAddress: a.onlineAddress || null,
    mandatoryForAttendance: !!a.isMandatoryForAttendance,
    courses: (a.appointmentLayers || []).map((l) => l.layer?.name?.trim()).filter(Boolean),
    notes: a.notes || null,
  };
}

async function activeCourses() {
  const data = await apiGet("/api/widgets/get-courses", { enrollmentStatus: "active" });
  return (data.courses || []).map((c) => ({
    courseId: c.layer_id,
    name: (c.name || "").trim(),
    code: c.code || null,
    moduleVersionId: c.courseModuleVersionId || null,
    url: `${BASE}/${LOCALE}/dashboard/course/${c.layer_id}`,
  }));
}

const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
/** Click "Expand all" when the page has it (it only changes what is shown). Returns true if clicked. */
async function expandAll(tab) {
  const btn = tab.getByRole("button", { name: /expand all/i }).first();
  try {
    await btn.waitFor({ state: "visible", timeout: 5000 });
    await btn.click();
    await tab.getByRole("button", { name: /collapse all/i }).first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    await tab.waitForTimeout(800);
    return true;
  } catch {
    return false;
  }
}

const server = new McpServer({ name: "fuxam", version });

server.tool(
  "fuxam_login",
  "Open a visible browser window on this computer so the student can sign in to Fuxam themselves. Needed once; the session is kept in a local profile. Waits up to 5 minutes.",
  {},
  tool(async () => {
    const who = await interactiveLogin();
    return { signedIn: true, ...who };
  })
);

server.tool(
  "fuxam_status",
  "Check whether the local Fuxam session is signed in, and as whom.",
  {},
  tool(async () => ({ signedIn: true, base: BASE, ...(await whoAmI()) }))
);

server.tool(
  "get_calendar",
  "Upcoming appointments from the student's Fuxam calendar (lectures, coaching, go/no-go sessions), soonest first. Times are ISO 8601 UTC.",
  { limit: z.number().int().min(1).max(100).default(20).describe("How many upcoming appointments to return. Fuxam sends about 20 per request, so larger values may still return 20 (hasMore says if there are more)") },
  tool(async ({ limit = 20 }) => {
    const data = await apiGet("/api/user/paginated-agenda", {
      organizerFilter: "all",
      timeRange: "all_upcoming",
      showPastAppointments: false,
      direction: "initial",
      limit,
    });
    // Fuxam returns its own page size whatever limit is sent, so trim here.
    const all = data.appointments || [];
    return { appointments: all.slice(0, limit).map(slimAppointment), hasMore: !!data.hasMore || all.length > limit };
  })
);

server.tool(
  "list_courses",
  "The student's active courses with their ids. Use courseId with the course tools.",
  {},
  tool(async () => ({ courses: await activeCourses() }))
);

server.tool(
  "list_assignments",
  "Every exam requirement per module: go/no-go assignments, final assignments, presentations, uploads. Shows status, deadline and grade. In Fuxam these live under My Studies (collapsed rows), not inside the course.",
  { course: z.string().optional().describe("Optional text filter on the course name, e.g. 'marketing'") },
  tool(async ({ course }) => {
    const { userId } = await whoAmI();
    let courses = (await activeCourses()).filter((c) => c.moduleVersionId);
    if (course) courses = courses.filter((c) => c.name.toLowerCase().includes(course.toLowerCase()));
    const out = [];
    const errors = [];
    for (const c of courses) {
      try {
        const data = await apiGet("/api/user-study-plan/module-exam-attempts", { userId, moduleVersionId: c.moduleVersionId });
        for (const term of data.attemptsByTermAndNumber || []) {
          for (const r of term.examRequirements || []) {
            out.push({
              course: c.name,
              requirement: r.examRequirementName,
              status: r.status,
              deadline: r.scheduledDate || r.appointmentDateTime || r.defaultDeadline || null,
              grade: r.isGradePublished ? r.grade ?? r.gradeDisplayComplete ?? null : null,
              grading: r.ratingMode,
              attempt: term.attemptNumber,
              term: term.organizationTermName,
              withdrawn: !!r.hasWithdrawn,
            });
          }
        }
      } catch (e) {
        errors.push({ course: c.name, error: e.message });
      }
    }
    out.sort((a, b) => String(a.deadline || "9").localeCompare(String(b.deadline || "9")));
    return {
      assignments: out,
      whereToSubmit: `${BASE}${MY_STUDIES} → "This semester" → Expand all → the module row → the requirement's button (Open Google Assignment / Upload file).`,
      note: `Only modules linked to an active course are covered, and Fuxam's data does not say how each one is submitted. For every module of the semester and the submission type (Google Assignment / File Upload), use read_page on ${MY_STUDIES}.`,
      ...(errors.length ? { errors } : {}),
    };
  })
);

server.tool(
  "get_course_deadlines",
  "Upcoming dated items for one course (sessions and deadlines).",
  { course_id: z.string(), limit: z.number().int().min(1).max(50).default(15) },
  tool(async ({ course_id, limit = 15 }) => {
    const data = await apiGet(`/api/course/${encodeURIComponent(course_id)}/dashboard/deadlines`, { lang: LOCALE, limit });
    return {
      items: (data.items || []).map((i) => ({ title: i.title, type: i.contentType || i.type, due: i.dueDate, url: i.href ? BASE + i.href : null })),
      hasMore: !!data.hasMore,
    };
  })
);

server.tool(
  "get_course_content",
  "The Learning Journey of one course: sections, files, links, their status and attached file URLs.",
  { course_id: z.string() },
  tool(async ({ course_id }) => {
    const data = await apiGet(`/api/course/${encodeURIComponent(course_id)}/content-blocks`);
    const blocks = data.blocksWithUserData || data.blocks || [];
    return {
      blocks: blocks.map((b) => ({
        blockId: b.id,
        name: b.name,
        type: b.type,
        position: b.position,
        dueDate: b.dueDate || null,
        userStatus: b.userStatus || null,
        locked: b.conditionState && b.conditionState !== "UNLOCKED" ? b.conditionState : false,
        files: b.specs?.files || undefined,
        link: b.specs?.url || b.specs?.link || undefined,
        url: `${BASE}/${LOCALE}/dashboard/course/${course_id}/learning-materials/learning-journey?blockId=${b.id}`,
      })),
    };
  })
);

server.tool(
  "get_content_block",
  "Full detail of one Learning Journey block (text content, files, settings).",
  { block_id: z.string() },
  tool(async ({ block_id }) => {
    const data = await apiGet(`/api/course/content-block/${encodeURIComponent(block_id)}`);
    // The response repeats the student's own name and e-mail; no need to pass that on.
    if (data?.userCurrentStatus?.user) delete data.userCurrentStatus.user;
    return data;
  })
);

server.tool(
  "get_file_download_url",
  "Turn a Fuxam file URL (from get_course_content) into a short-lived signed download link.",
  { url: z.string().describe("File URL exactly as returned by Fuxam") },
  tool(async ({ url }) => apiGet("/api/file-storage/download", { url }))
);

server.tool(
  "get_notifications",
  "The student's Fuxam notifications (mostly course chat messages and announcements), newest first.",
  {
    unread_only: z.boolean().default(true),
    limit: z.number().int().min(1).max(100).default(20),
  },
  tool(async ({ unread_only = true, limit = 20 }) => {
    const [all, unreadCount] = await Promise.all([
      apiGet("/api/notifications/get-all"),
      apiGet("/api/notifications/get-unread-notifications").catch(() => null),
    ]);
    const list = (Array.isArray(all) ? all : []).filter((n) => !unread_only || !n.read);
    return {
      unreadCount: typeof unreadCount === "number" ? unreadCount : undefined,
      returned: Math.min(list.length, limit),
      notifications: list.slice(0, limit).map((n) => {
        const d = n.data || {};
        const v = { ...(d.titleValues || {}), ...(d.messageValues || {}) };
        return {
          id: n.id,
          type: d.type || null,
          from: v.senderName || null,
          about: v.groupChatName || d.data?.title || null,
          message: v.message || d.data?.body || null,
          read: !!n.read,
          createdAt: n.createdAt,
        };
      }),
    };
  })
);

// Routes that hand out credentials or belong to staff tooling: never proxied.
const BLOCKED = [/^\/api\/stream-chat\/token/, /^\/api\/stripe/, /^\/api\/v2\//, /^\/api\/ingest/, /qr/i];

server.tool(
  "fuxam_api_get",
  "Escape hatch: read-only GET on any other Fuxam /api/ route the student's own account can access (e.g. /api/calendar/next-upcoming-event, /api/announcements/pinned-list, /api/user-curriculum/exam-details). GET only; cannot change anything.",
  {
    path: z.string().describe("Route starting with /api/"),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  },
  tool(async ({ path: p, query }) => {
    if (BLOCKED.some((re) => re.test(p))) throw new Error("That route is blocked in this server.");
    return apiGet(p, query);
  })
);

server.tool(
  "read_page",
  "Read the visible text of any Fuxam dashboard page as the student sees it. For server-rendered pages with no JSON route, such as My Studies (all modules of the semester, each requirement's submission type and button). Fuxam redirects unknown paths; check the returned url.",
  {
    path: z.string().describe(`Dashboard path, e.g. ${MY_STUDIES}`),
    expand: z.boolean().default(true).describe("Click 'Expand all' first when the page has it"),
  },
  tool(async ({ path: p, expand = true }) =>
    withPage(p, async (tab) => {
      const expanded = expand ? await expandAll(tab) : false;
      return tab.evaluate((expanded) => ({
        expanded,
        title: document.title,
        url: location.href,
        text: (document.querySelector("main") || document.body).innerText,
      }), expanded);
    })
  )
);

// ---------------------------------------------------------------------------
// EXPERIMENTAL, off by default. Fuxam submits through Next.js server actions,
// not a stable route, so an upload has to drive the real page. This flow has
// NOT been verified against a real submission yet: what happens after the
// button is clicked (dialog or native file chooser) has never been observed.
// Enable with FUXAM_ENABLE_UPLOAD=1, and always do a dry run first.
// ---------------------------------------------------------------------------
if (process.env.FUXAM_ENABLE_UPLOAD === "1") {
  server.tool(
    "upload_assignment_file",
    "EXPERIMENTAL, never verified against a real submission. Attach a local file to a 'File Upload' exam requirement on My Studies. Step 1: call with no target_index to list the upload buttons with their module, requirement and whether Fuxam has them enabled (a button stays disabled until the instructor sets a submission deadline). Step 2: call with target_index (confirm=false) for a dry run that clicks an enabled button and reports what Fuxam shows without attaching anything. Step 3: only after the student explicitly approves, call again with confirm=true. Never set confirm=true on your own initiative. It attaches the file and stops; it does not press any final submit button.",
    {
      target_index: z.number().int().min(0).optional(),
      file_path: z.string().optional().describe("Absolute path of the file on this computer"),
      confirm: z.boolean().default(false),
      button_label: z.string().default("upload file").describe("Button text to look for (change for non-English locales)"),
    },
    tool(async ({ target_index, file_path, confirm = false, button_label = "upload file" }) =>
      withPage(MY_STUDIES, async (tab) => {
        await expandAll(tab);
        // My Studies lists each module's requirements as <ul aria-label="Exams in <module>"><li>…</li></ul>,
        // one <li> per requirement with its button on the right.
        const label = new RegExp(`^\\s*${button_label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
        const rows = tab.locator("main ul[aria-label] > li").filter({ has: tab.getByRole("button", { name: label }) });
        const count = await rows.count();
        const targets = [];
        for (let i = 0; i < count; i++) {
          const row = rows.nth(i);
          const info = await row.evaluate((li) => {
            const lines = li.innerText.split("\n").map((t) => t.trim()).filter(Boolean);
            return {
              module: (li.closest("ul[aria-label]").getAttribute("aria-label") || "").replace(/^Exams in\s+/i, ""),
              requirement: lines[0] || null,
              detail: lines[1] || null,
            };
          });
          const enabled = await row.getByRole("button", { name: label }).isEnabled();
          let disabledReason;
          if (!enabled) {
            // Fuxam explains a disabled button in a tooltip; hovering only reads it.
            await row.locator("[data-slot=tooltip-trigger]").first().hover({ timeout: 3000 }).catch(() => {});
            const tip = await tab.locator("[role=tooltip], [data-slot=tooltip-content]").first().innerText({ timeout: 1500 }).catch(() => "");
            disabledReason = tip.split("\n")[0] || "Fuxam shows this button as disabled.";
            await tab.mouse.move(2, 2);
          }
          targets.push({ index: i, ...info, enabled, ...(enabled ? {} : { disabledReason }) });
        }
        if (target_index === undefined) return { step: "choose target_index", targets };
        if (target_index >= count) throw new Error(`target_index ${target_index} out of range (found ${count} upload buttons).`);
        const target = targets[target_index];
        if (!target.enabled) {
          return { step: "stopped: Fuxam has this upload button disabled, nothing was clicked", target };
        }
        if (confirm) {
          if (!file_path || !path.isAbsolute(file_path)) throw new Error("confirm=true needs an absolute file_path.");
          if (!fs.existsSync(file_path) || !fs.statSync(file_path).isFile()) throw new Error("confirm=true needs an existing file at file_path.");
        }

        const chooserPromise = tab.waitForEvent("filechooser", { timeout: 6000 }).catch(() => null);
        await rows.nth(target_index).getByRole("button", { name: label }).click();
        const chooser = await chooserPromise;
        await tab.waitForTimeout(1500);
        const snapshot = async () =>
          tab.evaluate(() => {
            const d = document.querySelector("[role=dialog]");
            return {
              url: location.href,
              dialogText: d ? d.innerText.slice(0, 1500) : null,
              dialogButtons: d ? [...d.querySelectorAll("button")].map((b) => b.innerText.trim() || b.getAttribute("aria-label")) : [],
              fileInputs: document.querySelectorAll("input[type=file]").length,
            };
          });

        if (!confirm) {
          const ui = await snapshot();
          await tab.keyboard.press("Escape").catch(() => {}); // close whatever opened; nothing was attached
          return { step: "dry run, nothing attached", target, nativeFileChooserOpened: !!chooser, ui };
        }
        if (chooser) {
          await chooser.setFiles(file_path);
        } else {
          const input = tab.locator("input[type=file]").first();
          if (!(await input.count())) throw new Error("No file chooser or file input appeared; upload flow differs from what this tool expects. Nothing was attached.");
          await input.setInputFiles(file_path);
        }
        await tab.waitForTimeout(3000);
        return {
          step: "file attached; no final submit button was pressed by this tool",
          target,
          ui: await snapshot(),
          next: "Open My Studies in Fuxam and check the attempt shows the file before relying on it.",
        };
      })
    )
  );
}

const shutdown = async () => {
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
