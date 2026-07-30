# Closing the gap with ChatGPT and Claude — UX improvement guide

Assessed 30 July 2026 against production (`chat.bdren.ai` and `/adminpanel`).

## How this was assessed, and what it does not cover

Both applications were walked through in a browser as the platform superadmin,
and every claim about configuration was checked against the production `.env`,
`librechat.yaml`, the running services, and the database rather than inferred
from the interface.

Two limits worth stating plainly:

- **The admin panel's inner pages were not browsed.** It requires its own login
  and no credentials were entered. Its capabilities below are read from its route
  tree (`users`, `institutions`, `access`, `grants`, `configuration`, `usage`,
  `help`), so comments on the admin experience are narrower than for the chat app.
- **Nothing here was tested as a regular user.** Production has three accounts,
  all administrative or test. Findings about what a student or lecturer sees are
  reasoned from configuration, not observed.

## The core finding

Synapse is not missing the machinery. The chat application already ships agents,
an agent marketplace, skills, a prompt library, memories, projects, bookmarks,
MCP support, temporary chats, file attachment, voice input, artifacts and a code
interpreter. That is a broader feature surface than Claude's web app.

The gap is in three different places:

1. **Three advertised features cannot work**, because the services behind them
   are not running. Users will meet errors, not absences — which is worse.
2. **Everything that should hold content is empty.** One agent, no prompts, no
   skills, no MCP servers. A new user lands on a blank product.
3. **The things ChatGPT users assume are universal are absent** — web search and
   conversation search chief among them.

Fixing (1) is a bug-fix exercise. (2) is content authoring, cheap and
high-impact. (3) is the real engineering work.

---

## Part 1 — Defects to fix before adding anything

### 1.1 Agent marketplace categories are duplicated (visible to every user)

The category filter reads *General, General, Human Resources, Human Resources,
Research & Development, Research & Development…* — every one twice.

Verified: `agentcategories` holds 14 documents for 7 distinct values.

The seeder `ensureDefaultCategories()` is itself idempotent — it reads existing
categories and only creates what is missing. The duplication comes from
**PM2 cluster mode**: production runs two `synapse` workers, both execute
`seedDatabase()` on boot, both read an empty collection, and both insert. Exactly
two copies for two workers.

The same race shows in `accessroles` (18 documents, 17 distinct). `systemgrants`
escaped it because those writes upsert.

Three fixes, best applied together:

- Add unique indexes: `agentcategories.value`, `accessroles.accessRoleId`. This
  makes the race impossible rather than unlikely.
- Guard seeding to a single worker (`process.env.NODE_APP_INSTANCE === '0'`), or
  take a short advisory lock in Mongo.
- Deduplicate the existing rows once, keeping the lowest `_id` of each value.

Until then the duplicates return on every fresh database, so a rebuilt server
reproduces the bug.

### 1.2 `file_search` is offered but has no service behind it

`librechat.yaml` grants agents the `file_search` capability, so the agent builder
offers it and users can switch it on. But no RAG service is running on the app
server — the listening ports are only Mongo, Redis, the app, the admin panel and
nginx — and `RAG_API_URL` is unset.

A user who enables File Search and uploads a document gets a failure. Either run
the RAG API (see 2.3, which you want anyway) or remove the capability from
`librechat.yaml` until you do. Leaving it advertised is the worst of the three
options.

### 1.3 Voice input may be a dead button

The composer shows a microphone. No speech provider is configured — no
`STT_*`, `TTS_*`, Azure Speech, Deepgram or ElevenLabs keys, and no `speech:`
block in `librechat.yaml`.

LibreChat can fall back to the browser's own Web Speech API, so this may work in
Chrome and silently fail elsewhere. Worth confirming in Firefox and Safari; if it
fails, either configure a provider (2.6) or hide the control.

### 1.4 A new chat opens on the Document Assistant

