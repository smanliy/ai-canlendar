# Calendar Bridge

This OpenClaw tool plugin forwards chat actions into the calendar backend.

## What it does

- receives a request from OpenClaw
- forwards it to the calendar project
- leaves the actual scheduling logic inside the existing project code

## Where to point it

Set `baseUrl` to the calendar backend, for example `http://127.0.0.1:3000`.

If you want the backend to require a shared secret, set `OPENCLAW_BRIDGE_TOKEN` in the calendar BFF and `bridgeToken` in the plugin config to the same value.

## Project-local config

This folder includes `openclaw.project.json`, which is meant to be used only for this bridge.

Run `npm run openclaw:local` from this folder to start OpenClaw with the project-local config.

## Why it exists

The plugin is the thin entry layer. The calendar project still owns:

- main loop
- compression
- schedule generation
- conflict handling
- persistence
