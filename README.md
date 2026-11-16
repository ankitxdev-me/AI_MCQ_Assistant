# AI MCQ Assistant

Production-ready local Chrome Extension (Manifest V3) and local NestJS backend that extracts multiple-choice questions (MCQs) directly from webpage DOM structures and delivers structured AI reasoning and step-by-step explanations using Google Gemini.

Designed for practice and assignment portals with a local-first, zero-cloud architecture.

---

## 1. Architecture Overview

```
Chrome Webpage (DOM)
        │
        ▼ (DOM relationships, forms, ARIA radiogroups, MutationObserver)
Content Script (apps/extension/src/content)
        │
        ▼ (Chrome Runtime Messaging)
Service Worker Background Script (apps/extension/src/background)
        │
        ▼ (Authenticated Localhost HTTP + WebSockets: http://127.0.0.1:3000)
NestJS Local Backend (apps/backend/src)
 ├── Security Guard (Localhost IP + x-pairing-token verification)
 ├── Configuration Service (Local SQLite persistence)
 ├── Session State Manager (Active/Paused/Stopped session metrics)
 ├── Question Processor & Deduplication Cache
 ├── Provider Abstraction (Google Gemini SDK)
 └── WebSocket Events Gateway (Live progress updates)
        │
        ▼ (SQLite Database: data/mcq_assistant.db)
Google Gemini API (Official @google/generative-ai SDK)
```

- **Localhost Only**: The backend strictly binds to `127.0.0.1:3000` and rejects non-local network access.
- **Credential Protection**: The extension never bundles or leaks the Gemini API key. All keys are stored safely on the local machine in SQLite.
- **Pure DOM Extraction**: Uses no screenshots, OCR, or vision APIs for HTML questions.
- **Zero Cloud Hosting**: Requires no VPS, Redis, PostgreSQL, or cloud infrastructure.

---

## 2. Monorepo Structure

```
ai-mcq-assistant/
│
├── apps/
│   ├── extension/               # Chrome Manifest V3 Extension
│   │   ├── public/
│   │   │   └── manifest.json    # Manifest V3 specification
│   │   ├── src/
│   │   │   ├── background/      # Service worker & pairing auth
│   │   │   ├── content/         # DOM extraction & MutationObserver engine
│   │   │   ├── popup/           # Extension popup dialog
│   │   │   ├── sidepanel/       # Chrome Side Panel UI
│   │   │   └── shared/          # React screens (Setup, Main, Card, Results)
│   │   ├── popup.html
│   │   ├── sidepanel.html
│   │   └── vite.config.ts
│   │
│   └── backend/                 # NestJS Local Backend
│       └── src/
│           ├── common/          # SQLite database, Auth guard, Filters, Pipes
│           ├── config/          # API key persistence & connection testing
│           ├── events/          # Socket.io gateway for live updates
│           ├── providers/       # GeminiProvider abstraction & SDK integration
│           ├── questions/       # Question solver, deduplication & cache
│           ├── sessions/        # Practice session lifecycle management
│           ├── health.controller.ts
│           └── main.ts          # Server bootstrap (127.0.0.1:3000)
│
├── packages/
│   └── shared-types/            # Shared TypeScript types & Zod validation schemas
│
├── test-portal.html             # Verification test suite with 10 practice MCQs
├── .env.example
├── package.json
└── README.md
```

---

## 3. Quick Start & Installation

### Prerequisites
- Node.js 18+ (tested on Node.js v24)
- npm 9+
- Google Chrome (or Chromium-based browser)

### Step 1: Install Dependencies & Build
From the repository root:
```bash
# 1. Install all dependencies across workspaces
npm install

# 2. Build shared types, backend, and extension
npm run build
```

---

## 4. Running the Local Backend

**Windows, easiest:** double-click `start-backend.cmd` in the repo root and keep its window open. It installs and builds on first run. If the extension shows the backend as offline, this window was closed: run it again. Auto-Loop waits up to 5 minutes for the backend to come back.


Start the NestJS backend in development or production mode:

```bash
# Production mode (runs compiled TypeScript from dist)
npm run start:prod --workspace=@ai-mcq/backend

# Or Development mode (with live reload)
npm run start:backend
```

The backend starts on `http://127.0.0.1:3000`.

### Health & Status Verification
You can verify backend health in your terminal or browser:
```bash
curl http://127.0.0.1:3000/api/health
# Returns: {"status":"ok","service":"ai-mcq-backend",...}
```

---

## 5. Installing the Extension in Chrome

1. Open Google Chrome and navigate to: `chrome://extensions/`
2. Enable **Developer mode** using the toggle switch in the top right corner.
3. Click the **Load unpacked** button in the top left.
4. Select the build output directory:
   ```
   <repo-root>/apps/extension/dist
   ```
5. The **AI MCQ Assistant** icon will appear in your Chrome toolbar.
6. (Optional) Pin the extension to your toolbar for one-click access.

---

## 6. First-Launch Configuration

