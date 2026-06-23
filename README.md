# Auritech Mesh

An aura-scanner dating app. Upload a selfie, get an AI "aura reading" (personality,
temperament, aura colors, energy), and match with people by **auric resonance**.

> The aura reading is playful self-expression / entertainment, not a clinical or
> psychological assessment.

## Run locally

```bash
cd auritech-mesh-app
npm install
npm start
# open http://localhost:3000
```

It runs with **no API key** out of the box (a built-in mock reader generates readings).
To use real Claude vision readings, set `ANTHROPIC_API_KEY` (see `.env.example`).

## Deploy on Render

This repo includes `render.yaml`. On Render: New → Blueprint → connect this repo.
Then set the `ANTHROPIC_API_KEY` environment variable in the service settings
(`JWT_SECRET` is auto-generated). Free plan works.

Note: the JSON data store lives on the local disk and resets on redeploy. For
persistence, add a Render Disk mounted at `DATA_DIR` (e.g. `/data`).

## Stack
- Node + Express (single web service, serves API + static UI)
- File-backed JSON store (no native deps)
- Claude vision for the aura reading (via REST), mock fallback offline
- Vanilla JS single-page front-end
