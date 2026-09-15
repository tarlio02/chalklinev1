/**
 * Chalkline AI proxy.
 *
 * This is the ONLY place your API keys live. They're set as private
 * environment secrets on Cloudflare (never in this file, never committed
 * to GitHub, never sent to the browser). The static site on GitHub Pages
 * calls this worker; this worker calls Gemini/Groq/OpenRouter/Cerebras
 * using the secrets.
 *
 * Routes:
 *   POST /gemini      -> forwards body to Gemini's generateContent endpoint
 *   POST /groq        -> forwards body to Groq's chat/completions endpoint
 *   POST /openrouter  -> forwards body to OpenRouter's chat/completions endpoint
 *   POST /cerebras    -> forwards body to Cerebras' chat/completions endpoint
 *   POST /tts         -> forwards body to ElevenLabs text-to-speech (voice/speech ONLY)
 *   POST /azure-tts   -> forwards body to Azure Speech text-to-speech
 *   POST /azure-stt   -> forwards audio to Azure Speech speech-to-text
 *
 * Setup (one-time):
 *   1. npm install -g wrangler
 *   2. wrangler login
 *   3. wrangler secret put GEMINI_API_KEY        (paste your Gemini key)
 *   4. wrangler secret put GROQ_API_KEY          (paste your Groq key)
 *   5. wrangler secret put OPENROUTER_API_KEY    (paste your OpenRouter key)
 *   6. wrangler secret put CEREBRAS_API_KEY      (paste your Cerebras key)
 *   7. wrangler secret put ELEVENLABS_API_KEY    (paste your ElevenLabs key, for voice/TTS only)
 *   8. wrangler secret put AZURE_SPEECH_KEY      (paste your Azure Speech KEY 1)
 *   9. wrangler secret put AZURE_SPEECH_REGION   (e.g. "eastus" — no quotes when prompted)
 *  10. wrangler deploy
 *  11. Copy the resulting https://<name>.<subdomain>.workers.dev URL
 *      into PROXY_URL in tutor.html and summary.html.
 *
 * See PROXY_SETUP.md for full step-by-step instructions.
 */