1. Click the extension icon in your Chrome toolbar or open the Chrome Side Panel.
2. If this is your first launch, the extension automatically displays **Screen A: Initial Setup**.
3. Enter your [Google Gemini API Key](https://aistudio.google.com/app/apikey).
4. Select your Gemini model. `gemini-3.5-flash-lite` is the default (fast and cheap). `gemini-3.6-flash` / `gemini-3.8-flash` are stronger. The 1.5 and 2.0 models are shut down.
5. Click **Test Connection** to verify API validity and latency.
6. Click **Save Settings**.
7. The configuration is securely stored in your local SQLite database (`apps/backend/data/mcq_assistant.db`) and will load automatically on future launches.

*Development Fallback: You can also specify `GEMINI_API_KEY=your_key` in an `.env` file in `apps/backend/` for automated local testing.*

---

## 7. Testing with the Local Test Portal

A test portal is provided in the root directory: [`test-portal.html`](file:///c:/Users/ankit/OneDrive/Documents/Chrome%20Extension/test-portal.html).

It contains 10 test MCQs testing every supported scenario:
1. **Standard Radio Buttons** (Question 1)
2. **Label Association with `for`/`id`** (Question 2)
3. **Fieldset / Legend Grouping** (Question 3)
4. **Accessible Custom ARIA Controls (`role="radiogroup"` / `role="radio"`)** (Question 4)
5. **Single-Question Stepper Wizard with Previous/Next Navigation** (Questions 5 to 8)
6. **Dynamically Injected Question with MutationObserver** (Question 9)
7. **Intentionally Ambiguous Question** (Question 10 - triggers uncertainty flag and review state)

### How to test:
1. Open [`test-portal.html`](file:///c:/Users/ankit/OneDrive/Documents/Chrome%20Extension/test-portal.html) in Google Chrome.
2. Open the **AI MCQ Assistant** Side Panel or Popup.
3. Click **Start Practice Session**.
4. The extension extracts all visible questions and displays the active question.
5. Click **Solve with Gemini**: the backend analyzes the question, performs deduplication, calls Gemini, and displays the structured answer with an explanation.
6. Click **Confirm Selection**: the extension simulates a controlled click on the webpage element and verifies the checked state.
7. Click **Next** to navigate forward.
8. Click **Inject Question 9** on the test page: the MutationObserver detects the newly injected DOM question and updates the extension automatically.
9. Click **Stop Session** and **Summary** to view the full session history, duration, and question breakdown.

---

## 7b. What the Auto-Loop handles

- Single-answer, multi-answer (checkbox) and True/False questions (radios or plain buttons).
- Code shown in a split-pane editor (CodeMirror, Monaco, Ace) or `<pre>`, sent to the AI as a `[CODE]` block.
- "Match the columns" tables, sent as a Markdown table.
- Image questions: images, SVG diagrams and canvases are sent to Gemini as pictures. If an image cannot be read, a cropped screenshot of the question is used (only works while the tab is the visible tab in its window).
- Sequence / drag-and-drop questions: the items are dragged into the AI's order through the page's own drag library, the final order is checked, then submitted. Dragging needs the tab to be visible; in a background tab the loop waits and tells you.
- Several tabs at once: each tab runs its own loop. Waits run on the extension's service worker so background tabs are not slowed down by Chrome. Gemini calls are queued (`GEMINI_MAX_CONCURRENCY`, default 2) and rate-limit errors back off instead of stopping the loop.
- The loop pauses (instead of guessing) when the AI is unsure, when its answer matches no option, or when a click does not register.

### Knowledge base

Notes added in the side panel are sent with every question. Cached answers remember which notes were active, so adding or deleting a note makes questions get re-asked instead of serving stale answers.

## 7c. End-to-end checks

```bash
# Backend must be running. Uses the Gemini key saved in the extension.
node e2e/kb-eval.mjs
```

`test-portal-advanced.html` is a React practice portal (code pane, match table, image-only, True/False, multi-answer, react-beautiful-dnd sequence). Serve the repo root over HTTP, open the page, then in the console: `await import('/e2e/harness.js'); await __e2e.load(); await __e2e.start();` (needs `npx esbuild apps/extension/src/background/media.ts --bundle --format=iife --global-name=BgMedia --outfile=e2e/.build/bgmedia.js` once).

## 8. Automated Test Suite

Run the unit and integration test suite:

```bash
npm test
```

### Tested Scenarios:
- **Question Extraction**: Standard radio inputs, label associations, container scoping, ARIA radiogroups.
- **Fingerprinting**: Case-insensitive and whitespace-insensitive deterministic hashing.
- **Option Identification**: Accurate matching of option letters (`A`, `B`, `C`, `D`) and text values.
- **Controlled Interaction**: Checked state verification and safe button dispatch.
- **AI Response Parsing**: JSON extraction from markdown code fences and Zod schema validation.
- **Duplicate Request Prevention**: In-memory and SQLite cache lookup prevents re-querying Gemini for previously analyzed questions.
- **Authentication**: Localhost-only restriction and pairing token validation.
- **Session State Transitions**: Active, Paused, Resumed, and Stopped flows.

---

## 9. Security & Compliance

- **No Public Backend Exposure**: The NestJS server binds strictly to loopback interface `127.0.0.1`.
- **Restricted Assessment Integrity**: The extension does not bypass proctoring locks, camera controls, or examination security gates.
- **No Screenshot OCR Fallback**: DOM inspection is used exclusively for HTML questions.

