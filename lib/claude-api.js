/**
 * Generate structured insights for a transcript.
 *
 * Two providers, same return shape:
 *   'anthropic' — direct call to the Anthropic API with the user's own key.
 *                 Uses json_schema output, so the shape is guaranteed.
 *   'cursor'    — direct call to Cursor's Cloud Agents API with a Cursor API
 *                 key, billed to the user's Cursor account. No local bridge and
 *                 no CLI: the panel talks to api.cursor.com over HTTPS. The JSON
 *                 shape is prompt-enforced, not schema-enforced, so
 *                 extractJsonObject() below plus normalizeInsights() in the
 *                 panel are the backstops.
 *
 * Called from the side panel. Returns a parsed object (not HTML, not a file):
 *
 *   {
 *     contentType, tldr, summary,
 *     keyTakeaways: [{ point, detail, timestamp }],         // what you learn
 *     actionItems: [{ action, detail, timestamp }],         // what you can do
 *     sections: [{ title, timestamp, description, isAd }],  // fine-grained index
 *                                                           // isAd marks skippable
 *                                                           // sponsor reads
 *     notableQuotes: [{ quote, timestamp }]
 *   }
 *
 * Produced by three parallel runs (summary / sections / quotes), merged here.
 * getInsightsPart() reruns any one of them on its own.
 *
 * timestamps are in seconds, so the UI can make each item click-to-seek.
 *
 * Summaries cached before `keyInsights` was dropped may also carry that array;
 * the panel still renders it when present, so old caches aren't invalidated.
 */

// Haiku 4.5 — Anthropic's fastest model, and plenty capable for transcript
// extraction. This is the biggest lever on perceived speed. Settings lets a
// user switch up to Sonnet/Opus for deeper analysis on dense videos.
const DEFAULT_INSIGHTS_MODEL = 'claude-haiku-4-5';

// Cursor's Cloud Agents API. Keep in sync with host_permissions in
// manifest.json — extension pages only get to skip CORS on origins listed there.
const CURSOR_API_BASE = 'https://api.cursor.com/v1';

// 'auto' means "send no model id and let Cursor pick". The real default lives in
// lib/config.js as CURSOR_DEFAULT_MODEL; this is only the fallback if that file
// is missing or blank.
const DEFAULT_CURSOR_MODEL = 'auto';

// GET /v1/models is needed to resolve a model spec, and it barely changes.
const CURSOR_MODEL_CACHE_MS = 300_000;

// A cloud agent is provisioned before it starts answering, so the first polls
// usually come back CREATING. Budget generously: a long transcript on a
// thinking model can legitimately take minutes.
//
// Raised from 5 to 10 minutes. A feature-length video whose section list runs
// to the 40-item cap can genuinely take longer than five, and giving up early
// throws away a run that was already paid for and about to finish.
const CURSOR_RUN_TIMEOUT_MS = 600_000;
// Start well under a second. The first poll is what puts a live status and
// clock in the panel, so a slow first poll reads as a hang even though the run
// is progressing normally. Backoff still keeps the long tail of a multi-minute
// run cheap.
const CURSOR_POLL_START_MS = 700;
// Capped at 2s rather than 6s. The result is not streamed — `run.result` stays
// empty until `status` flips terminal, measured — so the only thing polling
// frequency controls is how long a finished summary sits unnoticed. At a 6s
// ceiling that averaged 3s of dead time on every summary; at 2s it averages 1s.
// The cost is ~40 extra cheap status GETs across a ~2 minute run, which is
// nothing next to the agent run itself.
const CURSOR_POLL_MAX_MS = 2_000;

// Terminal run states, per GET /v1/agents/{id}/runs/{runId}.
const CURSOR_TERMINAL_STATUSES = ['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED'];

