# Contributing

Two ways to get a mod listed.

## Let the scanner find it

The nightly scan searches GitHub for repositories that mention `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` or ship a `hooks/hooks.json` with a `modules` key. Public repositories matching those patterns become candidates once GitHub indexes them and discovery succeeds. Results appear after the generated update pull request is merged. Known candidates are retained even when a later search omits them.

## Open a pull request

1. Add your `owner/repo` to `data/seeds.txt`, one per line.
   If you moved a mod to a new repo and the table lists both, add the pair to `data/duplicates.txt` so the old copy stops counting.
   A repo that repackages other authors' mods as a catalogue goes in `data/catalogs.txt`: it is named once with its count rather than listed per copy.
2. If you want a curated entry (not only a row in the generated table), add one line under the matching section of `README.md` in this exact shape:

   `- [name](https://github.com/owner/repo) - What it does, one sentence, ending with a period.`

3. Run `npm test` and `npm run lint`. Both must pass.

PR checks scan submitted seeds alongside the committed candidates. A newly added seed must clone successfully and contain mod plugins that validate; warnings are allowed. Global search runs nightly, not in PR checks.

Missing plugins stay listed as unverified during daily scans. Weekly retirement proposals require a fresh successful checkout and record the revision used to establish that a hook module is gone. Clone failures and failed validation are not removal evidence. Curated descriptions need a separate human review when an upstream project changes.

Do not edit anything between `<!-- scan:start -->` and `<!-- scan:end -->`, `<!-- builtin:start -->` and `<!-- builtin:end -->`, or `<!-- stats:start -->` and `<!-- stats:end -->`. The scanner regenerates those blocks and would overwrite your change.

## What gets a curated entry

The generated table lists every mod the scanner can validate. The curated sections above it list mods that a person would install: a README that explains what it does, an install path that works, and a footprint that matches the description. A game that hooks every tool call to feed a pet is fine. A game that calls `$.http.fetch` without saying why is not.

## Badges

Every scanned mod gets two badges you can paste into your README:

```markdown
![reach](https://raw.githubusercontent.com/karanb192/awesome-claude-code-mods/main/badges/OWNER--REPO--NAME-reach.svg)
![validates](https://raw.githubusercontent.com/karanb192/awesome-claude-code-mods/main/badges/OWNER--REPO--NAME-validates.svg)
```

Replace `OWNER--REPO--NAME` with your GitHub owner, repo and the `name` from your `plugin.json`, joined by double dashes. The exact file names are in the `badges/` folder.

## Disputing a footprint

The footprint is whatever `claude plugin validate` printed for your plugin on the version in the table. If it looks wrong, open an issue with the validator's output from your machine. If the validator and the scanner disagree, the scanner has a bug and it gets fixed.

## Running the tools

```sh
npm test            # parser and grader tests
npx playwright install chromium  # once, for browser checks
npm run test:render  # generated statuses, badges and responsive layout
npm run lint        # awesome-lint on README.md
npm run discover    # refresh data/repos.txt (needs gh logged in)
npm run scan        # clone, validate, write data/mods.json (needs the claude CLI)
npm run scan -- --retire  # weekly removal audit; writes revision evidence for review
npm run render      # regenerate README blocks, badges/, docs/ and docs/badges/
node tools/changed.mjs   # exit 0 if the scan differs from HEAD on anything but stars and timestamps
```

### Website

The landing page is generated from `data/mods.json`. Edit `tools/site.mjs`, `tools/site.css` or `tools/site-client.js`, then run `npm run render`. Do not edit `docs/index.html` directly.

The daily scan runs this renderer and includes the updated README, landing page and public JSON in the same automated scan pull request. Merging that pull request publishes the collection through GitHub Pages. No separate website edit or pull request is needed for new scanned mods.

Search, filtering and sorting run in the browser; the full collection remains readable without JavaScript. Search stays above the results while browsing. The page follows the system's light or dark appearance through `prefers-color-scheme`.

Run `npm run test:render` to check the generated page and its browser interactions. Preview the `docs/` folder with a local static server. GitHub Pages serves this folder, with the domain in `docs/CNAME`.

The social sharing graphic comes from `tools/social.html`. Run `npm run render:social` after editing it. This is a designed graphic, not a screenshot of a running mod.
