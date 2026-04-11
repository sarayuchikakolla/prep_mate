import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { resumeText } = await req.json();
    if (!resumeText) {
      return new Response(JSON.stringify({ error: "No resume text provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    let actualText = resumeText;

    // Handle PDF base64 - use AI to extract text from PDF
    if (resumeText.startsWith("[PDF_BASE64]")) {
      const base64Data = resumeText.slice("[PDF_BASE64]".length);
      // Use Gemini vision to extract text from the PDF
      const extractResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Extract ALL text content from this PDF resume. Return ONLY the raw text, preserving structure. No commentary." },
                { type: "image_url", image_url: { url: `data:application/pdf;base64,${base64Data}` } },
              ],
            },
          ],
        }),
      });

      if (!extractResponse.ok) {
        const errText = await extractResponse.text();
        console.error("PDF extraction error:", extractResponse.status, errText);
        throw new Error("Failed to extract text from PDF");
      }

      const extractData = await extractResponse.json();
      actualText = extractData.choices?.[0]?.message?.content || "";
      if (actualText.trim().length < 50) {
        throw new Error("Could not extract sufficient text from PDF");
      }
    }

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          {
            role: "system",
            content: `You are a professional resume analyst and career coach. Analyze the resume and return a JSON object with this exact structure:
{
  "summary": "Brief 2-3 sentence overview of the candidate",
  "skills": ["skill1", "skill2", ...],
  "experience_years": number,
  "education": "highest education level",
  "strengths": ["strength1", "strength2", "strength3"],
  "improvements": ["improvement1", "improvement2", "improvement3"],
  "recommended_roles": ["role1", "role2", "role3"],
  "overall_score": number between 0-100,
  "scores": {
    "technical_skills": number 0-100,
    "experience": number 0-100,
    "education": number 0-100,
    "presentation": number 0-100
  }
}
Return ONLY valid JSON, no markdown or extra text.`
          },
          { role: "user", content: `Analyze this resume:\n\n${actualText}` },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "analyze_resume",
              description: "Return structured resume analysis",
              parameters: {
                type: "object",
                properties: {
                  summary: { type: "string" },
                  skills: { type: "array", items: { type: "string" } },
                  experience_years: { type: "number" },
                  education: { type: "string" },
                  strengths: { type: "array", items: { type: "string" } },
                  improvements: { type: "array", items: { type: "string" } },
                  recommended_roles: { type: "array", items: { type: "string" } },
                  overall_score: { type: "number" },
                  scores: {
                    type: "object",
                    properties: {
                      technical_skills: { type: "number" },
                      experience: { type: "number" },
                      education: { type: "number" },
                      presentation: { type: "number" },
                    },
                    required: ["technical_skills", "experience", "education", "presentation"],
                  },
                },
                required: ["summary", "skills", "experience_years", "education", "strengths", "improvements", "recommended_roles", "overall_score", "scores"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "analyze_resume" } },
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again later." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Please add funds." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      throw new Error("AI gateway error");
    }

    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    
    let analysis;
    if (toolCall) {
      analysis = JSON.parse(toolCall.function.arguments);
    } else {
      const content = data.choices?.[0]?.message?.content || "";
      analysis = JSON.parse(content);
    }

    return new Response(JSON.stringify(analysis), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("analyze-resume error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