`/c/new` opens addressed to the Document Assistant rather than a general model,
because the last selection persists. This is the same complaint as the earlier
`modelSpecs` problem wearing different clothes: someone who wants to ask a
general question has to notice the model picker and change it first.

Consider defaulting new conversations to a general model and leaving agents as a
deliberate choice.

---

## Part 2 — What most separates this from ChatGPT and Claude

Ordered by how much each closes the perceived gap per unit of work.

### 2.1 Web search — the single biggest absence

Neither the native `webSearch` configuration nor any MCP search server is
present, and `web_search` is not in the agent capability list. Every ChatGPT and
Claude user expects to ask about something recent and get a sourced answer.
Right now Synapse cannot, and will instead answer from training data — which for
a research network is actively harmful, because it looks authoritative.

LibreChat supports this natively. Add to `librechat.yaml`:

```yaml
webSearch:
  serperApiKey: '${SERPER_API_KEY}'
  firecrawlApiKey: '${FIRECRAWL_API_KEY}'
  jinaApiKey: '${JINA_API_KEY}'
```

and add `'web_search'` to `endpoints.agents.capabilities`. Serper is the cheapest
credible search provider; Firecrawl or Jina handles page extraction so the model
quotes real text rather than snippets.

**Effort:** an afternoon, plus provider accounts. **Impact:** the largest of
anything in this document.

### 2.2 Conversation search

`SEARCH=false` in production and Meilisearch is not running, so there is no way
to find an old chat except scrolling. ChatGPT has had this for years and users
lean on it heavily once they have more than twenty conversations.

Run Meilisearch, set `SEARCH=true`, `MEILI_HOST`, and a `MEILI_MASTER_KEY`. Note
the app already logs `mongoMeili` connection errors, so the indexing plugin is
active and merely has nowhere to write — the wiring exists.

**Effort:** half a day including a container and a backup consideration.

### 2.3 Ask questions about an uploaded document

This is the request users will make most after "write me a document", and it is
the other half of 1.2. Running the RAG API turns file attachment from
"the model sees the text if it fits" into real retrieval over long PDFs — which
for a network serving universities means thesis chapters, standards documents and
research papers.

Run `librechat-rag-api`, set `RAG_API_URL`, and keep `file_search` enabled. Pair
it with an embedding model; the OpenAI key already present is sufficient.

### 2.4 Starter content — the cheapest win available

The marketplace has one agent. The prompt library says "No prompts yet". Skills
says "No skills yet". A first-time user has nothing to click and no idea what the
product is for.

ChatGPT's GPT store and Claude's project templates do most of the work of
teaching users what is possible. Populating this costs authoring time, not
engineering time, and is the fastest visible improvement in the whole document.
Concrete proposals in Part 3.

### 2.5 Conversation starters on the empty state

The Document Assistant's `conversation_starters` array is empty, so its landing
screen is a description and a blank box. Both ChatGPT and Claude offer four
clickable openers. Every agent should ship three or four.

This is a database field. No code, no deploy — minutes per agent.

### 2.6 Voice

If 1.3 shows the microphone does not work outside Chrome, configure a real
provider. Beyond fixing the button, text-to-speech read-back is a genuine
accessibility feature for a university audience, and cheap to enable once a
provider exists.

### 2.7 Shareable conversation links

A public share link is how people show colleagues what the assistant produced,
and it is a strong organic-growth mechanism inside an institution. LibreChat
supports shared links and the permission model already has
`MANAGE_SHARED_LINKS` and `READ_SHARED_LINKS` capabilities defined — confirm
whether the feature is surfaced in the interface, and consider whether sharing
should be restricted to within a tenant.

### 2.8 Side-by-side model comparison

`interface.multiConvo` is `false`. With five providers configured, letting users
compare two models on the same prompt is a differentiator neither ChatGPT nor
Claude offers. Worth considering once the basics are in place — it is a one-line
config change, but it does complicate the interface for novice users, which is
why it is here rather than higher.