// One definition per field, assembled below into the three schemas actually
// sent. A summary is produced by THREE runs in parallel — summary, sections and
// quotes — so the field definitions have to be shared rather than copied, or the
// parts drift apart.
const FIELD_SCHEMAS = {
    contentType: {
      type: 'string',
      description: 'What kind of video this is, e.g. tutorial, interview, lecture, review, vlog, documentary.'
    },
    tldr: {
      type: 'string',
      description: 'One punchy sentence a viewer can read in 5 seconds to decide if the video is worth their time.'
    },
    summary: {
      type: 'string',
      // Three rewrites of this field all came back too long, because every
      // budget was interpreted as a target to fill. The failure mode is always
      // the same: the model compresses the WHOLE video — every milestone, date
      // and item — instead of picking the argument. It reads as a wall in a
      // ~400px side panel, where 150 words is already fifteen lines.
      //
      // So: two paragraphs, 150 words, and an explicit ban on chronologies and
      // item-by-item coverage. Everything it wants to cram in here already
      // exists in `sections` (with timestamps) and `keyTakeaways` (with the
      // reasoning). This field is the orientation, not the record.
      description: 'A SHORT orientation to the video, read INSTEAD of watching it. HARD LIMITS, never exceeded whatever the video length: at most 2 paragraphs and at most 150 words. Target 80-110 words; go to 150 only for a dense feature-length video. It must fit on one phone-width screen without scrolling. WHAT TO WRITE: the central argument or purpose, the reasoning or evidence that carries it, and what it means for the reader. Three or four sentences of substance, not a compression of everything said. WHAT NOT TO WRITE: do not narrate the video in order; do not walk through a list, roundup, or compilation item by item; do not lay out a timeline of dates, milestones or numbers. Every one of those already appears in the section index and the key takeaways with timestamps attached — duplicating them here is the single biggest cause of an unreadable summary, and the reason this field keeps coming back too long. Pick the ONE thing worth knowing and say it well. Explain mechanisms, not labels. Never describe the video from the outside ("the speaker discusses...", "this video covers...") — deliver the content itself. Cut any sentence that only sets up another.'
    },
    keyTakeaways: {
      type: 'array',
      // The part a reader actually retains. Prose alone made everything look
      // equally important; this is the "what did I learn" list, each item
      // carrying its own justification so it survives out of context.
      description: 'The 4-8 things the reader should walk away KNOWING, in the order the video makes them. Each is a real lesson, not a topic that was covered. Skip anything that is only true inside this video (housekeeping, banter, the intro); if a video genuinely teaches fewer than four things, return fewer.',
      items: {
        type: 'object',
        properties: {
          point: {
            type: 'string',
            description: 'The lesson itself, stated as a claim the reader could repeat to someone else. Max 15 words. "Batch prompts by task type, not by project" — not "prompt organization".'
          },
          detail: {
            type: 'string',
            description: '1-3 sentences giving WHY it is true or HOW it works: the mechanism, the reasoning, the numbers or example used to support it, and any caveat or condition stated. Enough that the reader can act on it, or disagree with it, without watching the video.'
          },
          timestamp: { type: 'number', description: 'Where this is made in the video, in SECONDS.' }
        },
        required: ['point', 'detail', 'timestamp'],
        additionalProperties: false
      }
    },
    actionItems: {
      type: 'array',
      // The gap the takeaways left: knowing a claim is not the same as knowing
      // what to do on Tuesday. Kept strictly derived from the video — an
      // invented protocol would be worse than an empty list.
      description: 'Concrete things the viewer can actually DO, drawn from this video — the practical residue of watching it. 0-6 items, in the order the video raises them. Include only actions the video actually recommends, demonstrates, or directly implies; if it is a discussion, interview, or news piece with nothing to act on, return an empty array rather than inventing advice. Prefer things that fit into an ordinary day or week over projects. Never invent a number, dose, duration, setting or step the video did not state.',
      items: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The action as an instruction, starting with a verb, max 12 words. Specific enough to do without re-reading: "Get 10 minutes of sunlight within an hour of waking" — not "improve your light exposure".'
          },
          detail: {
            type: 'string',
            description: '1-2 sentences: how to do it, when or how often, and WHY it works according to the video — plus any caveat, risk or condition the video states. If the video gives numbers (dose, duration, timing, frequency), keep them exactly. Attribute contested or health-related claims to the video rather than asserting them.'
          },
          timestamp: { type: 'number', description: 'Where the video covers this, in SECONDS.' }
        },
        required: ['action', 'detail', 'timestamp'],
        additionalProperties: false
      }
    },
    sections: {
      type: 'array',
      // Granularity is the whole point of this array. The long-form reading
      // experience lives in `summary`; `sections` is a navigation index, so a
      // handful of ten-minute blocks makes it useless — the reader cannot jump
      // to the bit they want because the bit they want is buried inside a
      // section.
      //
      // The counts below are a ceiling as much as a target. Output volume is
      // the dominant cost on the Cursor path (the model emits the whole array
      // one token at a time), and an uncapped "one section per minute" rule
      // produced 148 sections on a two-hour interview — unreadable as an index
      // AND minutes of extra generation. Scale sublinearly with length and
      // stop at 40.
      description: 'A COMPLETE breakdown that splits the ENTIRE video into consecutive sections, in chronological order, start to finish with NO gaps. The first section starts at the very beginning and each following section begins exactly where the previous one ended. This is a NAVIGATION INDEX, not the summary: cut at each real topic shift or new subject, but group the small back-and-forth around one topic into a single section rather than splitting every question. HOW MANY: aim for one section per 2-4 minutes of video, and scale down as the video gets longer — under 10 minutes: 5-10 sections; 10-30 minutes: 10-18; 30-60 minutes: 15-25; over an hour: 20-35. NEVER return more than 40 sections no matter how long the video is; on a long video make each section cover more ground instead. Ads are the one exception: every ad, sponsor read, or self-promo is its OWN section, split exactly where it starts and ends, and those do not count against the limit.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short label for this section (3-7 words), naming the specific thing covered — not a generic chapter name.' },
          timestamp: { type: 'number', description: 'Start time of this section in SECONDS.' },
          description: {
            type: 'string',
            // Deliberately capped. Long section notes duplicated `summary` and
            // buried the index in prose; the sentence here only has to be
            // specific enough that the reader knows whether to jump.
            description: 'ONE short sentence, 20 words MAX, giving the single most specific thing said in this stretch. A fragment is fine. Never two sentences. Keep the hard particular (the number, name, product, verdict) and drop everything else. No lead-ins: never "the speaker explains", "this section covers", "an overview of". If the sentence would fit a different video on the same subject, it is wrong. For an ad section, just name the advertiser.'
          },
          isAd: {
            type: 'boolean',
            description: 'True if this stretch is an advertisement, sponsor read, paid promotion, affiliate plug, or a pitch for the creator\'s own product, course, newsletter, merch, Patreon, or channel membership — anything a viewer would want to skip. False for actual content, including genuine unpaid product discussion.'
          }
        },
        required: ['title', 'timestamp', 'description', 'isAd'],
        additionalProperties: false
      }
    },
    // `keyInsights` was removed deliberately: it went unused, and output volume
    // is the dominant cost on the Cursor path (the model writes ~19k characters
    // one token at a time, and a measured run spent 88s of 115s doing exactly
    // that). Dropping a whole array of insight+detail+timestamp objects is the
    // single largest reduction available without weakening the section
    // breakdown, which is the part that carries the substance.
    //
    // The panel still renders keyInsights from summaries cached before this
    // change — its renderer guards with `(data.keyInsights || [])` — so old
    // caches degrade gracefully rather than breaking.
    notableQuotes: {
      type: 'array',
      description: '0-4 verbatim quotes that are memorable, contrarian, or central. Omit if the transcript is too rough to quote reliably.',
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string', description: 'The quote, verbatim where possible.' },
          timestamp: { type: 'number', description: 'When it is said, in SECONDS.' }
        },
        required: ['quote', 'timestamp'],
        additionalProperties: false
      }
    }
};

