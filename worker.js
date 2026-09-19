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
 *   POST /gemini        -> forwards body to Gemini's generateContent endpoint
 *   POST /groq          -> forwards body to Groq's chat/completions endpoint
 *   POST /openrouter    -> forwards body to OpenRouter's chat/completions endpoint
 *   POST /cerebras      -> forwards body to Cerebras' chat/completions endpoint
 *   POST /azure-foundry -> forwards body to Azure AI Foundry's chat/completions endpoint
 *   POST /apinex        -> forwards body to APInex's chat/completions endpoint
 *   POST /tts           -> forwards body to ElevenLabs text-to-speech (voice/speech ONLY)
 *   POST /azure-tts     -> forwards body to Azure Speech text-to-speech
 *   POST /azure-stt     -> forwards audio to Azure Speech speech-to-text
 *   POST /subscription/verify -> checks a Polar license key { key } and answers { active, activeUntil }
 *   POST /storage/get     -> { idToken, key } -> { key, value, shared:false } or null if unset
 *   POST /storage/set     -> { idToken, key, value } -> { key, value, shared:false }
 *   POST /storage/delete  -> { idToken, key } -> { key, deleted, shared:false }
 *   POST /storage/list    -> { idToken, prefix } -> { keys, prefix, shared:false }
 *   POST /subscription/status -> { idToken } -> { active, activeUntil, plan } for THIS Google account
 *                               (this is what makes a subscription follow the account across devices)
 *
 * AI ROUTES + AUTH (new):
 *   Every AI route (/gemini, /groq, /openrouter, /cerebras, /azure-foundry,
 *   /apinex, /tts, /azure-tts, /azure-stt) can require a signed-in Google
 *   account, sent as   Authorization: Bearer <Google ID token>   (a header,
 *   NOT the body, because these bodies are forwarded verbatim to the AI
 *   providers). The worker then looks up that account's plan in KV and
 *   enforces the free-tier limits SERVER-SIDE.
 *
 *   Enforcement is controlled by the ENFORCE_AUTH variable so you can deploy
 *   safely in two steps:
 *     ENFORCE_AUTH unset / "off"  -> old behaviour, nothing is blocked
 *     ENFORCE_AUTH = "log"        -> checks run and are logged, nothing blocked
 *     ENFORCE_AUTH = "on"         -> unauthenticated / over-limit calls are rejected
 *   Set it with:  wrangler secret put ENFORCE_AUTH   (or under [vars] in wrangler.toml)
 *   Do NOT set it to "on" until index.html has been updated to send the
 *   Authorization header (see FRONTEND_PATCH.md), or the app will stop working.
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
 *  10. wrangler secret put AZURE_FOUNDRY_ENDPOINT (your Foundry "Project endpoint", no trailing slash)
 *  11. wrangler secret put AZURE_FOUNDRY_KEY      (your Foundry API key)
 *  12. wrangler secret put AZURE_FOUNDRY_MODEL    (the deployment/model name, e.g. "gpt-5.6-sol")
 *  13. wrangler secret put APINEX_API_KEY         (your APInex key, sk-apx...)
 *  13b. wrangler secret put POLAR_ORG_ID         (Polar dashboard -> Settings -> your Organization ID; needed for /subscription/verify)
 *  14. wrangler secret put APINEX_MODEL           (optional — model id, e.g. "gpt-5-6-terra"; defaults to that if unset)
 *  15. Create a free KV namespace for account-backed storage, then add its
 *      id to wrangler.toml under a binding named CHALKLINE_KV:
 *        wrangler kv namespace create CHALKLINE_KV
 *      then in wrangler.toml:
 *        [[kv_namespaces]]
 *        binding = "CHALKLINE_KV"
 *        id = "<the id the command above printed>"
 *      Free tier: 100k reads/day, 1k writes/day, 1GB stored — plenty for
 *      personal lesson/summary/quiz/notes content while this is small.
 *  16. wrangler deploy
 *  17. Copy the resulting https://<name>.<subdomain>.workers.dev URL
 *      into PROXY_URL in tutor.html and summary.html, and into
 *      CHALKLINE_STORAGE_BASE / VERIFY_URL in the shell.
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

    // Only your own site may use this proxy. Browsers on other websites (and
    // casual scripts that don't fake an Origin header) can no longer spend
    // your AI credits. This is a first line of defence, not real
    // authentication — a determined person can still forge the header.
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: { message: "Origin not allowed." } }, 403, headers);
    }

    const url = new URL(request.url);

    try {
      // Subscriber check (Polar license key). Handled before the generic body
      // read below because it parses its own JSON.
      if (url.pathname === "/subscription/verify") {
        return await verifySubscription(request, env, headers);
      }
      if (url.pathname === "/subscription/status") {
        return await subscriptionStatus(request, env, headers);
      }

      // Account-backed content storage (lessons, summaries, quizzes, notes).
      // Each request carries the person's Google ID token; we verify it
      // ourselves with Google rather than trusting whatever the browser
      // claims, so one signed-in person can never read or write another's
      // saved content. Handled before the generic body read below because
      // each parses its own JSON.
      if (url.pathname === "/storage/get") return await storageGet(request, env, headers);
      if (url.pathname === "/storage/set") return await storageSet(request, env, headers);
      if (url.pathname === "/storage/delete") return await storageDelete(request, env, headers);
      if (url.pathname === "/storage/list") return await storageList(request, env, headers);


      // ---- Server-side gate for every AI route --------------------------
      // Runs BEFORE any provider is called, so an unauthenticated or
      // over-limit caller never spends your credits. Storage / subscription
      // routes above have already returned, so they are unaffected.
      if (AI_ROUTES.has(url.pathname)) {
        const gate = await gateAiRequest(request, env, url.pathname, headers);
        if (gate.response) return gate.response;
      }

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

      if (url.pathname === "/apinex") {
        if (!env.APINEX_API_KEY) {
          return json({ error: { message: "APINEX_API_KEY is not set on the worker." } }, 500, headers);
        }
        let parsedBody;
        try{
          parsedBody = JSON.parse(body);
        } catch(e){
          return json({ error: { message: "Invalid JSON body sent to /apinex." } }, 400, headers);
        }
        // APInex speaks plain OpenAI-compatible chat/completions — same
        // messages/choices shape as /groq and /openrouter above — so this
        // is a straight pass-through with the model id fixed here (not
        // sent by the frontend), same pattern as AZURE_FOUNDRY_MODEL.
        const resp = await fetch("https://api.apinex.bond/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.APINEX_API_KEY}`,
          },
          body: JSON.stringify({ ...parsedBody, model: env.APINEX_MODEL || "gpt-5-6-terra" }),
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

      if (url.pathname === "/azure-foundry") {
        if (!env.AZURE_FOUNDRY_ENDPOINT || !env.AZURE_FOUNDRY_KEY || !env.AZURE_FOUNDRY_MODEL) {
          return json({ error: { message: "AZURE_FOUNDRY_ENDPOINT / AZURE_FOUNDRY_KEY / AZURE_FOUNDRY_MODEL is not set on the worker." } }, 500, headers);
        }
        let parsedBody;
        try{
          parsedBody = JSON.parse(body);
        } catch(e){
          return json({ error: { message: "Invalid JSON body sent to /azure-foundry." } }, 400, headers);
        }
        // Azure AI Foundry's unified Models API is OpenAI-chat-compatible —
        // same messages/choices response shape as /groq and /openrouter
        // above — so the frontend just needs to pick the deployed model
        // name via AZURE_FOUNDRY_MODEL (e.g. "claude-opus-5", "gpt-5.6-sol").
        // AZURE_FOUNDRY_ENDPOINT should be the "Project endpoint" shown in
        // the Foundry portal (ends in something like
        // ".services.ai.azure.com/api/projects/<project-name>"), with no
        // trailing slash.
        const endpoint = env.AZURE_FOUNDRY_ENDPOINT.replace(/\/+$/, "");
        // Azure has shipped several api-version values for this endpoint
        // over time (2024-05-01-preview, 2025-01-01-preview, "v1" for the
        // newer GA surface) and which one a given Foundry resource accepts
        // varies — guessing one value and hardcoding it keeps breaking.
        // Instead, try them in order and use whichever one the resource
        // actually accepts, so this doesn't need to be manually re-guessed
        // every time Microsoft changes what's current.
        const AZURE_FOUNDRY_API_VERSIONS = ["2024-05-01-preview", "2025-01-01-preview", "v1"];
        try{
          let azResp, azText;
          for (const apiVersion of AZURE_FOUNDRY_API_VERSIONS) {
            azResp = await fetch(
              `${endpoint}/models/chat/completions?api-version=${apiVersion}`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${env.AZURE_FOUNDRY_KEY}`,
                  "api-key": env.AZURE_FOUNDRY_KEY,
                },
                body: JSON.stringify({ ...parsedBody, model: env.AZURE_FOUNDRY_MODEL }),
              }
            );
            azText = await azResp.text();
            // Only keep retrying the NEXT version on a version-rejection
            // specifically — any other error (bad model name, quota, auth)
            // is real and should be returned as-is, not masked by retries.
            const looksLikeVersionRejection = azResp.status === 400 &&
              /api[ -]?version/i.test(azText) &&
              /(not supported|invalid|unsupported)/i.test(azText);
            if (!looksLikeVersionRejection) break;
          }
          // Azure occasionally answers with a non-JSON body — an empty
          // 401, an HTML error page from a misrouted/misspelled endpoint,
          // a plaintext message — and forwarding that as-is just makes the
          // frontend fail with an opaque "invalid JSON" with no way to see
          // why. Wrap anything that isn't valid JSON so the real cause
          // (wrong endpoint, bad key, empty body, etc.) is actually visible.
          try{
            JSON.parse(azText);
            return new Response(azText, { status: azResp.status, headers: { ...headers, "Content-Type": "application/json" } });
          } catch(parseErr){
            return json({
              error: {
                message: `Azure AI Foundry returned a non-JSON response (HTTP ${azResp.status}).`,
                rawBody: azText.slice(0, 1000),
                endpointCalled: endpoint + "/models/chat/completions",
              }
            }, azResp.status || 502, headers);
          }
        } catch(e){
          return json({ error: { message: "Request error — " + e.message } }, 502, headers);
        }
      }

      // Cloudflare Workers AI — used for VOICE (text-to-speech) ONLY.
      // Not a chat/text model route; the routes above still handle all
      // text generation for the tutor and summary features.
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

      return json({ error: { message: "Unknown route. Use /gemini, /groq, /openrouter, /cerebras, /azure-foundry, /apinex, /tts, /azure-tts, /azure-stt, /subscription/verify, or /storage/get|set|delete|list." } }, 404, headers);
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

// Checks a customer's Polar license key. Polar's customer-portal validate
// endpoint is public (no secret needed) but is scoped to your organization,
// so a key from anyone else's shop simply comes back as not found.
// Answers { active: boolean, activeUntil?: ms timestamp, message?: string }.
//  - 200 + active:false  -> the key is wrong, revoked or expired (the app removes the plan)
//  - 502                 -> Polar couldn't be reached (the app keeps the cached plan for a few days)
//
// NEW: if the request also carries a valid Google `idToken` and the key is
// active, the plan is saved against that Google account in KV, so the
// subscription follows the person to every device (see /subscription/status).
async function verifySubscription(request, env, headers) {
  if (!env.POLAR_ORG_ID) {
    return json({ active: false, message: "Subscriptions aren't set up on the server yet." }, 500, headers);
  }
  let key = "";
  let idToken = "";
  try {
    const body = await request.json();
    key = String((body && body.key) || "").trim();
    idToken = String((body && body.idToken) || "");
  } catch (e) { /* falls through to the empty-key check */ }
  if (!key || key.length > 200) {
    return json({ active: false, message: "Enter a valid license key." }, 400, headers);
  }

  const result = await checkPolarKey(key, env);
  if (result.kind === "unreachable") {
    return json({ active: false, message: "Couldn't reach the payment service. Try again in a moment." }, 502, headers);
  }
  if (result.kind === "error") {
    return json({ active: false, message: result.message }, 502, headers);
  }
  if (result.kind === "invalid") {
    return json({ active: false, message: "That key isn't valid. Check it and try again." }, 200, headers);
  }
  if (result.kind === "inactive") {
    return json({ active: false, message: result.message }, 200, headers);
  }

  // Key is genuinely active. Tie it to the signed-in Google account (if any).
  let saved = false;
  if (idToken && env.CHALKLINE_KV) {
    const sub = await verifyGoogleIdToken(idToken);
    if (sub) {
      // A license key belongs to ONE account: refuse to let a second Google
      // account claim a key that's already bound to someone else, otherwise
      // one purchase could be shared with everyone.
      const owner = await env.CHALKLINE_KV.get(KEY_OWNER_PREFIX + key);
      if (owner && owner !== sub) {
        return json({
          active: false,
          message: "That key is already linked to a different account.",
        }, 200, headers);
      }
      await env.CHALKLINE_KV.put(KEY_OWNER_PREFIX + key, sub);
      await env.CHALKLINE_KV.put(PLAN_PREFIX + sub, JSON.stringify({
        key,
        activeUntil: result.activeUntil,
        checkedAt: Date.now(),
      }));
      saved = true;
    }
  }
  return json({ active: true, activeUntil: result.activeUntil, savedToAccount: saved }, 200, headers);
}

// Talks to Polar. Returns one of:
//   { kind:"active", activeUntil }   { kind:"inactive", message }
//   { kind:"invalid" }               { kind:"unreachable" }   { kind:"error", message }
async function checkPolarKey(key, env) {
  let resp;
  try {
    resp = await fetch("https://api.polar.sh/v1/customer-portal/license-keys/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, organization_id: env.POLAR_ORG_ID }),
    });
  } catch (e) {
    return { kind: "unreachable" };
  }
  if (resp.status === 404 || resp.status === 422) return { kind: "invalid" };
  if (!resp.ok) return { kind: "error", message: "The payment service had a problem. Try again in a moment." };

  let data;
  try { data = await resp.json(); }
  catch (e) { return { kind: "error", message: "Unexpected reply from the payment service." }; }

  const expiresAt = data.expires_at ? Date.parse(data.expires_at) : null;
  const notExpired = !expiresAt || expiresAt > Date.now();
  if (data.status === "granted" && notExpired) {
    // No expiry on the key means "active while granted"; the app re-checks
    // periodically, so this is only how long it trusts the answer offline.
    return { kind: "active", activeUntil: expiresAt || Date.now() + 35 * 24 * 60 * 60 * 1000 };
  }
  return {
    kind: "inactive",
    message: data.status === "revoked" ? "That subscription has ended." : "That key isn't active.",
  };
}

/* =====================================================================
   PLAN LOOKUP (per Google account) + SERVER-SIDE ENFORCEMENT
   Plans live in KV under  plan::<google sub>  — a prefix the /storage/*
   routes can never reach, because those always prepend "<sub>::" to the
   caller's key. So a user cannot overwrite their own plan through storage.
   ===================================================================== */
const PLAN_PREFIX = "plan::";
const KEY_OWNER_PREFIX = "keyowner::";
const USAGE_PREFIX = "usage::";
const PLAN_RECHECK_MS = 12 * 60 * 60 * 1000;      // re-validate with Polar at most every 12h
const PLAN_GRACE_MS = 3 * 24 * 60 * 60 * 1000;    // keep working if Polar is unreachable

// Free-tier limits, enforced on the server. Keep these in step with
// PLAN_CONFIG in index.html.
const FREE_LIMITS = {
  AI_CALLS_PER_DAY: 60,     // generic AI calls (chat turns, summaries, TTS chunks...) per rolling day
  AI_CALLS_PER_MINUTE: 20,  // burst protection for everyone, including subscribers
  SUBSCRIBER_CALLS_PER_DAY: 1500, // runaway-cost ceiling even for paying users
  SUMMARY_ALLOWED: false,   // summaries are Pro-only (FREE_SUMMARIES: 0 in the app)
};

const AI_ROUTES = new Set([
  "/gemini", "/groq", "/openrouter", "/cerebras", "/azure-foundry",
  "/apinex", "/tts", "/azure-tts", "/azure-stt", "/gemini-tts",
]);

// Returns the account's plan from KV, re-checking Polar when it's stale.
// Result: { subscriber: boolean, activeUntil?: number }
async function getPlanForSub(sub, env) {
  if (!env.CHALKLINE_KV) return { subscriber: false };
  const raw = await env.CHALKLINE_KV.get(PLAN_PREFIX + sub);
  if (!raw) return { subscriber: false };

  let plan;
  try { plan = JSON.parse(raw); } catch (e) { return { subscriber: false }; }
  if (!plan || !plan.key) return { subscriber: false };

  // Refresh from Polar occasionally so a cancelled/revoked key stops working
  // without the user having to do anything.
  if (Date.now() - (plan.checkedAt || 0) > PLAN_RECHECK_MS && env.POLAR_ORG_ID) {
    const r = await checkPolarKey(plan.key, env);
    if (r.kind === "active") {
      plan = { ...plan, activeUntil: r.activeUntil, checkedAt: Date.now() };
      await env.CHALKLINE_KV.put(PLAN_PREFIX + sub, JSON.stringify(plan));
    } else if (r.kind === "inactive" || r.kind === "invalid") {
      await env.CHALKLINE_KV.delete(PLAN_PREFIX + sub);   // lapsed or cancelled
      return { subscriber: false };
    }
    // unreachable / error: fall through and trust the cached plan for the grace period
  }
  const ok = !!(plan.activeUntil && Date.now() < plan.activeUntil + PLAN_GRACE_MS);
  return ok ? { subscriber: true, activeUntil: plan.activeUntil } : { subscriber: false };
}

// POST /subscription/status  { idToken }  ->  { active, activeUntil }
// This is what a NEW device calls right after Google sign-in, so the
// subscription is picked up automatically with no license key to re-enter.
async function subscriptionStatus(request, env, headers) {
  const { error, sub } = await readAuthedBody(request, env, headers);
  if (error) return error;
  const plan = await getPlanForSub(sub, env);
  return json({ active: plan.subscriber, activeUntil: plan.activeUntil || null }, 200, headers);
}

function bearerToken(request) {
  const h = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}

// Simple fixed-window counters in KV. KV is eventually consistent and has a
// low free write quota, so this is a cost-control guard rail, not a precise
// billing meter — good enough to stop abuse and to enforce a daily allowance.
async function bumpCounter(env, name, windowSeconds) {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const k = USAGE_PREFIX + name + "::" + bucket;
  const current = parseInt((await env.CHALKLINE_KV.get(k)) || "0", 10) || 0;
  await env.CHALKLINE_KV.put(k, String(current + 1), { expirationTtl: Math.max(60, windowSeconds * 2) });
  return current + 1;
}

// The gate. Returns { response } to short-circuit, or {} to let the call through.
async function gateAiRequest(request, env, path, headers) {
  const mode = String(env.ENFORCE_AUTH || "off").toLowerCase();
  if (mode !== "on" && mode !== "log") return {};          // feature switched off
  const enforcing = mode === "on";

  const deny = (status, message, extra) => {
    if (!enforcing) { console.log("[gate:log] would block", path, status, message); return {}; }
    return { response: json({ error: { message, ...(extra || {}) } }, status, headers) };
  };

  if (!env.CHALKLINE_KV) {
    // Can't enforce anything without KV. Fail closed only when enforcing.
    return deny(500, "CHALKLINE_KV is not bound on the worker.");
  }

  const sub = await verifyGoogleIdToken(bearerToken(request));
  if (!sub) {
    return deny(401, "Sign-in required or expired — please sign in again.", { code: "auth_required" });
  }

  const plan = await getPlanForSub(sub, env);

  // Burst limit: applies to everyone, so a script can't hammer the paid APIs.
  const perMinute = await bumpCounter(env, sub + "::m", 60);
  if (perMinute > FREE_LIMITS.AI_CALLS_PER_MINUTE) {
    return deny(429, "You're going a bit fast — wait a few seconds and try again.", { code: "rate_limited" });
  }

  const perDay = await bumpCounter(env, sub + "::d", 24 * 60 * 60);

  if (plan.subscriber) {
    if (perDay > FREE_LIMITS.SUBSCRIBER_CALLS_PER_DAY) {
      return deny(429, "Daily usage limit reached. It resets within 24 hours.", { code: "daily_cap" });
    }
    return {};
  }

  // ---- Free tier ----
  if (perDay > FREE_LIMITS.AI_CALLS_PER_DAY) {
    return deny(402, "You've used today's free allowance. Subscribe for unlimited access.", { code: "free_limit" });
  }
  return {};
}

/* =====================================================================
   ACCOUNT-BACKED STORAGE (Cloudflare KV, free tier)
   Every key is namespaced by the caller's verified Google `sub`, so one
   person's lessons/summaries/quizzes/notes are never visible to another
   even though everyone shares the same KV namespace.
   ===================================================================== */
const GOOGLE_CLIENT_ID = "676487295279-j4qka36obo55unl3vds7ja2v24uoq6dm.apps.googleusercontent.com";
const MAX_STORAGE_KEY_LEN = 200;
const MAX_STORAGE_VALUE_BYTES = 5 * 1024 * 1024; // 5MB, well under KV's 25MB value cap

// Verifies a Google ID token with Google itself (no library needed) and
// returns the verified subject id, or null if the token is missing,
// malformed, expired, or was issued for a different app.
async function verifyGoogleIdToken(idToken) {
  if (!idToken || typeof idToken !== "string" || idToken.length > 4096) return null;
  let resp;
  try {
    resp = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken));
  } catch (e) {
    return null;
  }
  if (!resp.ok) return null;
  let data;
  try { data = await resp.json(); } catch (e) { return null; }
  if (!data.sub || data.aud !== GOOGLE_CLIENT_ID) return null;
  if (data.exp && Number(data.exp) * 1000 < Date.now()) return null;
  // Google account ids are purely numeric. Enforce that, because `sub` is
  // used as a KV key prefix ("<sub>::<key>") and plans live at "plan::<sub>".
  // A non-numeric sub such as "plan" could otherwise make those namespaces
  // overlap and let one account touch another's plan data.
  const sub = String(data.sub);
  if (!/^[0-9]{5,32}$/.test(sub)) return null;
  return sub;
}

async function readAuthedBody(request, env, headers) {
  let body;
  try { body = await request.json(); } catch (e) { return { error: json({ error: { message: "Invalid JSON body." } }, 400, headers) }; }
  const sub = await verifyGoogleIdToken(body && body.idToken);
  if (!sub) return { error: json({ error: { message: "Sign-in required or expired — please sign in again." } }, 401, headers) };
  if (!env.CHALKLINE_KV) return { error: json({ error: { message: "CHALKLINE_KV is not bound on the worker." } }, 500, headers) };
  return { sub, body };
}

function kvKeyFor(sub, key) { return sub + "::" + key; }

async function storageGet(request, env, headers) {
  const { error, sub, body } = await readAuthedBody(request, env, headers);
  if (error) return error;
  const key = String(body.key || "");
  if (!key || key.length > MAX_STORAGE_KEY_LEN) return json({ error: { message: "Invalid key." } }, 400, headers);
  const value = await env.CHALKLINE_KV.get(kvKeyFor(sub, key));
  if (value === null) return json(null, 200, headers);
  return json({ key, value, shared: false }, 200, headers);
}

async function storageSet(request, env, headers) {
  const { error, sub, body } = await readAuthedBody(request, env, headers);
  if (error) return error;
  const key = String(body.key || "");
  const value = body.value == null ? "" : String(body.value);
  if (!key || key.length > MAX_STORAGE_KEY_LEN) return json({ error: { message: "Invalid key." } }, 400, headers);
  if (value.length > MAX_STORAGE_VALUE_BYTES) return json({ error: { message: "Value too large." } }, 400, headers);
  await env.CHALKLINE_KV.put(kvKeyFor(sub, key), value);
  return json({ key, value, shared: false }, 200, headers);
}

async function storageDelete(request, env, headers) {
  const { error, sub, body } = await readAuthedBody(request, env, headers);
  if (error) return error;
  const key = String(body.key || "");
  if (!key || key.length > MAX_STORAGE_KEY_LEN) return json({ error: { message: "Invalid key." } }, 400, headers);
  const fullKey = kvKeyFor(sub, key);
  const existed = (await env.CHALKLINE_KV.get(fullKey)) !== null;
  await env.CHALKLINE_KV.delete(fullKey);
  return json({ key, deleted: existed, shared: false }, 200, headers);
}

async function storageList(request, env, headers) {
  const { error, sub, body } = await readAuthedBody(request, env, headers);
  if (error) return error;
  const prefix = String(body.prefix || "");
  const fullPrefix = kvKeyFor(sub, prefix);
  const result = await env.CHALKLINE_KV.list({ prefix: fullPrefix });
  const keys = result.keys.map((k) => k.name.slice(fullPrefix.length - prefix.length));
  return json({ keys, prefix, shared: false }, 200, headers);
}
