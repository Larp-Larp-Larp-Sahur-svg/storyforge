# 📖→🎮 StoryForge

Feed it a novel. **One AI scan** audits the whole text and tells you exactly what it found (or missed). Then a **pure-math engine** turns it into an infinite, stat-driven, text-based interactive story game — with HP, XP, levels, attributes, dice checks, inventory, bonds, and reproducible runs.

Offline-first **PWA** (installable, works without network once loaded). Bring your own **free** AI key.

---

## How it works

1. **Source** — paste/load your novel `.txt`.
2. **One-time scan** — the AI reads the entire text (auto-chunked for long novels) and extracts a *Story Bible*: protagonist + stat block, characters, locations, factions, items, themes, key events, opening scene. It returns a **coverage %** and a found/missing audit so you know it actually worked.
3. **Forge & play** — each turn the AI narrates a new branch grounded in the bible and offers choices. **The AI never decides success.** The math engine (`js/engine.js`) rolls a seeded `d20 + ability mod + skill` vs a difficulty class. Same seed + same choices = identical run, every time.
4. It's built to run **long** — persistent autosave, export/import saves, level curve `50·L² + 50·L`. Play for hours.

## Free AI options (pick one in the app)

| Provider | Model | Cost | Key |
|---|---|---|---|
| **GLM-4-Flash** (Zhipu / Z.ai) | `glm-4-flash` | **Free** | open.bigmodel.cn or z.ai |
| OpenRouter | `deepseek/...:free`, `llama-3.3-70b...:free` | Free tiers | openrouter.ai/keys |
| Groq | `llama-3.3-70b-versatile` | Free tier | console.groq.com/keys |
| **Ollama** (local) | `llama3.1` | Free + 100% offline | ollama.com |
| **Offline Demo** | template-engine | Free, no key | built in |

> **Recommended free pick:** **GLM-4-Flash** — genuinely free, fast, and great at structured JSON, which is exactly what the scan needs. The whole app is OpenAI-compatible, so any of the above (or a custom endpoint) just works.

Your key is stored **only in your browser** (`localStorage`) and is sent **only** to the endpoint you choose. The service worker never caches API calls.

## Run it locally (the all-in-one command)

```bash
./forge.sh          # scans this dir, unzips any bundle, serves http://localhost:8787
```

Other modes:

```bash
./forge.sh run                     # just serve locally
./forge.sh github <git-remote-url> # init + commit + push (no --force, safe)
./forge.sh deploy storyforge       # deploy to Cloudflare Pages via Wrangler
./forge.sh all <repo> storyforge   # scan -> unzip -> push -> deploy, in order
```

No build step — it's static files. `npm start` works too.

## Deploy to Cloudflare Pages

```bash
npx wrangler pages deploy . --project-name storyforge
```

(Wrangler prompts a browser login the first time. `wrangler.toml` is included.)

## File map

```
index.html              UI shell (3 screens: Setup · Audit · Play)
styles.css              dark "arcane" theme, responsive
manifest.webmanifest    PWA manifest
sw.js                   offline service worker (shell cached, API never cached)
js/engine.js            PURE MATH: PRNG, dice, checks, odds, XP, deltas
js/bible.js             Story Bible schema, audit, normalizer
js/ai.js                model adapter: scanNovel(), narrate(), offline fallback
js/config.js            provider presets (GLM, OpenRouter, Groq, Ollama, custom)
js/app.js               controller wiring the screens + game loop
assets/sample-novel.txt "The Lantern of Ash" demo source
forge.sh                all-in-one: scan/unzip/run/github/deploy
wrangler.toml           Cloudflare Pages config
```

## Why "pure maths"?

Mechanics are deterministic and inspectable. Every choice shows its real **success %** (computed from your stats vs the DC). Resolution is `engine.check()` seeded by `(runSeed, turn, choiceId)` — reproducible, debuggable, and fair. The AI is the storyteller; the math is the referee.

MIT licensed. Built to be forked.