---

## Part 3 — Agents, skills and prompts worth building

Synapse serves a research and education network. That is a much narrower and more
tractable audience than ChatGPT's, and the agents should reflect it. Generic
"marketing copy" agents would waste the advantage.

### 3.1 Agents

Ordered by expected use. All assume `execute_code` where files are produced, and
`web_search` and `file_search` once those exist.

| Agent | What it does | Needs |
|---|---|---|
| **Document Assistant** *(exists)* | Word, Excel, PowerPoint, PDF generation | `execute_code` |
| **Research Paper Assistant** | Literature summaries, citation formatting in APA/IEEE/Chicago, reference list cleanup | `web_search`, `file_search` |
| **Data Analyst** | Upload a CSV or Excel file, get analysis and charts back as real files | `execute_code`, `file_search` |
| **Thesis & Manuscript Reviewer** | Structural and clarity feedback against a supervisor's rubric — explicitly *not* plagiarism detection | `file_search` |
| **Course Designer** | Syllabi, lesson plans, rubrics, question banks with answer keys | `execute_code` |
| **Grant & Proposal Writer** | Funding proposals, budget tables, work plans against a call document | `file_search`, `execute_code` |
| **Bangla ⇄ English Academic Editor** | Translation and register-correct academic Bangla — a capability no international product does well | — |
| **Slide Deck Builder** | Turn an outline or paper into a `.pptx` | `execute_code` |
| **Campus IT Helpdesk** | Answers grounded in BdREN's own network and service documentation | `file_search` |
| **Meeting Minutes** | Transcript or notes into structured minutes with action items | — |

The Bangla editor deserves emphasis. It is the one agent on this list that a
Bangladeshi university cannot get from ChatGPT at comparable quality, and it is
the strongest argument for Synapse existing at all.

### 3.2 Skills

Skills bundle instructions and reference files, so they are the right home for
things every agent should apply consistently:

- **Citation styles** — APA 7, IEEE, Chicago rules as reference files, so
  formatting is consistent rather than recalled.
- **University document templates** — thesis formatting, exam paper layout,
  official letterhead. These make generated `.docx` files immediately usable
  rather than needing reformatting.
- **BdREN report and presentation styling** — brand fonts, colours, cover pages.
- **Academic Bangla style guide** — terminology and register conventions.
- **Data presentation conventions** — chart styling, table formatting, units.

### 3.3 Prompt library

Group starter prompts by who is asking, and use the categories that already
exist. Six to ten per group is enough:

- **Students** — summarise this paper, explain this concept simply, check my
  argument, generate practice questions.
- **Faculty** — draft a rubric, build a lesson plan, write exam questions at
  three difficulty levels, give feedback on a draft.
- **Researchers** — literature gap analysis, methodology critique, reformat
  references, draft an abstract to a word limit.
- **Administrative staff** — meeting minutes, official correspondence, policy
  summaries, budget tables.

### 3.4 MCP servers

The MCP panel is empty. For this audience the highest-value connectors are
academic rather than productivity:

- **arXiv / Semantic Scholar / Crossref** — paper lookup and metadata. Directly
  useful to the Research Paper Assistant.
- **PubMed** — for any medical faculty on the network.
- A search provider, if you prefer MCP over the native `webSearch` in 2.1.

Treat every MCP server as untrusted input: a connector returns text that the
model will act on, so scope what tools it exposes.

---

## Part 4 — Admin panel

Assessed from its route tree only, per the caveat at the top. Existing surfaces:
dashboard, users, institutions, access, grants, configuration, usage, help.

That covers *governance* well — institutions, roles, capabilities, usage quotas.
What it appears to lack is *content management*, and that gap matches a
frustration already reported: the admin panel exposes model configuration but
not the things an operator most wants to change.

Worth adding, roughly in order:

