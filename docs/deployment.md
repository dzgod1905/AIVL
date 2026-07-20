# Deployment

The two backend stacks are independent Compose projects, so they can run on the
same machine or on different machines.

## Files

| File | Stack | Services |
|------|-------|----------|
| `docker-compose.yml` (root) | all-in-one, single machine | redis, orchestrator-db, automation-server, ai-multi-agent-api, ai-multi-agent-workers |
| `ai-multi-agent/docker-compose.yml` | ai-multi-agent (machine A) | redis, orchestrator-db, api, workers |
| `automation-server/docker-compose.yml` | automation-server (machine B) | automation-server |

The web app is not containerized here; run it with `npm run dev` / a Node host,
or deploy to Vercel/etc. It only needs to reach the orchestrator.

## Option 1 - single machine (dev / demo)

```bash
cp .env.example .env       # fill REDIS_PASSWORD, ORCH_DB_PASSWORD, ORCH_API_TOKEN,
                           # AUTOMATION_API_TOKEN  (openssl rand -hex 32)
docker compose up --build -d
```

Only the orchestrator API is published (on `API_BIND`, default `127.0.0.1:8001`).
automation-server, redis and orchestrator-db stay on the internal network.

Web:

```bash
cd web
cp .env.example .env       # set DATABASE_URL (Neon), AI_MULTI_AGENT_URL=http://localhost:8001,
                           # ORCH_API_TOKEN = the same token as the backend
npm install && npm run db:push && npm run dev
```

## Option 2 - two machines (the split)

### Machine B - automation-server

```bash
cd automation-server
cp .env.example .env
#   AUTOMATION_API_TOKEN=<shared token>
#   AUTOMATION_BIND=0.0.0.0        # only if machine A reaches it over a network
docker compose up --build -d
```

Prefer a private overlay (Tailscale/WireGuard) over `AUTOMATION_BIND=0.0.0.0` on a
public interface. Keep the token set regardless.

### Machine A - ai-multi-agent

```bash
cd ai-multi-agent
cp .env.example .env
#   REDIS_PASSWORD=<random>
#   ORCH_DB_PASSWORD=<random>
#   ORCH_API_TOKEN=<shared token, matches the web>
#   AUTOMATION_API_TOKEN=<shared token, matches machine B>
#   AUTOMATION_SERVER_URL=http://<machine-B-address>:8002
#   API_BIND=0.0.0.0              # only if the web host reaches it over a network
docker compose up --build -d
```

### Web host (Vercel / another server / another GitHub repo)

Set environment variables:

```
DATABASE_URL      = <this deployment's own Neon URL>
AI_MULTI_AGENT_URL = http://<machine-A-address>:8001
ORCH_API_TOKEN    = <shared token, matches machine A>
```

Each web deployment can use its own GitHub repo and its own Neon database
independently; the only thing it needs to talk to a given backend securely is the
right `AI_MULTI_AGENT_URL` + `ORCH_API_TOKEN` pair. Point those at whichever
backend host you want; change them to move to another host.

## Token wiring summary

```mermaid
flowchart LR
    subgraph WEB["web host"]
      wt["ORCH_API_TOKEN"]
    end
    subgraph MA["machine A - ai-multi-agent"]
      at["ORCH_API_TOKEN"]
      aat["AUTOMATION_API_TOKEN"]
      rp["REDIS_PASSWORD<br/>(internal only)"]
      dp["ORCH_DB_PASSWORD<br/>(internal only)"]
    end
    subgraph MB["machine B - automation-server"]
      bat["AUTOMATION_API_TOKEN"]
    end
    wt ===|"must match"| at
    aat ===|"must match"| bat
```

## Network exposure

- Publish only what a remote party must reach: 8001 (web -> orchestrator) and,
  if split, 8002 (orchestrator -> automation).
- Never publish 6379 (redis) or 5432 (orchestrator-db).
- Put the published ports behind an overlay or firewall; see
  [security.md](security.md).

## Health checks

```bash
curl http://<machine-A>:8001/health     # {"ok":true}
curl http://<machine-B>:8002/health     # {"ok":true}
```

`/health` needs no token. Any other path returns 401/403 without a valid bearer
token once tokens are set.
