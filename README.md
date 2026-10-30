# token-usage-ribbon

A Claude Code mod that adds one slim row above your prompt, drawn in Claude Code's own colours:

```
Usage   5H ●●●●●●●●●○ 88% left · 1h 6m   7D ●●●●●●●●●○ 92% left · 6d 5h        ● Cache Warm 60m left  Show
```

- **5H and 7D**: how much of your 5-hour and 7-day usage is **left**, and when each resets. Under 15% adds a red **Low**.
- **Cache Warm / Cache Cold**: whether the prompt cache is still live (one hour after your last message). Warm shows the minutes left; cold shows how long you've been idle and what your next message costs to re-cache.
- **Show / Hide** opens a card with the cache details and the next-message cost on each model.

It costs nothing to run: it reads Claude Code's own numbers and draws them. It never calls a model.

## Design

- **Native look.** Every colour is a Claude Code theme key (`claude`, `warning`, `success`, `suggestion`, `error`, `inactive`, `subtle`), so the band follows your light or dark theme. No custom background, no embedded font on the row.
- **Always one row.** The band measures what it needs. As the window narrows it trims, in order: shorter dot bars and cache wording, the word "left", the dots, then reset times and the Show button. The labels (Usage, 5H, 7D, Cache Warm/Cold), the percentages and a cold cache's price always stay.
- **Even spacing.** Three cells between every group; usage on the left, the cache and its button together on the right.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install token-usage-ribbon --marketplace imetaroy/token-usage-ribbon
```

Type `y` to add the marketplace, then pick the **user** scope. Or from a shell:

```
claude plugin install token-usage-ribbon --marketplace imetaroy/token-usage-ribbon
```

On older Claude Code builds without `--marketplace`, use two steps:

```
claude plugin marketplace add imetaroy/token-usage-ribbon
claude plugin install token-usage-ribbon@imetaroy
```

Start a new session to see the band. If you also have the original ribbon installed, disable it so you don't get two bands.

## Remove

```
claude plugin uninstall token-usage-ribbon@imetaroy
```

## Good to know

- **Prices are estimates.** They come from the `MODELS` table in `hooks/cache-art.ts`, not your bill.
- **Subagents don't count.** Only your main chat resets the cache clock.
- **It survives restarts.** The cache timing is saved per session (in the plugin's own store), so the cache status comes back after an idle session is suspended or the app relaunches. Saved timings older than 7 days are cleared. If Claude Code can't say how big the context is, the band still shows Cache Warm or Cache Cold, just without a price.
- **The cache card** (behind Show) is a drawing, so it carries its own embedded font (Outfit) rather than Claude Code's.

## Develop

```
claude --plugin-dir ./token-usage-ribbon
claude plugin test ./token-usage-ribbon
```

`plugin test` needs a recent Claude Code build.

```
.claude-plugin/   plugin.json, marketplace.json
hooks/            register.tsx (the band), cache-art.ts (cache card, prices), font.ts
types/            the shape of what the band remembers
tests/            10 tests: one-row layout at every width, warm and cold, terminal, cleared sessions, restarts
```

## Credits

A restyled fork of [ribbon](https://github.com/robonuggets/ribbon) by Jay E, under the MIT License (see [LICENSE](LICENSE)). The embedded font is [Outfit](https://github.com/Outfitio/Outfit-Fonts), under the SIL Open Font License 1.1.
