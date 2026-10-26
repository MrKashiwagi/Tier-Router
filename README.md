<img src=".claude-plugin/icon.png" alt="" width="96" align="right">

# Tier Router

A Claude Code mod that lets Claude hand easy work to cheap, fast models and hard work to strong ones, automatically. Every time Claude delegates a task to a subagent, Tier Router rates how difficult the task is and picks the subagent's model **and** effort level: trivial lookups go to Haiku at low effort, ordinary work to Sonnet, and hard or high-stakes work to Opus at high effort or above. It keeps adjusting as it goes: it raises a struggling subagent's effort mid-task, escalates a retried task to a stronger model, and learns which kinds of task need more (or less) power. It also keeps an honest account of what actually ran and roughly what it cost.

Created by Ibrahim ([MrKashiwagi](https://github.com/MrKashiwagi)), built with Claude. MIT license.

## Install

Needs Claude Code 2.1.287 or later; built and tested on 2.1.311. Check with `claude --version`, and run `claude update` if needed.

In a Claude Code session in your terminal:

```
/plugin install tier-router --marketplace MrKashiwagi/tier-router
```

Answer `y` to add the marketplace, press Enter to install it for your user (every project), then keep or change the settings. It starts working right away.

From a shell (the settings start at their defaults):

```
claude plugin install tier-router --marketplace MrKashiwagi/tier-router
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `MrKashiwagi/tier-router`, then **Add plugin**.

To update later, run `claude plugin update tier-router` and restart Claude Code. To try it for one session without installing, clone this repository and start Claude Code with `claude --plugin-dir <folder>`.

## How it routes

Each delegated task gets a difficulty from 0 to 4. Keyword rules decide clear cases instantly; when they are unsure, one small Haiku request rates the task (once per distinct task). The difficulty, plus anything learned for that kind of task, picks a rung on the active profile's ladder:

| Difficulty | frugal | **balanced** (default) | quality |
| --- | --- | --- | --- |
| 0 trivial (lookups, lists, renames) | Haiku · low | **Haiku · low** | Haiku · medium |
| 1 easy (small, fully specified changes) | Haiku · low | **Haiku · medium** | Sonnet · low |
| 2 moderate (features, clear bugs, tests) | Haiku · high | **Sonnet · medium** | Sonnet · high |
| 3 hard (subtle bugs, design, security) | Sonnet · high | **Opus · high** | Opus · xhigh |
| 4 very hard (concurrency, migrations) | Opus · high | **Opus · xhigh** | Opus · max |
| retry above 4 | Opus · xhigh | **Opus · max** | Opus · max |

Explore subagents follow the thoroughness Claude asks for (quick, medium, very thorough → the trivial, easy and moderate rungs). Plan subagents never go below moderate.

## How it adjusts itself

- **Effort rises while a subagent struggles.** After two tool errors in a row, four in total, or an unusually long run, the subagent's next request goes out one effort level higher, at most twice per task and never above an effort cap Claude Code applies. On Opus, Sonnet and Haiku 5.5 with a Claude subscription or an API key, changing effort keeps the subagent's prompt cache, so a raise doesn't throw away the context it has built up.
- **Retries escalate.** Each routed subagent ends its report with a line such as `ROUTER: stuck hard`. When a report says partial or stuck and Claude re-dispatches the task, the retry climbs the ladder; a stuck run goes straight to a stronger model, since more effort rarely unsticks a weaker one. Repeating work that came back done (re-running the tests after a fix, say) is a fresh task, not a failure.
- **It learns,** per kind of task (search, tests, debugging, docs and so on), from four signals: a run that ended partial or stuck (a miss), a run that got there but found it hard or needed two effort raises (strain), Claude re-sending finished work to a stronger model (a miss, judged by Claude rather than the subagent), and a strong model reporting the work was easy (too much model). What it learns is kept across sessions; `/tier-router reset` clears it.

Claude is told routing is on (a short section in its system prompt), so it delegates self-contained work more readily and writes prompts the router can judge.

## What it shows you, and how accurate it is

- **Status line:** tasks routed, the estimated cost, and the latest routing, for example `router: 7 tasks · ≈$0.04 (opus ≈$0.61) · last haiku/low`.
- **`/tier-router`:** the full report, written to the transcript. Claude never reads transcript notices, so checking the report costs no tokens; Claude gets a one-line summary. `/tier-router share` hands Claude the full report instead, for when you want it analyzed.
- `/tasks` also shows each running subagent's model and effort.

How the figures are made:

- **Model and effort are what actually ran.** The model comes from Claude Code's own report on each request, and the effort from the first request's settings. The report flags it when they differ from what was asked: `haiku→sonnet` when Claude Code fell back to another model, `(capped)` when an effort cap held a run lower.
- **Costs are priced request by request** at Anthropic's API list prices (October 2026), including Haiku 5.5's higher rate for any request whose prompt passes 100K tokens. Requests the mod could not see one by one are priced from the run's total.
- **The comparison** prices the same tokens on the model each subagent would have used without the router: its parent's, normally your main model. A different model would not use exactly the same tokens, so read it as a guide, not a measurement.
- **The router's own overhead** (its Haiku ratings) is counted separately. Claude Code's cost totals leave such requests out, so this is the only place they appear.
- **On a subscription** you pay no per-token price, so the dollars show relative usage. `/usage` in Claude Code has the authoritative totals.
- **Done, partial and stuck** come from each subagent grading itself, which tends to be optimistic. That is why the learning also weighs effort raises and Claude's own re-dispatches.

## Commands

- `/tier-router` shows the report; `/tier-router share` gives it to Claude.
- `/tier-router export` copies an anonymized summary of results, to share if you choose (see below).
- `/tier-router off` and `/tier-router on` switch routing for the session.
- `/tier-router mode frugal|balanced|quality` changes the profile for the session.
- `/tier-router reset` forgets what it learned.

## Settings

Change these with `/plugin configure tier-router@tier-router`, or in `/config`, where each appears as a Tier Router row.

| Setting | Default | What it does |
| --- | --- | --- |
| Routing profile | balanced | frugal, balanced or quality (see the table above) |
| Strongest model allowed | opus | Cap on any subagent's model; capped tasks get one more effort level instead |
| Model for the very hardest tasks | opus | Set to fable only if your plan includes Claude Fable |
| Ask Haiku to rate unclear tasks | on | Off means keyword rules only, with no extra requests |
| Raise effort when a subagent struggles | on | The mid-task effort raises described above |
| Learn from results | on | The per-kind-of-task adjustments described above |
| Encourage Claude to delegate | on | Off keeps the routing note but drops the encouragement |
| Keep a model or effort Claude was asked to use | on | When an Agent call already names a model or effort, that part is kept |
| Extra agent types to route | (none) | Comma-separated names of your own subagent types to route too |

## Sharing your results (optional)

Tier Router learns from your results on your own machine. You can help tune its defaults for everyone by sharing what it has seen:

1. Run `/tier-router export`. It puts one line of JSON on your clipboard and shows it in the transcript.
2. Read it over, then paste it into a [Share routing data](https://github.com/MrKashiwagi/tier-router/issues/new?template=share-routing-data.yml) issue.

For each kind of task, the export lists how its difficulty was judged (`rules`, `classifier` or `retry`), the level it got, the model and effort it started on, and how those runs ended: `ok`, `miss` (partial or stuck), `over` (a strong model found it easy) or `strain` (finished, but hard). It also lists the adjustments the router has learned. It never holds task text, file names, times or costs, and the mod sends nothing anywhere by itself. Shared results are pooled to tune the default ladders and keyword rules in later versions.

## What it costs to run

- About 230 tokens in Claude's system prompt, cached after the first request.
- About 85 tokens added to each routed subagent's prompt, which also asks for a report as short as the task allows (reports land in your main conversation, where tokens are dearest).
- About 11 tokens per delegation in your main conversation, naming the model and effort that ran.
- A Haiku rating only for tasks the keyword rules can't place, once per distinct task: up to about 1,500 tokens in and a one-digit answer out.

## What it can and cannot touch

A mod runs inside Claude Code with your permissions, so it is worth checking. Run `claude plugin validate <folder>` to list exactly what this one does. It makes no file reads or writes, runs no programs and makes no network requests of its own. Its only outside calls are: the clock, the session's model name and Claude Code's version, registering `/tier-router`, reading two environment variables (`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` and `CLAUDE_CODE_EFFORT_LEVEL`), a Haiku request to rate an unclear task, its own small store of learned adjustments, the status line, transcript notices and short notifications, and your clipboard when you run `/tier-router export`.

## Good to know

- **What it routes:** the built-in general-purpose, claude, Explore and Plan subagents, plus any you list under Extra agent types. Your own custom subagents keep the model in their definitions by default. Forks, named agents and teammates, remote agents and workflow agents are left alone, and a subagent Claude resumes later isn't counted again.
- **What it never changes:** your main conversation's model and effort. Claude still decides when to delegate.
- **Your settings win:** with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` it routes only effort; with `CLAUDE_CODE_EFFORT_LEVEL` set it routes only the model; effort caps in your settings or your organization's are respected.
- **Caching:** each subagent starts its own prompt cache whatever model it runs on, so routing adds no cache cost. On Amazon Bedrock, Google Cloud or a gateway, a mid-task effort change does start a fresh cache for that subagent.
- **Older Claude Code:** before 2.1.292 the Agent call takes no effort setting, so the mod sends the routed effort with each of the subagent's requests instead.
- **`/clear`** starts the session report over; what it has learned stays.
- **Review routed work** before relying on it, as with any subagent. The router makes a cheap model's mistakes cheap; it does not make them impossible.

## Turning it off or removing it

`/tier-router off` pauses it for a session. To disable or uninstall, open `/plugin`, go to Installed, and choose Tier Router, or run `claude plugin uninstall tier-router`.

## Problems and ideas

Open a [bug report](https://github.com/MrKashiwagi/tier-router/issues/new?template=bug-report.yml), or any [issue](https://github.com/MrKashiwagi/tier-router/issues) for an idea. [CHANGELOG.md](CHANGELOG.md) lists what changed in each version.

## Files

```
.claude-plugin/plugin.json       manifest and settings
.claude-plugin/marketplace.json  lets the repository be installed as a marketplace
.claude-plugin/icon.png          the icon
hooks/hooks.json                 points Claude Code at the hooks module
hooks/register.ts                the hooks: routing, effort, accounting, learning, /tier-router
hooks/router.ts                  routing and learning as plain functions
hooks/pricing.ts                 the price table and per-request costs
hooks/session.ts                 what a session keeps, and the report
hooks/share.ts                   the anonymized export
tests/                           run with: claude plugin test <folder>
.github/ISSUE_TEMPLATE/          forms for bug reports and shared results
```

## License

MIT © 2026 Ibrahim (MrKashiwagi). See [LICENSE](LICENSE).
