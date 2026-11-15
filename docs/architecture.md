# AI MCQ Assistant Architecture Document

## 1. System Overview

AI MCQ Assistant is a local-first system designed for learners solving practice multiple-choice questions. It provides real-time DOM extraction, intelligent AI reasoning through Google Gemini, and interactive selection confirmation without sending sensitive data to third-party cloud servers.

```mermaid
graph TD
    subgraph Browser ["Google Chrome Client"]
        DOM["Webpage DOM / Practice Portal"]
        CS["Content Script: DOMQuestionExtractor & DOMInteractionManager"]
        MO["DOMQuestionObserver (MutationObserver)"]
        SW["Service Worker Background Script"]
        UI["React Extension UI (Popup & Side Panel)"]
    end

    subgraph Backend ["Local NestJS Backend (http://127.0.0.1:3000)"]
        AUTH["AuthGuard (Localhost IP + Pairing Token)"]
        CONF["Config Module (SQLite Persistence)"]
        SESS["Sessions Module (Lifecycle & Metrics)"]
        QUES["Questions Module (Deduplication & Cache)"]
        PROV["GeminiProvider (Official SDK @google/generative-ai)"]
        WS["EventsGateway (Socket.io WebSocket Server)"]
        DB[(Local SQLite Database: data/mcq_assistant.db)]
    end

    subgraph External ["External AI Provider"]
        GEMINI["Google Gemini API"]
    end

    DOM -->|Scans nodes & labels| CS
    DOM -.->|Mutations & Stepper navigation| MO
    MO -->|Debounced updates| CS
    CS -->|Runtime messaging| SW
    SW -->|State sync| UI
    UI -->|User action: Solve / Confirm| SW
    SW -->|Authenticated HTTP Requests| AUTH
    AUTH --> CONF
    AUTH --> SESS
    AUTH --> QUES
    QUES -->|Cache Check| DB
    QUES -->|Cache Miss| PROV
    PROV -->|Structured Prompt with JSON schema| GEMINI
    GEMINI -->|Structured JSON Output| PROV
    PROV -->|Validated AIAnswerResult| QUES
    QUES -->|Persist answer| DB
    QUES -->|Emit Live Progress| WS
    WS -.->|WebSocket live events| UI
    UI -->|Confirm selection| CS
    CS -->|Controlled click & checked verify| DOM
```

---

## 2. Extraction Pipeline

```mermaid
flowchart TD
    Start["DOM Scan Triggered"] --> S1{"Container Match?<br/>.question, .mcq, [data-question]"}
    S1 -- Yes --> ExtOptions["Extract Options & Labels"]
    S1 -- No --> S2{"Grouped Radios?<br/>input[type='radio'][name]"}
    S2 -- Yes --> Ancestor["Find Common Ancestor & Nearest Prompt"]
    Ancestor --> ExtOptions
    S2 -- No --> S3{"ARIA Roles?<br/>[role='radiogroup']"}
    S3 -- Yes --> ExtAria["Extract [role='radio'] with aria-checked"]
    ExtAria --> ExtOptions
    S3 -- No --> S4{"Single-Question Stepper Page?"}
    S4 -- Yes --> ExtStepper["Extract Form Prompt & Options"]
    ExtStepper --> ExtOptions
    S4 -- No --> Fallback["Report Ambiguous / No MCQ Detected"]

    ExtOptions --> Fingerprint["Generate Stable Fingerprint:<br/>FNV-1a(normalized text + sorted options)"]
    Fingerprint --> Observer["MutationObserver Watcher Attached"]
    Observer --> Ready["ExtractedQuestion Ready for AI"]
```

---

## 3. Session State Machine

```mermaid
stateDiagram-v2
    [*] --> DETECTED: Page loaded / DOM scanned
    DETECTED --> EXTRACTING: Questions parsed
    EXTRACTING --> READY_FOR_AI: Options matched
    READY_FOR_AI --> PROCESSING: User triggers solve
    PROCESSING --> ANSWER_READY: High confidence answer (>= 0.70)
    PROCESSING --> NEEDS_REVIEW: Ambiguous / Low confidence / Multiple valid answers
    PROCESSING --> FAILED: API limit / Network timeout
    ANSWER_READY --> AWAITING_CONFIRMATION: Rendered in UI
    AWAITING_CONFIRMATION --> COMPLETED: User confirms selection on webpage
    NEEDS_REVIEW --> COMPLETED: User manually reviews & selects
    FAILED --> READY_FOR_AI: Retry question
    COMPLETED --> [*]: Session finished
```

---

## 4. Security Principles

1. **Strict Localhost Binding**: The backend listens solely on loopback `127.0.0.1`.
2. **Credential Privacy**: The Gemini API key never passes to the Chrome Extension content script or web pages.
3. **Controlled Browser Interaction**: Elements are checked using standard dispatch events, verifying the element state without arbitrary eval execution.

