/**
 * Get insights from a transcript using the Claude API.
 * Called from the side panel context.
 */
async function getInsights(transcriptText, apiKey) {
  if (!apiKey) {
    throw new Error('Please set your Anthropic API key in settings.');
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
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: `You are an expert content analyst. Below is the full transcript of a YouTube video.

First, identify what TYPE of content this is (tutorial, interview/podcast, lecture, review, opinion piece, vlog, documentary, etc.) and adapt your analysis accordingly.

Format your entire response in clean HTML (using <h2>, <h3>, <p>, <ul>, <li>, <strong>, <blockquote> tags). Do not use markdown.

Produce ALL of the following sections:

<h2>1. Executive Summary</h2>
<p>2-3 sentences: What is this video about at the highest level? What is the speaker's core thesis, argument, or purpose? Write this so someone can decide in 10 seconds whether the full analysis is worth reading.</p>

<h2>2. Key Insights & Takeaways</h2>
<p>Extract the 5-10 most important ideas, ranked by significance. For each:</p>
<ul>
<li><strong>State the insight clearly in one bold sentence</strong></li>
<li>Add 1-2 sentences of supporting context, evidence, or nuance from the transcript</li>
</ul>
<p>Prioritize non-obvious insights over surface-level observations. What would someone miss if they only skimmed?</p>

<h2>3. Actionable Next Steps</h2>
<p>What can the viewer actually DO with this information? List 3-7 concrete, specific actions. Be specific: not "think about your goals" but "Write down 3 goals using the [specific framework] mentioned." If the video is purely informational/entertainment, replace this with Key Arguments summarizing the main positions taken.</p>

<h2>4. Video Structure & Topic Map</h2>
<p>Outline the video's structure showing how it flows. Show how topics build on or connect to each other. Flag which sections are highest-value vs. skippable.</p>

<h2>5. Notable Quotes & Moments</h2>
<p>Surface 3-5 verbatim quotes that are particularly well-stated, surprising/contrarian, or central to the speaker's argument. Use blockquotes. If the transcript quality makes exact quoting unreliable, paraphrase and note it.</p>

<h2>6. Critical Analysis</h2>
<ul>
<li>What assumptions does the speaker make (stated or unstated)?</li>
<li>What counterarguments, limitations, or caveats are NOT addressed?</li>
<li>What related ideas or opposing viewpoints would strengthen or challenge this content?</li>
<li>Rate the overall quality: Is this worth watching, or is the summary sufficient?</li>
</ul>

<h2>7. One-Sentence Takeaway</h2>
<p>If the viewer remembers only ONE thing from this video, what should it be? Make it punchy and memorable.</p>

Transcript:
${transcriptText}`
        }
      ]
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    if (response.status === 401) {
      throw new Error('Invalid API key. Please check your Anthropic API key in settings.');
    }
    if (response.status === 429) {
      throw new Error('Rate limited. Please wait a moment and try again.');
    }
    throw new Error(`API error (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text;

  if (!content) {
    throw new Error('No response from Claude API');
  }

  return content;
}
