# AI GitHub Issue Triage Dashboard

Full-stack AI dashboard that imports GitHub issues and generates structured triage analysis using the Gemini API.

The app analyzes real GitHub issues and automatically generates:

* summaries
* priority levels
* issue categories
* effort estimates
* suggested maintainer replies

Built with Next.js, TypeScript, Tailwind CSS, Prisma, Neon PostgreSQL, Gemini API, and Vercel as well.

---

## Core Workflow

```txt id="n29d1a"
GitHub Repository
        ↓
Import Open Issues
        ↓
Store Issues in PostgreSQL
        ↓
Analyze Issues with Gemini API
        ↓
Generate Structured Triage Data
        ↓
Display Results in Dashboard
```

---

## Stack

* Next.js App Router
* TypeScript
* Tailwind CSS
* Prisma ORM
* Neon PostgreSQL
* Google Gemini API
* Vercel

---

## Features

* Imports real GitHub issues from public repositories
* Automatically filters out pull requests
* Stores imported issues and AI analysis in PostgreSQL
* Generates structured AI triage output
* Batch AI analysis workflow for better reliability
* Automatic dashboard analysis pipeline
* Responsive dashboard UI
* Production deployment on Vercel

---

## Engineering Focus

Most of the work in this project ended up being around making the workflow stable end-to-end instead of just building frontend pages.

Some of the main areas I worked through were:

* GitHub API integration
* Prisma + PostgreSQL persistence
* Gemini API workflows
* batch processing for reliability
* API failure handling
* TypeScript validation and null safety
* database consistency problems
* deployment/debugging in production
* responsive dashboard behavior

One of the biggest architecture changes was redesigning the AI analysis flow from one-request-per-issue into batch-based processing.

Originally the app analyzed every issue individually, but that caused Gemini rate limits, networking failures, and unstable dashboard behavior. Moving to batch analysis made the workflow significantly more reliable and reduced API overhead.

---

## Production Problems Solved

Some of the real production/debugging problems I had to solve during development:

* Prisma build failures during Vercel deployment
* invalid DATABASE_URL configuration issues
* TypeScript production build errors
* GitHub API DNS/network failures
* Gemini API 429 rate limits
* route structure/API architecture bugs
* Prisma database connection issues

A lot of the project became less about adding features and more about reducing failure points and making the system reliable.

---

## Future Improvements

Some future improvements I’d like to add:

* authentication
* multi-user support
* repository history
* issue filtering/search
* analytics dashboards
* GitHub OAuth
* background job queues
* real-time analysis progress
* streaming AI responses

---

## Current Status

The app is fully deployed and currently supports:

* GitHub issue importing
* PostgreSQL persistence
* AI-powered issue analysis
* automatic dashboard updates
* stable batch-processing workflows
* production deployment infrastructure
