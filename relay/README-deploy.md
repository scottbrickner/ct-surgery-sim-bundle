# Cross-device relay — deploy guide

This tiny WebSocket server lets a facilitator on **one device** drive a learner's
simulator on **another device / network**. It's a dumb, secure pipe: clients join a
room by **session code**; only device settings + simulated physiology pass through.
No data is stored, and there's no PHI.

Files: `server.js`, `package.json`.

## Deploy to Render (free, ~3 minutes)

1. Put this `5392-relay` folder in a GitHub repo (its own repo, or a subfolder).
2. Go to **https://render.com** → sign in → **New → Web Service**.
3. Connect the repo. If the relay is in a subfolder, set **Root Directory** to `5392-relay`.
4. Settings: **Environment** = Node, **Build command** = `npm install`, **Start command** = `npm start`. (Render sets `PORT` automatically.)
5. Create the service. When it's live you'll get a URL like `https://xxxx.onrender.com`.
6. Your relay URL for the simulator is the same host with **wss://**:
   `wss://xxxx.onrender.com`

> Render's free tier sleeps after ~15 min idle and takes ~30–60 s to wake on the
> first connection — fine for a class; just connect a minute before you start.

## Alternatives
- **Railway / Fly.io:** same idea — Node web service, `npm start`, use the `wss://` host.
- **Azure App Service (if your org has Azure):** create a Node Web App, deploy this folder, enable **Web sockets = On** in Configuration, use `wss://<app>.azurewebsites.net`.

## Use it (in the simulator)
1. Facilitator opens the simulator, pastes the **wss://** relay URL into the
   "Start remote session" box, clicks **Start**. A 6-character session code appears.
2. Click **Copy learner link** and send it to the learner's device (it already
   contains the relay URL + code + learner view).
3. The learner opens the link → device + monitor only. The dot turns green when linked.
4. Drive physiology from your bottom dock — it appears on the learner's screen live;
   their device actions appear on yours.

## Security note
The relay has no authentication — anyone with the URL **and** the exact session code
could join a room. For a training sim with no PHI that's acceptable; generate a fresh
code per session (the simulator does this automatically). Ask if you want a shared
secret / room password added.