// The three parts of a summary, and the whole thing.
//
// Each part is its own parallel run. They finish at very different times —
// SUMMARY is a few hundred words, QUOTES is a handful of lines, SECTIONS is by
// far the longest — so running them together means the panel can paint each one
// the moment it arrives instead of waiting out the slowest. INSIGHTS_SCHEMA
// remains the shape everything downstream (cache, panel, automation) sees once
// the parts are merged.
const PART_KEYS = {
  summary: ['contentType', 'tldr', 'summary', 'keyTakeaways', 'actionItems'],
  sections: ['sections'],
  quotes: ['notableQuotes']
};
const PARTS = ['summary', 'sections', 'quotes'];

function buildSchema(keys) {
  const properties = {};
  for (const key of keys) properties[key] = FIELD_SCHEMAS[key];
  return { type: 'object', properties, required: [...keys], additionalProperties: false };
}

const PART_SCHEMAS = {
  summary: buildSchema(PART_KEYS.summary),
  sections: buildSchema(PART_KEYS.sections),
  quotes: buildSchema(PART_KEYS.quotes)
};
const INSIGHTS_SCHEMA = buildSchema(
  ['contentType', 'tldr', 'summary', 'keyTakeaways', 'actionItems', 'sections', 'notableQuotes']
);

// Shared by both halves so the voice and the rules stay identical across the two
// runs — they are producing one document between them, not two.
function promptPreamble(title) {
  return `You are an expert content analyst. Below is the transcript of a YouTube video titled "${title}".

YOUR OUTPUT REPLACES WATCHING THE VIDEO. Someone will read it instead of spending the video's full runtime, and they should come away genuinely informed — able to explain what was said, cite the specifics, and hold an accurate opinion about it. Write for that reader. If they would finish your summary and still feel they need to watch, you have failed.

Each line is prefixed with its start time in seconds, like [127] some text. Use those numbers to fill the numeric "timestamp" fields (always in seconds) so the viewer can jump straight to each moment.`;
}

const SUBSTANCE_RULES = `How to write the substance:
- Transfer information, don't label it. "They looked at manufacturing costs" is worthless; "they build at roughly $2k per unit against an incumbent price of $15k, because the airframe is injection-moulded rather than carbon layup" is the point.
- Keep the particulars. Numbers, names, companies, products, dates, prices, comparisons, causes, tradeoffs, disagreements, and conclusions are the payload. Preserve them exactly as stated.
- Never write from the outside. Drop "the speaker explains", "the video covers", "they go on to discuss" — state the thing itself.
- Apply the vagueness test to every sentence: if it would still be true of a different video on the same broad subject, it is too generic. Cut it or make it specific.
- Where the speaker asserts something contested or unproven, say so plainly rather than passing it on as established fact.
- Be dense, not long. No padding, no restating the title, no filler transitions.`;

// The part the reader is actually waiting on: the prose digest.
function buildSummaryPrompt(transcriptText, title) {
  return `${promptPreamble(title)}

This output is being read INSTEAD of watching the video. The test is not whether it describes the video accurately — it is whether someone who reads it has LEARNED what the video teaches: they can explain the ideas, reproduce the reasoning, cite the specifics, and hold an informed opinion. If a reader would finish it and still not know how the thing actually works, it has failed.

Produce ONLY these fields. Separate runs are writing the chapter list and the quotes, so do not produce "sections" or "notableQuotes" and do not spend any output on them.
- "contentType": what kind of video this is.
- "tldr": one sentence a viewer can read in 5 seconds to decide whether the video is worth their time.
- "summary": a SHORT orientation. HARD LIMITS, whatever the video length: at most 2 paragraphs and at most 150 words. Target 80-110; use 150 only for a dense feature-length video. It must fit on one phone-width screen without scrolling. Write the central argument or purpose, the reasoning or evidence that carries it, and what it means for the reader — three or four sentences of substance. Do NOT narrate the video in order, walk a list or roundup item by item, or lay out a timeline of dates and milestones: all of that is already in the sections and takeaways with timestamps, and duplicating it here is what makes the summary unreadable. Pick the one thing worth knowing and say it well.
- "keyTakeaways": the 4-8 things the reader should walk away KNOWING, in the order the video makes them. THIS is where the detail lives, now that the prose is tight. Each is a lesson stated as a repeatable claim (max 15 words), plus 1-3 sentences of why it is true or how it works — the mechanism, the numbers, the caveat — and the timestamp where it is made. A topic that was merely covered is not a takeaway.
- "actionItems": 0-6 things the viewer can actually DO day to day, drawn from this video. Each is an instruction starting with a verb (max 12 words), plus 1-2 sentences on how, when or how often, and why it works according to the video, keeping any numbers exactly as stated and noting caveats. Include only what the video recommends, demonstrates, or directly implies — if it is a discussion or news piece with nothing to act on, return an empty array rather than inventing advice. Never invent a dose, duration or step the video did not give. Takeaways are what to know; these are what to do.

${SUBSTANCE_RULES}
- Teach mechanisms, not labels. If the video explains a process, framework, or method, the reader should be able to reproduce or argue it from your text alone. "They cover a prioritization framework" teaches nothing; the framework's actual steps and the reasoning for the order teaches it.
- Assume no prior context. Define a term the first time it matters, in the video's own sense of it.

Ground every timestamp in the transcript.

TRANSCRIPT:
${transcriptText}`;
}

// The smallest part, and the one most sensitive to being rushed — pulling exact
// wording out of a rough transcript is its own job, so it gets its own run.
function buildQuotesPrompt(transcriptText, title) {
  return `${promptPreamble(title)}

Produce ONLY the "notableQuotes" field. Separate runs are writing the prose summary and the chapter list, so do not produce contentType, tldr, summary or sections.

"notableQuotes" is 0-4 verbatim quotes that are memorable, contrarian, or central to what the video argues. Quote exactly what was said — do not tidy up the grammar, merge sentences that were not adjacent, or paraphrase. Skip anything the transcript renders too roughly to quote with confidence, and return an empty array rather than inventing or smoothing a quote. Each one carries the timestamp in SECONDS where it is said.

Ground every timestamp in the transcript.

TRANSCRIPT:
${transcriptText}`;
}

