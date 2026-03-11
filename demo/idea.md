# AI Survival Guide for Early-Career Engineers

A practical, no-fluff guide that shows fresh graduates and junior engineers (0-5 years) exactly what AI skills to learn, in what order, and why, so they can future-proof their careers starting today.

## The Problem

New engineers are overwhelmed. Everyone says "learn AI" but nobody says what specifically, in what order, or what actually gets you hired versus what is just hype. The advice online is either too academic, too advanced, or already outdated.

## What It Does

- **Skills map**: A visual, interactive dependency graph showing which AI skills matter now, which are emerging, and which are overhyped, with real demand data from job postings
- **Learning paths**: Step-by-step paths from "I know basic programming" to "I can build AI-powered products", organized by current role (frontend, backend, mobile, data, devops)
- **Weekly pulse**: What changed this week in AI that actually affects your career. No noise, just signal
- **Toolbox**: Curated list of free tools, courses, and projects ranked by career ROI, not marketing spend
- **Reality check**: Honest take on each skill: time to learn, salary impact, demand trend, and whether AI will automate it next

## Audience

- Fresh CS/IT graduates looking for their first job
- Junior engineers (1-5 years) planning their next career move
- Self-taught developers wanting to add AI skills
- NOT for researchers, PhDs, or senior architects

## Tech

- Static HTML/CSS/JS files only
- No server runtime, no build step, no frameworks
- Works on slow connections and old devices
- All content baked into HTML at generation time; JS enhances but is not required
- Seed data on day one so it is useful immediately
- Linkback to the product page /product/ for users to explore how this automated platform is being generated.

## Deploy

- Start by creating an index.html with the main content and structure in the project root. This is your first task. Then keep adding the things you want to add
- Output all built files into the project root directly
- Nginx is already configured to serve project root as the website root at `/`
- Just create the files in project root and they are live immediately
- The directory must contain at minimum an `index.html` and all the other files should link to this `index.html` as the main entry point.

## Non-Goals

- Not a course platform, job board, social network, or AI tool
- No user accounts or login; cookie-based preferences only
- No Node.js server, no database, no backend processes