1. **Agent management** — create, edit and publish agents to the marketplace from
   the console. Today this requires the chat UI as a superadmin, or a seed
   script. It is the single biggest omission, because agents are the product's
   main surface and publishing them is an administrative act.
2. **Prompt library management** — curate the starter prompts from 3.3 centrally,
   rather than authoring them as one user and sharing.
3. **Skills management** — same argument.
4. **Announcements / banners** — the schema already exists (`banner`), so this may
   only need a screen. Useful for maintenance windows and onboarding notices.
5. **MCP server registration** — so connectors are an operator decision, not a
   per-user one.

Two smaller notes on the login page itself: there is no password-reset path and
no SSO button, which brings us to the next point.

---

## Part 5 — Institutional identity

`ALLOW_REGISTRATION=false` and `ALLOW_SOCIAL_LOGIN=false`, and while every
`OPENID_*` and `LDAP_*` variable is declared, all are empty. Every account is
therefore created by hand or by invitation.

For a network whose members are universities, this is the scaling constraint.
Onboarding a university currently means provisioning its people individually.
With institutional SSO — OIDC against each university's identity provider, or
eduGAIN federation, which is exactly what a national research and education
network exists to broker — a university's staff and students sign in with
credentials they already hold, and the tenant mapping happens at login.

This is the difference between onboarding a university in a day and onboarding it
in a term. It is more work than anything else in this document and probably worth
more than all of it.

---

## Suggested sequencing

**First — stop shipping broken affordances.** Deduplicate the categories and fix
the seeding race (1.1). Decide on `file_search`: run the RAG API or withdraw the
capability (1.2). Check the microphone across browsers (1.3).

**Second — populate the product.** Conversation starters on the Document
Assistant, three or four more agents from 3.1, a first pass at the prompt library,
two or three skills. No deploys needed for most of it; this is the cheapest
visible progress available and it can happen in parallel with the engineering
below.

**Third — the two features users will ask for by name.** Web search (2.1) and
conversation search (2.2).

**Fourth — document intelligence.** The RAG API (2.3), which makes the Research
Paper Assistant and Thesis Reviewer genuinely useful rather than nominal.

**Fifth — institutional SSO** (Part 5), and the admin content-management screens
(Part 4) that let someone other than a superadmin run the platform.

Deliberately left late: multi-conversation comparison, voice, and share links.
All are worth doing and none of them changes whether a user's first hour is
successful.

---

## Appendix — configuration reference

Additions to `librechat.yaml`, all subject to the usual workflow: edit locally,
commit, push, pull on the host.

```yaml
endpoints:
  agents:
    capabilities:
      - 'execute_code'
      - 'file_search'      # only once the RAG API runs — see 1.2
      - 'web_search'       # new, see 2.1
      - 'artifacts'
      - 'skills'
      - 'tools'
      - 'ocr'
      - 'context'

webSearch:
  serperApiKey: '${SERPER_API_KEY}'
  firecrawlApiKey: '${FIRECRAWL_API_KEY}'
  jinaApiKey: '${JINA_API_KEY}'
```

New `.env` keys on the host, documented by name in
[`production-deployment-bdren-ai.md`](production-deployment-bdren-ai.md) §7:

| Key | For |
|---|---|
| `SERPER_API_KEY` | web search |
| `FIRECRAWL_API_KEY` or `JINA_API_KEY` | page extraction for web search |
| `RAG_API_URL` | document retrieval |
| `SEARCH`, `MEILI_HOST`, `MEILI_MASTER_KEY` | conversation search |
| `OPENID_*` | institutional SSO |

Agents, prompts, skills and MCP registrations are **database state, not
configuration** — they do not travel with a `git pull` and must be seeded. Follow
the pattern in [`../config/seed-document-agent.js`](../config/seed-document-agent.js),
which also documents two traps worth knowing before writing another seeder: the
access-role lookup is hidden by tenant context, and an agent created without a
tenant is invisible to that tenant's own members.