// The long half: the section index and the ad flags.
function buildSectionsPrompt(transcriptText, title) {
  return `${promptPreamble(title)}

Produce ONLY the "sections" field. Separate runs are writing the prose summary and the quotes, so do not produce contentType, tldr, summary or notableQuotes.

"sections" is a NAVIGATION INDEX of the whole video, chronological, no gaps, first section at the start and each one beginning where the last ended. Cut at each real topic shift, but group the back-and-forth around one topic together instead of splitting every question. Aim for one section per 2-4 minutes, scaling down as the video gets longer: under 10 minutes 5-10 sections, 10-30 minutes 10-18, 30-60 minutes 15-25, over an hour 20-35, and NEVER more than 40 (on a long video, cover more ground per section). Each description is ONE sentence of 20 words or fewer. Short and specific beats complete and wordy — the prose depth belongs in the other run, not here.

Ads: mark every advertisement, sponsor read, affiliate plug, or pitch for the creator's own product, course, newsletter, merch, or Patreon with "isAd": true, and make it its OWN section starting exactly where the pitch begins. Ad sections do not count against the section limit above. The next section must start exactly where the pitch ends, so a viewer can jump straight past it. Watch for the usual tells — "this video is brought to you by", "use code", "link in the description", "before we get started", an abrupt tonal shift into product praise. Genuine unpaid discussion of a product is NOT an ad; everything else in the video gets "isAd": false.

${SUBSTANCE_RULES}

Ground every timestamp in the transcript.

TRANSCRIPT:
${transcriptText}`;
}

/**
 * Provider-agnostic entry point used by the side panel.
 *
 * opts: { provider, model, apiKey, cursorApiKey, onProgress, onPartial, onRunStarted }
 *   provider     'anthropic' (default) | 'cursor' | 'webhook'
 *   apiKey       Anthropic key, used only by the 'anthropic' provider
 *   cursorApiKey Cursor key, used by 'cursor' and (for polling) 'webhook'
 *   onProgress   optional (message) => void, for the slower Cursor path
 *   onPartial    optional (insights) => void, fired each time a part lands while
 *                others are still running, so the panel can paint progressively.
 *                Carries summaryPending / sectionsPending / quotesPending for
 *                whatever has not arrived yet
 *   onRunStarted optional ({ agentId, runId, part }) => void
 *
 * Three runs go out in PARALLEL — 'summary' (contentType/tldr/summary),
 * 'sections', and 'quotes'. They finish at very different times, and waiting on
 * all three before showing anything meant staring at a spinner for the length of
 * the slowest one. The parts are merged here, so every caller still gets one
 * object in the documented shape.
 */
async function getInsights(transcriptText, title, opts = {}) {
  const onPartial = typeof opts.onPartial === 'function' ? opts.onPartial : () => {};
  const report = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  // All three report progress, but the panel has one status line. Show the
  // summary run's status until it lands — that is what the user is waiting on —
  // then hand the line to sections, the long pole.
  let summarySettled = false;
  const progressFor = part => message => {
    if (part === 'summary' ? !summarySettled : (summarySettled && part === 'sections')) report(message);
  };

  const runs = {};
  for (const part of PARTS) {
    runs[part] = runInsightsPart(part, transcriptText, title, opts, progressFor(part));
  }

  // Paint progressively: every part is emitted the moment it lands, in whatever
  // order the runs happen to finish. Quotes routinely come back in ~13s against
  // a summary that takes far longer, and holding them back until the summary
  // arrived threw away the entire benefit of running them separately. The panel
  // uses the *Pending flags to show a placeholder for whatever is still out.
  //
  // Nothing is emitted once the last part is in — the caller gets the finished
  // object then, not a partial that is really the final answer.
  const merged = {};
  const stillPending = () => ({
    summaryPending: !('summary' in merged),
    sectionsPending: !('sections' in merged),
    quotesPending: !('notableQuotes' in merged)
  });

  for (const part of PARTS) {
    runs[part].then(
      value => {
        if (part === 'summary') summarySettled = true;
        Object.assign(merged, value);
        const pending = stillPending();
        if (pending.summaryPending || pending.sectionsPending || pending.quotesPending) {
          onPartial({ ...merged, ...pending });
        }
      },
      () => { if (part === 'summary') summarySettled = true; }
    );
  }

  const settled = await Promise.allSettled(PARTS.map(part => runs[part]));
  const byPart = Object.fromEntries(PARTS.map((part, i) => [part, settled[i]]));

  // The summary is the point of the feature, so its failure is the run's
  // failure. The other two are survivable: show what did arrive and name what
  // did not, rather than throwing away good parts.
  if (byPart.summary.status === 'rejected') throw byPart.summary.reason;

  return {
    ...byPart.summary.value,
    ...(byPart.sections.status === 'fulfilled'
      ? byPart.sections.value
      : { sections: [], sectionsError: byPart.sections.reason?.message || 'The section list failed to generate.' }),
    ...(byPart.quotes.status === 'fulfilled'
      ? byPart.quotes.value
      : { notableQuotes: [], quotesError: byPart.quotes.reason?.message || 'The quotes failed to generate.' })
  };
}

const PART_PROMPTS = {
  summary: buildSummaryPrompt,
  sections: buildSectionsPrompt,
  quotes: buildQuotesPrompt
};

/**
 * Regenerate exactly ONE part of a summary — the caller merges the result into
 * the summary it already has.
 *
 * This is the same run getInsights() fires for that part, just on its own: if
 * the section list came back thin or a quote reads wrong, redoing that part
 * costs one small run instead of re-paying for all three and throwing away two
 * good ones.
 *
 * Resolves with only that part's fields, e.g. { sections: [...] }.
 */
