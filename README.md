# YouTube Transcript & Insights

An unpacked Chrome extension that fetches timestamped YouTube transcripts and
shows summaries, action items, and sections in a side panel. Sections open automatically at
the top, followed by Summary and the separate What to do group.

## OpenRouter

Reload the extension in Chrome after updating these files. In the extension's
Settings, select **OpenRouter** and save. The default model is
`z-ai/glm-5.3-flash`. GLM 5.3 FlashX was the previous default; its only provider
(Z.AI) has no zero-data-retention endpoint, so an account with ZDR-only routing
gets a 404 for it. A saved FlashX value is moved to Flash automatically. Any
other custom model is kept. When OpenRouter reports that a data policy (such as
zero data retention) excluded every provider, the panel says so. A key entered in Settings overrides the optional
`OPENROUTER_API_KEY` constant in the gitignored `lib/config.js`.

This is a direct streaming HTTPS API integration, triggered whenever the app
requests a summary. It does not require a scheduled task, webhook server, or
ChatGPT workspace. Usage is billed by OpenRouter.

Two requests run in parallel: summary and sections. Each part appears when
complete and can be regenerated separately.
Generated insights must be in English, even for non-English transcripts.
Script checks and Chrome's language detector reject detected non-English prose
and trigger OpenRouter's correction flow. On reopening a video, affected saved
parts are hidden and regenerated automatically, retaining valid English parts.
GLM Flash supports JSON mode rather than JSON-schema enforcement, so the app
validates required fields, types, timestamps, and output length before caching.
Every OpenRouter request allows the selected model's advertised maximum output
(currently 943,717 tokens for Flash), shared between reasoning and the answer.
The app reads output limits from OpenRouter's model catalog and caches them for
10 minutes; custom models use their own advertised maximum. A missing limit is
reported rather than silently imposing a smaller cap. GLM Flash uses high reasoning
for the summary and low reasoning for sections.
Lists are sorted chronologically.
Each part has up to four attempts within a ten-minute deadline. Invalid JSON,
missing fields, and enforced editorial limits get corrective feedback naming
the failing fields (including heading indices and word counts). Corrections ask
the model to preserve valid fields. Temporary network failures, incomplete
streams, output-limit failures, rate limits, and server errors retry with
exponential backoff and respect `Retry-After`. Key/account errors, credit limits,
and refusals stop immediately without changing providers.

A failed summary no longer discards successful sections. Each part
appears and is saved as it finishes. Exhausted retries show an error in that
part's group while the others remain usable. Pressing **Summarize** on an
incomplete result retries only failed or missing parts; each group's rerun
button also remains available. A complete result can still be regenerated.
Simultaneous part reruns merge their cache writes so neither overwrites the
other. A failed replacement retains the previous valid content.

Section descriptions target 20 words, but longer descriptions are preserved
without a retry or rejection so useful navigation and caveats are not lost.
Section timestamp, duplicate-start, count, and ad-label checks still apply.
A live elapsed clock continues while any part is running and shows retry status.

Closing the panel lets requests continue in Chrome's background worker. Closing
Chrome, reloading the extension, or a browser crash interrupts OpenRouter
requests; those streams cannot be resumed like Cursor agent runs. Completed
parts remain cached, and interrupted parts can be retried without regenerating
the completed ones. Retries are bounded per run, so reopening an exhausted
result does not start another automatic retry loop.

API keys stay on this machine in local extension storage or `lib/config.js`.
Never commit or distribute `lib/config.js` with personal keys. The key created
for this personal installation has a $10 monthly usage limit, configurable in
OpenRouter's key settings.

## Verification

Run `node --test tests/*.test.cjs`. Tests use mocked providers and do not incur
API usage. They cover streaming, schema checks, failure handling, settings,
transcript caching, and automatic preparation. Live testing requires an API key.

References: [OpenRouter API](https://openrouter.ai/docs/quickstart),
[streaming](https://openrouter.ai/docs/api/reference/streaming), and
[GLM 5.3 Flash](https://openrouter.ai/z-ai/glm-5.3-flash).
