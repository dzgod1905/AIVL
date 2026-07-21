# AIVL docs

Reference docs for the workflow builder + multi-agent backend.

| Doc | What it covers |
|-----|----------------|
| [overview.md](overview.md) | Project overview (Vietnamese): architecture, tech stack, directory layout, how to run, and env vars. Start here. |
| [communication.md](communication.md) | How the pieces talk: components, ports, endpoints, and the bearer-token auth between them. |
| [database.md](database.md) | The two separate databases (web Neon vs orchestrator-db), their tables, what is stored where, and how to inspect them. |
| [flow.md](flow.md) | A single workflow run end to end: from "Start" in the UI to persisted step output. |
| [security.md](security.md) | Threat model, what is enforced in code, and what must be configured per deployment. |
| [deployment.md](deployment.md) | Running the two backend stacks on different machines, with the web app on a third host. |
| [adding-a-tool.md](adding-a-tool.md) | Add a new tool (unit) or category to the ai-multi-agent node registry. The one-file-plus-one-line flow. |

## The pieces at a glance

- **web** (Next.js): the builder UI + server-side API routes. Talks only to the orchestrator.
- **ai-multi-agent** (one deployable stack): the orchestrator API, the Celery workers, Redis (broker), and orchestrator-db (Postgres).
- **automation-server** (a second deployable stack): the automation-tool catalog + invoke surface. Reached by the orchestrator over the network.

The two backend stacks are independent Docker Compose projects so they can live on
different machines. See [deployment.md](deployment.md).