function getInsightsPart(part, transcriptText, title, opts = {}) {
  if (!PARTS.includes(part)) {
    return Promise.reject(new Error(`Unknown summary part: ${part}`));
  }
  const report = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  return runInsightsPart(part, transcriptText, title, opts, report);
}

// Keep only the fields this part owns.
//
// The webhook provider is prompt-enforced, not schema-enforced: an automation
// running older instructions answers a "SECTIONS ONLY" request with the whole
// object. Without this, one part's run would silently overwrite the others —
// and a single-part rerun would replace the entire summary the reader was
// looking at, which reads as the button being broken.
function pickPartKeys(part, value) {
  if (!value || typeof value !== 'object') return {};
  const picked = {};
  for (const key of PART_KEYS[part]) {
    if (key in value) picked[key] = value[key];
  }
  return picked;
}

// One part of a summary, on whichever provider is configured.
function runInsightsPart(part, transcriptText, title, opts, report) {
  const onRunStarted = ids =>
    (typeof opts.onRunStarted === 'function' ? opts.onRunStarted({ ...ids, part }) : undefined);

  const run = () => {
    if (opts.provider === 'webhook') {
      // The automation already holds the rules and the JSON schema, so this
      // sends only the transcript plus a one-line directive naming the part.
      return getInsightsViaWebhook(transcriptText, title, opts, report, onRunStarted, part);
    }

    const prompt = PART_PROMPTS[part](transcriptText, title);
    const schema = PART_SCHEMAS[part];

    if (opts.provider === 'cursor') {
      return getInsightsViaCursor(prompt, opts.cursorApiKey, opts.model, report, onRunStarted, schema);
    }
    return getInsightsViaAnthropic(prompt, opts.apiKey, opts.model, schema);
  };

  return run().then(value => pickPartKeys(part, value));
}

// Directive appended to the webhook payload. The automation's own instructions
// describe all three parts; this only has to name which one is wanted.
const WEBHOOK_PART_DIRECTIVE = {
  summary: 'PARTIAL REQUEST — SUMMARY ONLY. Return contentType, tldr, summary, keyTakeaways and actionItems. Do NOT return "sections" or "notableQuotes"; other runs are writing them. Spend no output on them.',
  sections: 'PARTIAL REQUEST — SECTIONS ONLY. Return only the "sections" array. Do NOT return contentType, tldr, summary, keyTakeaways, actionItems or notableQuotes; other runs are writing them.',
  quotes: 'PARTIAL REQUEST — QUOTES ONLY. Return only the "notableQuotes" array. Do NOT return contentType, tldr, summary, keyTakeaways, actionItems or sections; other runs are writing them.'
};

/**
 * Summarize by firing a Cursor Automation webhook instead of creating an agent.
 *
 * Why this exists: POST /v1/agents cold-starts a container and blocks on it,
 * while the automation's container is already warm — measured as roughly 20s
 * less dead time before the model produces anything.
 *
 * The webhook returns a `backgroundComposerId`, which is an ordinary agent id
 * (`bc-...`). That is the whole trick: the run is then pollable with the normal
 * Cursor API key through exactly the same path as a directly-created agent, so
 * everything below is shared with getInsightsViaCursor().
 *
 * The automation supplies the model and the output spec, so neither is sent.
 */
