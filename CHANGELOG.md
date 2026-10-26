# Changelog

## 0.3.0

- `/tier-router export` puts an anonymized summary of routing results on the clipboard and in the transcript, to share in a "Share routing data" issue so the defaults can be tuned from many people's results. It holds outcome counts and learned adjustments only: no task text, file names, times or costs. Nothing is sent automatically.
- Results are now also tallied by kind of task, difficulty estimate, model and effort, kept with what the router has learned. Stores from 0.2 are read as before.
- Finished work that Claude re-sends to a stronger model is now counted once, as a miss, instead of twice.
- Command answers and notifications no longer repeat "tier-router", which Claude Code already shows beside them.
- Installs straight from GitHub: `/plugin install tier-router --marketplace MrKashiwagi/tier-router`.
- MIT license, an icon, and issue forms for bug reports and shared data.

## 0.2.0

- Reports the model and effort that actually ran, including fallbacks and effort caps.
- Prices each request at API list prices, including Haiku 5.5's higher rate above 100K prompt tokens, and compares the cost with the parent's model.
- Counts the router's own Haiku ratings separately.
- Keeps the full report out of Claude's context; `/tier-router share` hands it over on request.
- Learns from strain (hard runs, repeated effort raises) and from Claude re-sending finished work to a stronger model.
- Sends effort per request on Claude Code before 2.1.292; `/clear` starts the report over.

## 0.1.0

- First version: routes delegated tasks to Haiku, Sonnet or Opus by difficulty, with an effort level for each.
- Keyword rules, with a Haiku rating for unclear tasks.
- Raises effort while a subagent struggles, escalates retries, and learns per kind of task.
- `/tier-router` report and controls.
