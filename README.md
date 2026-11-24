# fuxam-mcp

Lets Claude read **your own** Fuxam account: calendar, courses, go/no-go and final assignments with deadlines, course materials, notifications. Ask things like "what's due this week?" or "what's on my calendar tomorrow?".

> **Unofficial.** This project is not affiliated with, endorsed by or supported by Fuxam.
> It uses undocumented routes of the Fuxam web app, so it can stop working at any time.
> Use it only on your own account, at your own risk, and check your institution's rules
> on automated access before you use it. There is no warranty (see [LICENSE](LICENSE)).

## How it works

- It runs on your computer. Nothing is hosted, and it talks to Fuxam only. The one exception is the optional Google Assignment submit tool, which also opens Google's own assignment pages.
- It keeps its own browser profile in `~/.fuxam-mcp/profile`. You sign in once in a normal browser window. The server never reads, stores or logs your password, cookies or tokens.
- It only reads. Every tool is a `GET` request made from inside that signed-in page, or the text of a page. It cannot change anything in Fuxam (the two experimental hand-in tools are off unless you switch them on).

## Install

You need three things on your computer first:

1. **Node.js** 18 or newer: download the "LTS" installer from <https://nodejs.org>.
2. **Git**: <https://git-scm.com/downloads> (on a Mac it is usually already there).
3. **Google Chrome**. No Chrome? See [Troubleshooting](#troubleshooting).

Then pick the app you use.

### Claude Code

Paste this into a terminal and press Enter:

```bash
claude mcp add fuxam -- npx -y github:ssamuels8/fuxam-mcp
```

### Claude desktop app

1. Open **Settings → Developer → Edit Config**. This opens a file called `claude_desktop_config.json`.
2. Put this in the file (if it already has an `mcpServers` part, add the `"fuxam"` entry inside it):

   ```json
   {
     "mcpServers": {
       "fuxam": {
         "command": "npx",
         "args": ["-y", "github:ssamuels8/fuxam-mcp"]
       }
     }
   }
   ```

3. Save the file, then quit Claude completely and open it again.

The first start downloads the server, which can take a minute.

### Sign in

Ask Claude: **"log in to Fuxam"**. A browser window opens. Sign in the way you always do, and the window closes by itself. You only do this once; after that Claude works in the background.

## Tools

| Tool | What it does |
|---|---|
| `fuxam_login` / `fuxam_status` | Sign in once / check the session |
| `get_calendar` | Upcoming appointments |
| `list_courses` | Active courses and their ids |
| `list_assignments` | Go/no-go, finals, uploads per module: status, deadline, grade |
| `get_course_deadlines` | Dated items for one course |
| `get_course_content` / `get_content_block` | Learning Journey blocks and files |
| `get_file_download_url` | Short-lived download link for a course file |
| `get_notifications` | Notifications (course chat messages, announcements) |
| `read_page` | Text of a dashboard page, such as My Studies |
| `fuxam_api_get` | Read-only `GET` on any other `/api/` route your account can open. Routes that hand out credentials or belong to payments and staff tooling are blocked. |

## Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `FUXAM_BASE_URL` | `https://fuxam.app` | Your institution's Fuxam address |
| `FUXAM_LOCALE` | `en` | Language segment in Fuxam URLs |
| `FUXAM_PROFILE_DIR` | `~/.fuxam-mcp/profile` | Where the browser profile lives |
| `FUXAM_ENABLE_UPLOAD` | unset | `1` enables the experimental File Upload tool |
| `FUXAM_ENABLE_SUBMIT` | unset | `1` enables the experimental Google Assignment tools |

## Submitting work (experimental, off by default)

Handing in work cannot always be undone, so both tools below are switched off until you turn them on, both do a dry run first, and both act only after you confirm the exact file and assignment.

**Google Assignment** requirements (most go/no-go and finals) are handed in on Google's pages, which Fuxam opens for you.

1. Turn the tools on. In Claude Code:

   ```bash
   claude mcp add fuxam -e FUXAM_ENABLE_SUBMIT=1 -- npx -y github:ssamuels8/fuxam-mcp
   ```

   In the Claude desktop app, add `"env": { "FUXAM_ENABLE_SUBMIT": "1" }` next to `"args"` in the config.
2. Ask Claude: **"log in to Google for Fuxam"**. A window opens on Google's sign-in page; sign in with your school Google account. The server never sees your password.
3. Ask Claude to submit, for example: "submit report.pdf from my Desktop for the Final Report of Lean Startup". Claude lists the matching assignment, shows its title, due date and status, and asks you before it attaches and submits.

`submit_google_assignment` has been checked up to the dry run on a live account. **Linking a Google account, attaching a file and pressing Submit have not been verified yet.** Until they are, check the result in Google yourself and do not leave a deadline to this tool.

**File Upload** requirements: `upload_assignment_file` (`FUXAM_ENABLE_UPLOAD=1`) **has never completed a real upload**. It lists the upload buttons on My Studies and says whether Fuxam has each one enabled (a button stays disabled until your instructor sets a submission deadline). It attaches a file only after a dry run and your explicit confirmation, and it never presses a final submit button.

## Troubleshooting

- **"Not signed in to Fuxam"**: ask Claude to "log in to Fuxam" again.
- **"No browser found"**: install Google Chrome, or run the command shown in the error message once (it downloads a browser for this server only).
- **"Could not start the browser"**: another copy of this server is probably still running. Quit Claude completely and open it again.
- **Sign out / remove everything**: delete the folder `~/.fuxam-mcp`.

## Status

Tested against one live student account in November 2026: sign-in, every read tool, Google sign-in, and the listing and dry-run steps of both hand-in tools.
Not tested: a real hand-in with either tool (attach and submit), Fuxam in other languages, other institutions' Fuxam addresses, Windows and Linux.

## Development

```bash
git clone https://github.com/ssamuels8/fuxam-mcp
cd fuxam-mcp
npm install
node src/index.js
```

Plain JavaScript (ES modules), no build step. Please keep every read tool `GET`-only, keep the hand-in tools opt-in, and never commit data from a real account.

## License

MIT