// Restrict who can call this worker. Add every origin you deploy the
// static site to (GitHub Pages URL, a custom domain, localhost while
// testing). Requests from any other origin are rejected.
const ALLOWED_ORIGINS = [
  "https://tarlio02.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000"
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "X-Voice-Provider",
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers });
    }

    const url = new URL(request.url);

    try {
      // Azure STT reads raw audio bytes, not JSON — handle it before the
      // generic `await request.text()` below consumes the body as text.
      if (url.pathname === "/azure-stt") {
        if (!env.AZURE_SPEECH_KEY || !env.AZURE_SPEECH_REGION) {
          return json({ error: { message: "AZURE_SPEECH_KEY / AZURE_SPEECH_REGION is not set on the worker." } }, 500, headers);
        }
        const audioBuffer = await request.arrayBuffer();
        const contentType = request.headers.get("Content-Type") || "audio/wav; codecs=audio/pcm; samplerate=16000";

        const sttResp = await fetch(
          `https://${env.AZURE_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=simple`,
          {
            method: "POST",
            headers: {
              "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY,
              "Content-Type": contentType,
              "Accept": "application/json",
            },
            body: audioBuffer,
          }
        );
        const text = await sttResp.text();
        return new Response(text, { status: sttResp.status, headers: { ...headers, "Content-Type": "application/json" } });
      }

      const body = await request.text();

      if (url.pathname === "/gemini") {
        if (!env.GEMINI_API_KEY) {
          return json({ error: { message: "GEMINI_API_KEY is not set on the worker." } }, 500, headers);
        }
        const resp = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": env.GEMINI_API_KEY,
            },
            body,
          }
        );
        const text = await resp.text();
        return new Response(text, { status: resp.status, headers: { ...headers, "Content-Type": "application/json" } });
      }

      if (url.pathname === "/groq") {
        if (!env.GROQ_API_KEY) {
          return json({ error: { message: "GROQ_API_KEY is not set on the worker." } }, 500, headers);
        }
        const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.GROQ_API_KEY}`,
          },
          body,
        });
        const text = await resp.text();
        return new Response(text, { status: resp.status, headers: { ...headers, "Content-Type": "application/json" } });
      }

      if (url.pathname === "/openrouter") {
        if (!env.OPENROUTER_API_KEY) {
          return json({ error: { message: "OPENROUTER_API_KEY is not set on the worker." } }, 500, headers);
        }
        const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
            // OpenRouter uses these to attribute usage on its free tier —
            // not required, but recommended so your app doesn't look anonymous.
            "HTTP-Referer": ALLOWED_ORIGINS[0],
            "X-Title": "Chalkline",
          },
          body,
        });
        const text = await resp.text();
        return new Response(text, { status: resp.status, headers: { ...headers, "Content-Type": "application/json" } });
      }

      if (url.pathname === "/cerebras") {
        if (!env.CEREBRAS_API_KEY) {
          return json({ error: { message: "CEREBRAS_API_KEY is not set on the worker." } }, 500, headers);
        }
        const resp = await fetch("https://api.cerebras.ai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.CEREBRAS_API_KEY}`,
          },
          body,
        });
        const text = await resp.text();
        return new Response(text, { status: resp.status, headers: { ...headers, "Content-Type": "application/json" } });
      }

      // Cloudflare Workers AI — used for VOICE (text-to-speech) ONLY.
      // Not a chat/text model route; the other four routes above still
      // handle all text generation for the tutor and summary features.
      // Default ElevenLabs voice — a custom/cloned voice, since ElevenLabs'
      // free tier blocks API access to premade library voices.
      const ELEVENLABS_VOICE_ID = "hpp4J3VqNfWAUOO0d1Us";

      if (url.pathname === "/tts") {
        let parsedBody;
        try{
          parsedBody = JSON.parse(body);
        } catch(e){
          return json({ error: { message: "Invalid JSON body sent to /tts." } }, 400, headers);
        }
        const spokenText = parsedBody.text || parsedBody.prompt || "";

        if (!env.ELEVENLABS_API_KEY) {
          return json({ error: { message: "ELEVENLABS_API_KEY is not set on the worker." } }, 500, headers);
        }
        try{
          const elResp = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "xi-api-key": env.ELEVENLABS_API_KEY,
                "Accept": "audio/mpeg",
              },
              body: JSON.stringify({
                text: spokenText,
                model_id: "eleven_turbo_v2_5",
              }),
            }
          );
          if (elResp.ok) {
            const audio = await elResp.arrayBuffer();
            return new Response(audio, {
              status: 200,
              headers: { ...headers, "Content-Type": "audio/mpeg", "X-Voice-Provider": "elevenlabs" },
            });
          }
          const elErrorText = await elResp.text();
          let elErrorObj;
          try{ elErrorObj = JSON.parse(elErrorText); } catch(e){ elErrorObj = { raw: elErrorText }; }
          return json({ elevenLabsError: elErrorObj }, elResp.status, headers);
        } catch(e){
          return json({ elevenLabsError: { message: "Request error — " + e.message } }, 502, headers);
        }
      }

      // Azure Speech text-to-speech. Body: { "text": "...", "voice": "en-US-AriaNeural" (optional) }
      // Returns raw audio/mpeg bytes, same shape as /tts above, so the
      // frontend can treat them interchangeably (X-Voice-Provider tells
      // it which one answered).
      if (url.pathname === "/azure-tts") {
        if (!env.AZURE_SPEECH_KEY || !env.AZURE_SPEECH_REGION) {
          return json({ error: { message: "AZURE_SPEECH_KEY / AZURE_SPEECH_REGION is not set on the worker." } }, 500, headers);
        }
        let parsedBody;
        try{
          parsedBody = JSON.parse(body);
        } catch(e){
          return json({ error: { message: "Invalid JSON body sent to /azure-tts." } }, 400, headers);
        }
        const spokenText = (parsedBody.text || parsedBody.prompt || "").toString();
        const voice = parsedBody.voice || "en-US-AriaNeural";

        // Azure returns an opaque "Bad Request" for empty/whitespace-only
        // SSML content, which is impossible to debug from the client side.
        // Fail fast here with a clear message instead.
        if (!spokenText.trim()) {
          return json({ error: { message: "No text provided to /azure-tts (empty or whitespace-only)." } }, 400, headers);
        }

        const escapedText = spokenText
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&apos;");

        const ssml =
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
          `<voice xml:lang='en-US' name='${voice}'>${escapedText}</voice>` +
          `</speak>`;

        try{
          const azResp = await fetch(
            `https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
            {
              method: "POST",
              headers: {
                "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY,
                "Content-Type": "application/ssml+xml",
                "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
              },
              body: ssml,
            }
          );
          if (azResp.ok) {
            const audio = await azResp.arrayBuffer();
            return new Response(audio, {
              status: 200,
              headers: { ...headers, "Content-Type": "audio/mpeg", "X-Voice-Provider": "azure" },
            });
          }
          const azErrorText = await azResp.text();
          return json({
            azureError: { message: azErrorText || azResp.statusText },
            debug: {
              region: env.AZURE_SPEECH_REGION,
              regionLength: env.AZURE_SPEECH_REGION.length,
              voice: voice,
              textLength: spokenText.length,
              ssmlSent: ssml,
            },
          }, azResp.status, headers);
        } catch(e){
          return json({ azureError: { message: "Request error — " + e.message } }, 502, headers);
        }
      }

      return json({ error: { message: "Unknown route. Use /gemini, /groq, /openrouter, /cerebras, /tts, /azure-tts, or /azure-stt." } }, 404, headers);
    } catch (err) {
      return json({ error: { message: "Proxy error: " + err.message } }, 502, headers);
    }
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