async function getInsightsViaWebhook(transcriptText, title, opts, onProgress, onRunStarted, part) {
  const url = opts.webhookUrl;
  const auth = opts.webhookAuth;
  const cursorApiKey = opts.cursorApiKey;

  if (!url || !auth) throw new Error('NO_WEBHOOK');
  // Polling the resulting run needs a normal API key; the webhook token is
  // scoped to triggering the automation and cannot read runs.
  if (!cursorApiKey) throw new Error('NO_CURSOR_KEY');

  const report = typeof onProgress === 'function' ? onProgress : () => {};
  const announceRun = typeof onRunStarted === 'function' ? onRunStarted : () => {};

  const startedAt = Date.now();
  const elapsed = () => {
    const total = Math.round((Date.now() - startedAt) / 1000);
    return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
  };
  const reportWithClock = phase => report(`${phase} · ${elapsed()}`);

  report('Starting the Cursor automation…');

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${auth}` },
      // The directive goes AFTER the transcript: the automation's instructions
      // say trailing directives refine its rules, and this is the only thing
      // distinguishing the three runs from each other.
      body: JSON.stringify({
        prompt: `TITLE: ${title}\n\nTRANSCRIPT:\n${transcriptText}`
          + (WEBHOOK_PART_DIRECTIVE[part] ? `\n\n${WEBHOOK_PART_DIRECTIVE[part]}` : '')
      })
    });
  } catch (e) {
    throw new Error('Could not reach the Cursor automation. Check your connection.');
  }

  const raw = await response.text().catch(() => '');
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('The automation rejected its token. Regenerate CURSOR_WEBHOOK_AUTH in Cursor (Generate auth header).');
    }
    throw new Error(`Cursor automation error (${response.status}): ${raw.slice(0, 200)}`);
  }

  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
  const agentId = data?.backgroundComposerId;
  if (!agentId) throw new Error('The automation did not return a run to poll.');

  // The webhook answers before the run record exists, so wait for the id rather
  // than assuming it is there.
  let runId = null;
  const idDeadline = Date.now() + 120_000;
  while (!runId && Date.now() < idDeadline) {
    const agent = await cursorFetch(`/agents/${agentId}`, cursorApiKey);
    runId = agent?.agent?.latestRunId || agent?.latestRunId || null;
    if (!runId) {
      reportWithClock('Cursor is starting the automation');
      await sleep(1000);
    }
  }
  if (!runId) throw new Error('The automation did not start a run within 2 minutes.');

  announceRun({ agentId, runId });

  try {
    const text = await waitForCursorRun(agentId, runId, cursorApiKey, reportWithClock);
    const insights = extractJsonObject(text);
    if (!insights) throw new Error('The automation did not return valid JSON for this transcript.');
    return insights;
  } finally {
    cursorFetch(`/agents/${agentId}/archive`, cursorApiKey, { method: 'POST' }).catch(() => {});
  }
}

// --------------------------------------------------------------------- Cursor

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * One authenticated call to api.cursor.com. Normalizes the error cases the
 * panel cares about into messages a user can act on.
 */
async function cursorFetch(path, cursorApiKey, options = {}) {
  if (!cursorApiKey) throw new Error('NO_CURSOR_KEY');

  let response;
  try {
    response = await fetch(`${CURSOR_API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cursorApiKey}`,
        ...(options.headers || {})
      }
    });
  } catch (e) {
    throw new Error('Could not reach the Cursor API. Check your connection.');
  }

  const raw = await response.text().catch(() => '');
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (e) {
    data = null;
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Cursor rejected the API key. Check CURSOR_API_KEY in lib/config.js.');
    }
    if (response.status === 429) {
      throw new Error('Rate limited by Cursor. Wait a moment and try again.');
    }
    const detail = data?.message || data?.error || raw.slice(0, 200);
    throw new Error(`Cursor API error (${response.status})${detail ? `: ${detail}` : '.'}`);
  }

  return data;
}

/**
 * Summarize through a Cursor cloud agent.
 *
 * Cursor has no chat-completions endpoint — the unit of work is an agent run —
 * so this creates an agent, polls its run to completion, and reads the final
 * text out of `result`.
 *
 * Sending neither `repos` nor `env` creates a NO-REPO agent, which matters for
 * more than convenience: the transcript is untrusted third-party text, and a
 * no-repo agent has none of the user's code mounted for a prompt-injected
 * instruction to read or modify. Do not attach a repository here.
 */
async function getInsightsViaCursor(prompt, cursorApiKey, model, onProgress, onRunStarted, schema) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  const announceRun = typeof onRunStarted === 'function' ? onRunStarted : () => {};

  // A cloud agent has to be provisioned before it writes anything, so the honest
  // floor on this path is tens of seconds. Static text through that window is
  // indistinguishable from a hang, so every message carries a running clock and
  // the first one says the wait is expected. Nothing here makes the summary
  // faster — it makes the waiting legible, which is the part that felt broken.
  const startedAt = Date.now();
  const elapsed = () => {
    const total = Math.round((Date.now() - startedAt) / 1000);
    return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
  };
  const reportWithClock = phase => report(`${phase} · ${elapsed()}`);

  const cursorPrompt = `${prompt}

---
Respond with ONLY a single minified JSON object and nothing else — no prose before or after, no markdown code fences, no commentary. It must match this JSON Schema exactly:

${JSON.stringify(schema || INSIGHTS_SCHEMA)}`;

  const body = { prompt: { text: cursorPrompt } };
  const resolved = await resolveCursorModelForRequest(cursorApiKey, model);
  if (resolved) body.model = resolved;

  report('Provisioning a Cursor agent — this usually takes a minute…');
  const created = await cursorFetch('/agents', cursorApiKey, {
    method: 'POST',
    body: JSON.stringify(body)
  });

  const agentId = created?.agent?.id;
  const runId = created?.run?.id || created?.agent?.latestRunId;
  if (!agentId || !runId) {
    throw new Error('Cursor did not return an agent run to poll.');
  }

  // Hand the ids to the caller before the long poll begins. The agent is now
  // running on Cursor's side and will finish whether or not anything here is
  // still listening, so persisting these lets a restarted worker rejoin the run
  // instead of abandoning a paid agent and starting a second one.
  announceRun({ agentId, runId });

  try {
    const text = await waitForCursorRun(agentId, runId, cursorApiKey, reportWithClock);
    let insights = extractJsonObject(text);

    // One repair pass: hand the unparseable output back as a follow-up run on
    // the same agent and ask for bare JSON.
    if (!insights) {
      reportWithClock('Cleaning up the response');
      const followup = await cursorFetch(`/agents/${agentId}/runs`, cursorApiKey, {
        method: 'POST',
        body: JSON.stringify({
          prompt: {
            text:
              'Your previous message was supposed to be a single minified JSON object but ' +
              'could not be parsed. Return ONLY the corrected JSON object — no prose, no ' +
              'markdown fences, no commentary.'
          }
        })
      });
      const retryRunId = followup?.id || followup?.run?.id;
      if (retryRunId) {
        insights = extractJsonObject(
          await waitForCursorRun(agentId, retryRunId, cursorApiKey, reportWithClock)
        );
      }
    }

    if (!insights) throw new Error('Cursor did not return valid JSON for this transcript.');
    return insights;
  } finally {
    // Housekeeping: one agent per summary would otherwise pile up in the user's
    // Cursor dashboard. Archiving is reversible and best-effort — if it fails,
    // the summary is already in hand and nothing here should surface an error.
    cursorFetch(`/agents/${agentId}/archive`, cursorApiKey, { method: 'POST' }).catch(() => {});
  }
}

/**
 * Rejoin a Cursor run that was already created — used after the service worker
 * is terminated mid-poll. The agent keeps running on Cursor's side and is
 * already paid for, so picking the run back up is strictly better than
 * abandoning it and creating a second one.
 */
async function resumeCursorInsights(agentId, runId, cursorApiKey, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  const startedAt = Date.now();
  const elapsed = () => {
    const total = Math.round((Date.now() - startedAt) / 1000);
    return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
  };

  try {
    const text = await waitForCursorRun(
      agentId, runId, cursorApiKey, phase => report(`${phase} · ${elapsed()}`)
    );
    const insights = extractJsonObject(text);
    if (!insights) throw new Error('Cursor did not return valid JSON for this transcript.');
    return insights;
  } finally {
    cursorFetch(`/agents/${agentId}/archive`, cursorApiKey, { method: 'POST' }).catch(() => {});
  }
}

/**
 * Poll a run until it reaches a terminal state; resolves with its result text.
 *
 * `report` is expected to stamp its own elapsed time, so this reports on every
 * poll rather than only on status changes — re-sending an unchanged phase is
 * what keeps the clock in the panel moving during a long provision.
 */
async function waitForCursorRun(agentId, runId, cursorApiKey, report) {
  const deadline = Date.now() + CURSOR_RUN_TIMEOUT_MS;
  let interval = CURSOR_POLL_START_MS;

  // Poll before sleeping, not after. Sleeping first put a floor under every
  // summary — a run that was already FINISHED still waited out a full interval
  // before anyone noticed, and the panel showed no status at all until then.
  while (Date.now() < deadline) {
    const run = await cursorFetch(`/agents/${agentId}/runs/${runId}`, cursorApiKey);
    const status = run?.status;

    if (CURSOR_TERMINAL_STATUSES.includes(status)) {
      if (status !== 'FINISHED') {
        throw new Error(
          run?.result
            ? `Cursor run ${status.toLowerCase()}: ${String(run.result).slice(0, 200)}`
            : `The Cursor run ended as ${status.toLowerCase()}.`
        );
      }

      const result = typeof run.result === 'string' ? run.result.trim() : '';
      if (!result) throw new Error('The Cursor run finished but returned no text.');
      return result;
    }

    report(status === 'CREATING'
      ? 'Provisioning a Cursor agent'
      : 'Cursor is analyzing the transcript');

    await sleep(interval);
    interval = Math.min(Math.round(interval * 1.5), CURSOR_POLL_MAX_MS);
  }

  throw new Error(
    `Cursor did not finish within ${Math.round(CURSOR_RUN_TIMEOUT_MS / 60000)} minutes. ` +
    'Try a shorter video or a faster model.'
  );
}

/**
 * Scan forward from the first '{' and return the substring where brace depth
 * first returns to zero — i.e. exactly one complete JSON object, ignoring
 * anything before or after it.
 *
 * Tracks string and escape state so that braces inside string values (very
 * common here: quotes and descriptions contain them) don't move the depth.
 */
function firstBalancedObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Cursor enforces JSON shape by prompt only — there's no json_schema mode like
 * the Anthropic API has — so the model can still wrap output in prose or a
 * fenced block. Dig the object out rather than failing the whole summary.
 *
 * Getting this right matters far more than it looks: a failed extraction fires
 * the repair run below, which is a whole second cloud agent — roughly doubling
 * both the wait and the cost. A real Grok 4.6 response was observed emitting
 * perfect JSON followed by a single stray '}'. The old fallback here sliced from
 * the first '{' to lastIndexOf('}'), which selected that stray brace and so
 * failed on the very output it existed to rescue. Balanced scanning fixes that
 * whole class: trailing braces, trailing prose, or commentary after the object.
 */
function extractJsonObject(text) {
  const trimmed = String(text).trim();
  const attempts = [trimmed];

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) attempts.push(fence[1].trim());

  // The workhorse: tolerates anything surrounding a well-formed object.
  const balanced = firstBalancedObject(trimmed);
  if (balanced) attempts.push(balanced);

  // Last resort, kept for the case where the object itself is malformed but a
  // greedy span happens to parse.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(trimmed.slice(first, last + 1));

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (e) {
      // try the next shape
    }
  }
  return null;
}

// ------------------------------------------------------- Cursor model resolving
//
// Cursor names a model two different ways. The CLI uses one flat id per variant
// ('cursor-grok-4.6-low-fast'), while the REST API takes a base id plus a
// `params` array ({ id: 'cursor-grok-4.6', params: [...] }). A model spec here
// may be written either way; resolveCursorModel() turns it into whatever shape
// the live GET /v1/models actually offers, so neither spelling is a dead end.

let cursorModelCache = { at: 0, items: [] };

/** The cached model list if it's still fresh, else [] — never hits the network. */
function cachedCursorModelItems() {
  if (cursorModelCache.items.length && Date.now() - cursorModelCache.at < CURSOR_MODEL_CACHE_MS) {
    return cursorModelCache.items;
  }
  return [];
}

async function fetchCursorModelItems(cursorApiKey) {
  const cached = cachedCursorModelItems();
  if (cached.length) return cached;

  const data = await cursorFetch('/models', cursorApiKey);
  const items = Array.isArray(data?.items) ? data.items : [];
  cursorModelCache = { at: Date.now(), items };
  return items;
}

/** 'id' + [{id,value}] → 'id?a=1&b=2' (sorted, so the string is stable). */
function encodeCursorModelSpec(id, params) {
  if (!params || !params.length) return id;
  const query = params
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map(p => `${encodeURIComponent(p.id)}=${encodeURIComponent(p.value)}`)
    .join('&');
  return `${id}?${query}`;
}

/** The inverse. A spec with no '?' is just a bare id. */
function parseCursorModelSpec(spec) {
  const raw = String(spec || '').trim();
  const q = raw.indexOf('?');
  if (q === -1) return { id: raw, params: [] };

  const params = [];
  for (const pair of raw.slice(q + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    params.push({ id: decodeURIComponent(key), value: decodeURIComponent(value) });
  }
  return { id: raw.slice(0, q), params };
}

/**
 * Turn a model spec into the `model` field for POST /v1/agents, or null for
 * 'auto'. `items` is the GET /v1/models payload; pass [] to skip resolution and
 * send the id verbatim.
 */
function resolveCursorModel(spec, items) {
  const wanted = parseCursorModelSpec(spec);
  if (!wanted.id || wanted.id === DEFAULT_CURSOR_MODEL) return null;

  const list = Array.isArray(items) ? items : [];
  const lookup = id => list.find(m => m.id === id || (m.aliases || []).includes(id));

  // Params spelled out already — trust them, only canonicalize an alias.
  if (wanted.params.length) {
    const item = lookup(wanted.id);
    return { id: item ? item.id : wanted.id, params: wanted.params };
  }

  // The CLI and REST namespaces diverge on this one prefix: `cursor-agent
  // models` lists 'cursor-grok-4.6-low-fast' while GET /v1/models calls the
  // same model 'grok-4.6'. Try the id as written and with that prefix dropped.
  const candidates = [wanted.id];
  if (wanted.id.startsWith('cursor-')) candidates.push(wanted.id.slice('cursor-'.length));

  // The API offers this exact id.
  for (const candidate of candidates) {
    const exact = lookup(candidate);
    if (exact) return { id: exact.id };
  }

  // A flat CLI-style id against the params-based API: match the longest base id,
  // then map each leftover token ('high', 'fast') onto a parameter the model
  // itself declares. Only declared names and values are used — nothing invented.
  let best = null;
  for (const item of list) {
    const base = `${item.id}-`;
    const candidate = candidates.find(c => c.startsWith(base));
    if (!candidate) continue;

    const params = [];
    const tokens = candidate.slice(base.length).split('-').filter(Boolean);
    const matched = tokens.every(token => {
      for (const p of item.parameters || []) {
        const values = p.values || [];
        // e.g. reasoning=high
        if (values.some(v => String(v.value) === token)) {
          params.push({ id: p.id, value: token });
          return true;
        }
        // e.g. a bare 'fast' token meaning fast=true
        if (p.id === token && values.some(v => String(v.value) === 'true')) {
          params.push({ id: p.id, value: 'true' });
          return true;
        }
      }
      return false;
    });

    if (matched && (!best || item.id.length > best.id.length)) best = { id: item.id, params };
  }
  if (best) return best;

  // No list to match against, or a genuinely flat namespace: pass it through.
  return { id: wanted.id };
}

