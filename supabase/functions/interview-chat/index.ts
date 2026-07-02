import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { messages, role, resumeContext } = await req.json();

    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set. Go to Supabase → Edge Functions → Secrets and add it.");
    }

    // Model — gemini-2.5-flash is free tier and currently active
    const MODEL = "gemini-2.5-flash";

    const systemPrompt = `You are an expert technical interviewer conducting a mock interview for a ${role || "Software Developer"} position.

${resumeContext ? `Candidate resume summary: ${resumeContext}\nTailor your questions to their actual background.` : ""}

Rules:
- Ask ONE question at a time only
- Progress in this order: introductory → technical → behavioural
- After each answer give 1-2 sentences of feedback, then rate it: **Strong**, **Good**, **Needs Improvement**, or **Weak**
- After exactly 5 questions and answers, produce a final evaluation with scores in EXACTLY this format (no deviations):

Technical Skills: [0-100]
Communication: [0-100]
Confidence: [0-100]
Problem Solving: [0-100]
Behavioural Fit: [0-100]
Overall Score: [0-100]

Final Verdict: [Strong Hire / Hire / Maybe / No Hire]

Then give 2-3 specific recommendations for their real interview.
Be honest but encouraging throughout.`;

    // Convert OpenAI message format → Gemini format
    // Gemini uses role "user" or "model" (not "assistant")
    const geminiContents = (messages || []).map((m: { role: string; content: string }) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    // If no messages yet, send an initial trigger so the AI asks the first question
    if (geminiContents.length === 0) {
      geminiContents.push({
        role: "user",
        parts: [{ text: "Please start the interview. Greet me and ask your first question." }],
      });
    }

    // Call Gemini streaming endpoint
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: geminiContents,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1024,
          },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini stream error:", response.status, errText);
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Too many requests. Wait 1 minute and try again." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 403 || response.status === 401) {
        return new Response(
          JSON.stringify({ error: "GEMINI_API_KEY is invalid. Check your key in Supabase Secrets." }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ error: `Gemini API error: ${response.status}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Transform Gemini SSE → OpenAI SSE format
    // Gemini sends: data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}
    // Frontend expects: data: {"choices":[{"delta":{"content":"Hello"}}]}
    const transformStream = new TransformStream({
      transform(chunk, controller) {
        const text = new TextDecoder().decode(chunk);
        const lines = text.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (content) {
              // Emit OpenAI-compatible chunk so frontend ai.ts works unchanged
              const openAiChunk = {
                choices: [{ delta: { content }, finish_reason: null }],
              };
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify(openAiChunk)}\n\n`)
              );
            }
          } catch {
            // Skip unparseable lines — normal for SSE keepalives
          }
        }
      },
      flush(controller) {
        // Signal stream complete to frontend
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      },
    });

    return new Response(response.body!.pipeThrough(transformStream), {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });

  } catch (e) {
    console.error("interview-chat error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});