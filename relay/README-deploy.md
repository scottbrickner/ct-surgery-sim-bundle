# Relay deploy guide

This tiny WebSocket server (`server.js`, one dependency — `ws`) lets the
facilitator console, IntelliVue, HemoSphere Alta, and the pacemaker sync
across **separate devices** (a second laptop, an iPad), not just windows on
one machine. It's a dumb, secure pipe: clients join a room by **session
code**; only device settings + simulated physiology pass through. No PHI,
nothing is stored.

Same-machine multi-window sync (BroadcastChannel) already works with **zero
deployment** — you only need this if the class spans more than one device.

## Deploy to Azure App Service (primary target — see CLAUDE.md §"Resolved decisions")

Chosen over Render/Railway/Fly because Keck is already a Microsoft
365/Teams/SharePoint environment — one ecosystem, familiar IT/procurement
path. The relay code needs **zero changes** for this: `server.js` already
reads `process.env.PORT`, which Azure sets automatically.

1. In the [Azure Portal](https://portal.azure.com), create a **Web App**:
   - **Publish**: Code
   - **Runtime stack**: Node 18 LTS or newer
   - **Region**: whatever's closest/standard for Keck's tenant
   - **Pricing plan**: Basic (B1) is plenty — this is a lightweight relay, not a real workload
2. Deploy this `relay/` folder's contents to the Web App. Easiest paths:
   - **GitHub Actions** (recommended if IT is comfortable with it): in the Azure Portal, Web App → **Deployment Center** → connect this GitHub repo, set **Startup command** blank (Azure auto-runs `npm install` + `npm start` when it finds `package.json`), and set the app's **Root/Working directory** to `relay` (a monorepo deploy — the rest of this repo, the static device files, isn't part of this Web App).
   - **Zip deploy** (no GitHub integration needed): `cd relay && zip -r relay.zip . -x "node_modules/*"`, then Azure Portal → Web App → **Advanced Tools (Kudu)** → **Zip Push Deploy**, or `az webapp deploy --resource-group <rg> --name <app> --src-path relay.zip`.
3. In the Web App's **Configuration** → **General settings**, turn **Web sockets** to **On**. This is the one setting that's easy to miss and the relay won't work without it.
4. Your relay URL is `wss://<app-name>.azurewebsites.net`.
5. Paste that into the facilitator console's "Relay URL" field (or any device's own Cross-Device Sync section), click **Connect Relay**, then **Copy Learner Link** to send a device its join link.

## Local dev / testing (no Azure needed)

```bash
cd relay
npm install
PORT=8765 node server.js
```

Point any device at `ws://localhost:8765` — this is exactly the setup used
to verify the relay transport during Phase 3 (a plain Node WebSocket client
joined the same room as a browser tab and received a distinctive test value
purely over that connection).

## Alternatives to Azure (fine for a quick demo, not the classroom target)

- **Render / Railway / Fly.io**: same idea — Node web service, `npm start`, use the `wss://` host. Render's free tier sleeps after ~15 min idle (~30–60s wake time on first connection) — connect a minute before class starts if you use it.

## Security note

The relay has no authentication — anyone with the URL **and** the exact
session code could join a room. For a training sim with no PHI that's
acceptable; the console generates a fresh code per session. Ask if you want
a shared secret / room password added.