/**
 * Resolve the spec for an outgoing request. A models-endpoint hiccup must not
 * fail the summary, so on error the id goes out as-is.
 *
 * A spec that already carries explicit params in the REST namespace (no
 * 'cursor-' prefix) is what POST /v1/agents wants — the model list would only
 * canonicalize an alias. That isn't worth a blocking round trip on the way to
 * every summary: the side panel is a fresh document each time it opens, so the
 * cache is cold on the first summary of every session, which is exactly the one
 * that feels slowest. Use the list if it's already warm, skip it if not.
 */
async function resolveCursorModelForRequest(cursorApiKey, spec) {
  const parsed = parseCursorModelSpec(spec);
  if (!parsed.id || parsed.id === DEFAULT_CURSOR_MODEL) return null;

  const skipColdFetch = parsed.params.length > 0 && !parsed.id.startsWith('cursor-');

  let items = skipColdFetch ? cachedCursorModelItems() : [];
  if (!items.length && !skipColdFetch) {
    try {
      items = await fetchCursorModelItems(cursorApiKey);
    } catch (e) {
      items = [];
    }
  }
  return resolveCursorModel(spec, items);
}

/**
 * The spec string for `spec` written the way the live model list writes it, so a
 * flat CLI-style default ('cursor-grok-4.6-low-fast') still selects the right
 * dropdown entry when the API lists it as a base id plus params. Falls back to
 * 'auto' when there's nothing to select.
 */
