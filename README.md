<div align="center">

<img src="https://img.shields.io/badge/REVA-AI%20Code%20Reviewer-6366f1?style=for-the-badge&logoColor=white" alt="REVA" />

# REVA — AI Code Reviewer

**Most AI review tools only see the diff. REVA sees your entire codebase.**

REVA uses [Nia](https://trynia.ai/) to index your full codebase before reviewing — so it can tell you when your PR conflicts with a pattern in a file you didn't touch.

[Live Demo](#) · [Report Bug](https://github.com/abhishekrana43/REVA/issues) · [Request Feature](https://github.com/abhishekrana43/REVA/issues)

---

![Next.js](https://img.shields.io/badge/Next.js-000000?style=flat-square&logo=next.js&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express.js-000000?style=flat-square&logo=express&logoColor=white)
![Claude](https://img.shields.io/badge/Claude%20AI-D97706?style=flat-square&logoColor=white)
![Nia](https://img.shields.io/badge/Nia%20Indexing-6366f1?style=flat-square&logoColor=white)

</div>

---

## The Problem with Existing AI Code Reviewers

Traditional AI reviewers analyze your diff in isolation. That means they miss the bigger picture:

| Problem | Impact |
|---|---|
| No awareness of patterns outside the diff | Misses architectural violations |
| Can't see related files you didn't touch | Incomplete dependency analysis |
| No understanding of project-wide conventions | Weak, generic suggestions |
| Treats every review as a fresh context | No accumulated codebase knowledge |

**REVA solves this with full-codebase context — powered by [Nia](https://trynia.ai/).**

---

## How REVA Works

When a PR is opened, REVA runs a 4-step pipeline:

```
GitHub PR Opened
       │
       ▼
① Retrieve Diff
   Pull the PR diff from GitHub API

       │
       ▼
② Search Indexed Codebase (via Nia)
   Find related files, patterns, similar logic,
   and dependencies relevant to the diff

       │
       ▼
③ Send Diff + Context → Claude AI
   Claude reviews the code with full project
   context, not just the changed lines

       │
       ▼
④ Post Structured Review on PR
   A clean, actionable comment is posted
   directly on the GitHub Pull Request
```

This means REVA can catch things like:
- *"This function duplicates logic already defined in `utils/auth.js`"*
- *"This change breaks the error-handling pattern used across 6 other routes"*
- *"A similar implementation in `services/payment.js` uses a safer approach"*

---

## Features

- **🧠 Full-Codebase Awareness** — Nia indexes your entire repository before the first review, so context is never missing
- **🔍 Intelligent PR Reviews** — Diff + context sent to Claude for deep, accurate analysis
- **⚡ GitHub Integration** — Automatically triggers on PR open; posts review as a PR comment
- **📁 Multi-File Context** — Understands relationships between files you changed and files you didn't
- **🛡️ Code Quality Insights** — Detects bad practices, potential bugs, anti-patterns, and optimization opportunities
- **🎯 Developer Dashboard** — Clean UI to manage repositories, view past reviews, and track insights
- **🔐 Secure Architecture** — Scalable Express backend with environment-isolated API keys

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js, React.js, TypeScript |
| Backend | Node.js, Express.js |
| AI Review | Claude (Anthropic) |
| Code Indexing | [Nia](https://trynia.ai/) |
| VCS Integration | GitHub API |

---

## Project Structure

```
REVA/
│
├── dashboard/                  # Next.js frontend
│   ├── app/
│   │   ├── page.tsx            # Landing / dashboard home
│   │   ├── reviews/            # Review history & detail pages
│   │   └── settings/           # Repo and config management
│   ├── components/             # Reusable UI components
│   └── public/
│
├── backend/                    # Node.js + Express backend
│   ├── controllers/
│   │   ├── reviewController.js # Core review pipeline logic
│   │   └── webhookController.js# GitHub webhook handler
│   ├── routes/
│   │   ├── review.js
│   │   └── webhook.js
│   ├── services/
│   │   ├── niaService.js       # Nia indexing & search
│   │   ├── claudeService.js    # Claude API integration
│   │   └── githubService.js    # GitHub API (diff, comments)
│   └── server.js
│
└── README.md
```

---

## Getting Started

### Prerequisites

- Node.js v18+
- A [Nia](https://trynia.ai/) account and API key
- An Anthropic API key (Claude)
- A GitHub OAuth App or Personal Access Token

### 1. Clone the Repository

```bash
git clone https://github.com/abhishekrana43/REVA.git
cd REVA
```

### 2. Configure Environment Variables

**Backend** — create `backend/.env`:

```env
PORT=5000

# GitHub
GITHUB_TOKEN=your_github_token
GITHUB_WEBHOOK_SECRET=your_webhook_secret

# Nia — codebase indexing
NIA_API_KEY=your_nia_api_key

# Claude — AI review
ANTHROPIC_API_KEY=your_anthropic_api_key
```

**Frontend** — create `dashboard/.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:5000
```

### 3. Install Dependencies

```bash
# Frontend
cd dashboard && npm install

# Backend
cd ../backend && npm install
```

### 4. Run the Project

```bash
# Start backend
cd backend && npm run dev

# Start frontend (new terminal)
cd dashboard && npm run dev
```

| Service | URL |
|---|---|
| Frontend | http://localhost:3000 |
| Backend | http://localhost:5000 |

---

## Roadmap

- [x] GitHub PR webhook integration
- [x] Nia codebase indexing
- [x] Claude-powered contextual review
- [x] Auto-post review comment on PR
- [ ] Support for GitLab and Bitbucket
- [ ] Multi-language support (Python, Go, Java)
- [ ] Team collaboration and review history
- [ ] Real-time review suggestions in editor (VS Code extension)
- [ ] Security vulnerability scanning
- [ ] Custom review rules and style guides

---

## Author

**Abhishek Rana**

[![GitHub](https://img.shields.io/badge/GitHub-abhishekrana43-181717?style=flat-square&logo=github)](https://github.com/abhishekrana43)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Abhishek%20Rana-0077B5?style=flat-square&logo=linkedin)](https://www.linkedin.com/in/abhishek-rana-86bb6823b/)

---

<div align="center">
  <sub>Built with Claude AI + Nia — because your reviewer should understand your codebase, not just your diff.</sub>
</div>