async function canonicalCursorModelSpec(cursorApiKey, spec) {
  const resolved = await resolveCursorModelForRequest(cursorApiKey, spec);
  if (!resolved) return DEFAULT_CURSOR_MODEL;
  return encodeCursorModelSpec(resolved.id, resolved.params);
}

/**
 * Selectable models for the Settings dropdown: one entry per variant, so
 * distinct reasoning/fast combinations are separately pickable.
 * Returns [{ value, label }] where value is a model spec.
 */
async function getCursorModels(cursorApiKey) {
  const items = await fetchCursorModelItems(cursorApiKey);
  const options = [];
  const seen = {};

  const add = (value, label) => {
    if (!value || seen[value]) return;
    seen[value] = true;
    options.push({ value, label: label || value });
  };

  for (const item of items) {
    const variants = Array.isArray(item.variants) ? item.variants : [];
    if (!variants.length) {
      add(item.id, item.displayName || item.id);
      continue;
    }
    for (const variant of variants) {
      add(
        encodeCursorModelSpec(item.id, variant.params),
        variant.displayName || item.displayName || item.id
      );
    }
  }
  return options;
}

/** Verify the key and name the account it belongs to (used in Settings). */
async function checkCursorKey(cursorApiKey) {
  const me = await cursorFetch('/me', cursorApiKey);
  const account = me?.userEmail || me?.apiKeyName || '';
  return { ok: true, account };
}

// ------------------------------------------------------------------ Anthropic

async function getInsightsViaAnthropic(prompt, apiKey, model, schema) {
  if (!apiKey) {
    throw new Error('NO_API_KEY');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: model || DEFAULT_INSIGHTS_MODEL,
      // A full section-by-section breakdown with real substance in each entry
      // runs long on a feature-length video. 8000 truncated those mid-array,
      // which surfaces as a parse failure rather than a short summary. Still
      // under the ~16k ceiling where non-streaming risks an SDK-side timeout.
      max_tokens: 16000,
      output_config: {
        format: {
          type: 'json_schema',
          schema: schema || INSIGHTS_SCHEMA
        }
      },
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    if (response.status === 401) {
      throw new Error('Invalid Anthropic API key. Check it in Settings.');
    }
    if (response.status === 429) {
      throw new Error('Rate limited by Anthropic. Wait a moment and try again.');
    }
    throw new Error(`Anthropic API error (${response.status}): ${errorBody.substring(0, 200)}`);
  }

  const data = await response.json();

  if (data.stop_reason === 'refusal') {
    throw new Error('The model declined to analyze this transcript.');
  }

  const text = data.content?.find(b => b.type === 'text')?.text;
  if (!text) {
    throw new Error('No response from the Anthropic API.');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('Could not parse the model response. Please try again.');
  }

  return parsed;
}
