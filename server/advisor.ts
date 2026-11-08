import { GoogleGenAI } from '@google/genai';
import {
  type ArchetypeClassification,
  classifyProgramArchetype,
  type CopilotPatchItem,
  solveNaturalLanguageMasteringCopilot,
} from '../src/dsp/ownAiEngine.js';
import type { MasteringChainParams } from '../src/dsp/types.js';
import type { MasteringAdviseRequest, MasteringChatRequest } from './schemas.js';

export type AiProviderId =
  | 'sonicforge_own_ai'
  | 'free_cloud_ai'
  | 'gemini_ai_advisor'
  | 'groq_ai_advisor'
  | 'openrouter_ai_advisor'
  | 'openai_ai_advisor';

export interface CustomAiCredentials {
  provider?: 'gemini' | 'groq' | 'openrouter' | 'openai';
  apiKey?: string;
}

export interface MasteringAdviceResponse {
  provider: AiProviderId;
  modelLabel: string;
  archetype: ArchetypeClassification;
  headline: string;
  observations: string[];
  actionableSteps: string[];
  complianceVerdict: string;
  privacyNotice: string;
}

export interface MasteringChatResponse {
  provider: AiProviderId;
  modelLabel: string;
  archetype: ArchetypeClassification;
  reply: string;
  patchItems: CopilotPatchItem[];
  updatedParams: MasteringChainParams | null;
  privacyNotice: string;
}

function isTestEnv(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const fenceStripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const firstBrace = fenceStripped.indexOf('{');
  const lastBrace = fenceStripped.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    return JSON.parse(fenceStripped.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function callOpenAiCompatibleJson(opts: {
  url: string;
  apiKey?: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
}): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.extraHeaders ?? {}),
  };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  const res = await fetch(opts.url, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 7500),
    body: JSON.stringify({
      model: opts.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userPrompt },
      ],
    }),
  });

  if (!res.ok) return null;
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;
  return extractJsonObject(content);
}

async function callGeminiJson(opts: {
  apiKey: string;
  model?: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<Record<string, unknown> | null> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const response = await ai.models.generateContent({
    model: opts.model || process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
    contents: `${opts.systemPrompt}\n\n${opts.userPrompt}`,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  });
  const text = response.text?.trim();
  return text ? extractJsonObject(text) : null;
}

interface ResolvedLlmCall {
  provider: AiProviderId;
  modelLabel: string;
  json: Record<string, unknown>;
}

async function runMultiProviderJsonLlm(opts: {
  preferEngine?: 'auto' | 'own_ai' | 'free_cloud' | 'custom_key';
  creds?: CustomAiCredentials;
  systemPrompt: string;
  userPrompt: string;
}): Promise<ResolvedLlmCall | null> {
  if (opts.preferEngine === 'own_ai') {
    return null;
  }

  const customKey = opts.creds?.apiKey?.trim();
  const customProv = opts.creds?.provider;

  // 1. Optional user-provided BYOK key (never persisted server-side)
  if (customKey && customProv) {
    try {
      if (customProv === 'gemini') {
        const json = await callGeminiJson({
          apiKey: customKey,
          systemPrompt: opts.systemPrompt,
          userPrompt: opts.userPrompt,
        });
        if (json) {
          return { provider: 'gemini_ai_advisor', modelLabel: 'Gemini 2.5 Flash (BYOK)', json };
        }
      } else if (customProv === 'groq') {
        const json = await callOpenAiCompatibleJson({
          url: 'https://api.groq.com/openai/v1/chat/completions',
          apiKey: customKey,
          model: 'llama-3.3-70b-versatile',
          systemPrompt: opts.systemPrompt,
          userPrompt: opts.userPrompt,
        });
        if (json) {
          return { provider: 'groq_ai_advisor', modelLabel: 'Groq Llama 3.3 70B (BYOK)', json };
        }
      } else if (customProv === 'openrouter') {
        const json = await callOpenAiCompatibleJson({
          url: 'https://openrouter.ai/api/v1/chat/completions',
          apiKey: customKey,
          model: 'meta-llama/llama-3.3-70b-instruct:free',
          systemPrompt: opts.systemPrompt,
          userPrompt: opts.userPrompt,
        });
        if (json) {
          return {
            provider: 'openrouter_ai_advisor',
            modelLabel: 'OpenRouter Llama 3.3 70B Free (BYOK)',
            json,
          };
        }
      } else if (customProv === 'openai') {
        const json = await callOpenAiCompatibleJson({
          url: 'https://api.openai.com/v1/chat/completions',
          apiKey: customKey,
          model: 'gpt-4o-mini',
          systemPrompt: opts.systemPrompt,
          userPrompt: opts.userPrompt,
        });
        if (json) {
          return { provider: 'openai_ai_advisor', modelLabel: 'OpenAI GPT-4o-mini (BYOK)', json };
        }
      }
    } catch {
      // Fall through to next available provider
    }
  }

  // 2. Server-configured API keys (Vercel Environment Variables)
  const groqKey = process.env.GROQ_API_KEY?.trim();
  if (groqKey && opts.preferEngine !== 'free_cloud') {
    try {
      const json = await callOpenAiCompatibleJson({
        url: 'https://api.groq.com/openai/v1/chat/completions',
        apiKey: groqKey,
        model: process.env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile',
        systemPrompt: opts.systemPrompt,
        userPrompt: opts.userPrompt,
      });
      if (json) {
        return { provider: 'groq_ai_advisor', modelLabel: 'Groq Llama 3.3 70B', json };
      }
    } catch {
      // Continue waterfall
    }
  }

  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (geminiKey && opts.preferEngine !== 'free_cloud') {
    try {
      const json = await callGeminiJson({
        apiKey: geminiKey,
        systemPrompt: opts.systemPrompt,
        userPrompt: opts.userPrompt,
      });
      if (json) {
        return { provider: 'gemini_ai_advisor', modelLabel: 'Google Gemini 2.5 Flash', json };
      }
    } catch {
      // Continue waterfall
    }
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (openRouterKey && opts.preferEngine !== 'free_cloud') {
    try {
      const json = await callOpenAiCompatibleJson({
        url: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: openRouterKey,
        model: process.env.OPENROUTER_MODEL?.trim() || 'meta-llama/llama-3.3-70b-instruct:free',
        systemPrompt: opts.systemPrompt,
        userPrompt: opts.userPrompt,
      });
      if (json) {
        return { provider: 'openrouter_ai_advisor', modelLabel: 'OpenRouter Free LLM', json };
      }
    } catch {
      // Continue waterfall
    }
  }

  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  if (openAiKey && opts.preferEngine !== 'free_cloud') {
    try {
      const json = await callOpenAiCompatibleJson({
        url: 'https://api.openai.com/v1/chat/completions',
        apiKey: openAiKey,
        model: process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini',
        systemPrompt: opts.systemPrompt,
        userPrompt: opts.userPrompt,
      });
      if (json) {
        return { provider: 'openai_ai_advisor', modelLabel: 'OpenAI GPT-4o-mini', json };
      }
    } catch {
      // Continue waterfall
    }
  }

  // 3. Zero-Key Free Cloud AI Tier (Pollinations OpenAI-compatible JSON endpoint)
  // Skipped in automated Vitest runs so tests remain deterministic & offline-fast.
  if (!isTestEnv() && process.env.DISABLE_FREE_CLOUD_AI !== 'true') {
    try {
      const json = await callOpenAiCompatibleJson({
        url: 'https://text.pollinations.ai/openai',
        model: 'openai',
        timeoutMs: 6500,
        systemPrompt: opts.systemPrompt,
        userPrompt: opts.userPrompt,
      });
      if (json) {
        return {
          provider: 'free_cloud_ai',
          modelLabel: 'Free Cloud LLM (Zero-Key OpenAI-Compatible)',
          json,
        };
      }
    } catch {
      // Seamlessly fall back to SonicForge Own Acoustic AI
    }
  }

  return null;
}

function buildOwnDiagnosticBaseline(req: MasteringAdviseRequest): MasteringAdviceResponse {
  const src = req.source;
  const mst = req.renderedMaster;
  const archetype = classifyProgramArchetype(src);
  const observations: string[] = [];
  const actionableSteps: string[] = [];

  const loudnessGap = req.targetLufs - src.integratedLufs;
  observations.push(
    `Program classified as ${archetype.label} (${archetype.confidencePct}% acoustic match). Source Integrated Loudness is ${src.integratedLufs.toFixed(1)} LUFS (LRA ${src.loudnessRangeLu.toFixed(1)} LU, PLR ${src.plrDb.toFixed(1)} dB), requiring ${loudnessGap >= 0 ? '+' : ''}${loudnessGap.toFixed(1)} LU staging toward ${req.targetLufs.toFixed(1)} LUFS.`
  );

  if (src.ispMarginDb > 0.35) {
    observations.push(
      `Oversampled True Peak (${src.truePeakDbtp.toFixed(2)} dBTP) exceeds discrete Sample Peak (${src.samplePeakDbfs.toFixed(2)} dBFS) by +${src.ispMarginDb.toFixed(2)} dB — confirming inter-sample overshoot risk on DACs and lossy codecs.`
    );
  }

  if (src.lowBandCorrelation < 0.8) {
    observations.push(
      `Low-frequency (<150 Hz) stereo correlation is ${src.lowBandCorrelation.toFixed(2)}. Out-of-phase sub energy reduces club PA impact and mono headroom.`
    );
    actionableSteps.push(
      'Engage Elliptical Bass Mono around 125–145 Hz in the Stereo Imager module to lock kick and sub-bass into phase-coherent center.'
    );
  }

  if (src.monoFoldDownLossDb > 2.6) {
    observations.push(
      `Mono fold-down power loss is ${src.monoFoldDownLossDb.toFixed(1)} dB (broadband correlation ${src.correlation.toFixed(2)}).`
    );
    actionableSteps.push(
      'Audition in MONO SUM and Midrange Cube speaker voicing on the transport bar to verify vocal/snare balance.'
    );
  }

  const lowMidBand = src.bands.find((b) => b.id === 'lowMid');
  const highMidBand = src.bands.find((b) => b.id === 'highMid');
  if (lowMidBand && highMidBand && lowMidBand.relativeDb - highMidBand.relativeDb > 4.2) {
    actionableSteps.push(
      `Low-Mid energy (250–1,000 Hz) sits ${(lowMidBand.relativeDb - highMidBand.relativeDb).toFixed(1)} dB above High-Mid presence. Apply a -1.5 to -2.5 dB Mid bell around 280–320 Hz (Q 1.45) to clear boxiness before limiting.`
    );
  }

  if (src.spectralTiltDbPerOct < -4.3) {
    actionableSteps.push(
      `Spectral tilt is warm/dark (${src.spectralTiltDbPerOct.toFixed(1)} dB/oct, centroid ${Math.round(src.centroidHz)} Hz). Add +1.5 dB Side Air Shelf @ 12 kHz and 25% 2x Oversampled Tape Exciter.`
    );
  } else if (src.spectralTiltDbPerOct > -2.8) {
    actionableSteps.push(
      `Spectral tilt is bright (${src.spectralTiltDbPerOct.toFixed(1)} dB/oct). Engage the 75%-COLA STFT Spectral Stabilizer (De-Harsh mode, 45%) to tame 2.5–9 kHz peaks dynamically.`
    );
  }

  if (src.plrDb > 13.8) {
    actionableSteps.push(
      `High transient crest (${src.plrDb.toFixed(1)} dB PLR): switch Limiter to IRC-V Transient/Sustain Split (55–70% emphasis) with 8x True-Peak oversampling.`
    );
  }

  if (actionableSteps.length === 0) {
    actionableSteps.push(
      'Tonal balance and stereo correlation are well-staged; verify processing with LUFS-MATCHED A/B, Codec Artifact Solo, and 24-bit RIFF INFO WAV verification.'
    );
  }

  let complianceVerdict = `Awaiting post-render verification against ${req.targetLufs.toFixed(1)} LUFS / ${req.ceilingDbtp.toFixed(1)} dBTP.`;
  if (mst) {
    const luDiff = mst.integratedLufs - req.targetLufs;
    const tpPass = mst.truePeakDbtp <= req.ceilingDbtp + 0.05;
    complianceVerdict = tpPass
      ? `Rendered PCM verified at ${mst.integratedLufs.toFixed(2)} LUFS (${luDiff >= 0 ? '+' : ''}${luDiff.toFixed(2)} LU vs target) and ${mst.truePeakDbtp.toFixed(2)} dBTP True Peak (PASS ≤ ${req.ceilingDbtp.toFixed(1)} dBTP).`
      : `Rendered PCM True Peak (${mst.truePeakDbtp.toFixed(2)} dBTP) exceeds ${req.ceilingDbtp.toFixed(1)} dBTP ceiling — engage 8x True-Peak Limiter.`;
  }

  return {
    provider: 'sonicforge_own_ai',
    modelLabel: 'SonicForge Acoustic Neural-Heuristic Engine v2',
    archetype,
    headline: `Acoustic AI Diagnostic — "${req.trackName}" (${archetype.label})`,
    observations,
    actionableSteps,
    complianceVerdict,
    privacyNotice:
      'Audio PCM stays 100% in your browser; only compact numeric BS.1770/FFT telemetry was analyzed.',
  };
}

export async function generateMasteringAdvice(
  req: MasteringAdviseRequest,
  creds?: CustomAiCredentials
): Promise<MasteringAdviceResponse> {
  const baseline = buildOwnDiagnosticBaseline(req);

  const llm = await runMultiProviderJsonLlm({
    preferEngine: req.preferEngine,
    creds,
    systemPrompt: [
      'You are a world-class mastering engineer inside SonicForge Pro.',
      'Analyze real measured ITU-R BS.1770-5 loudness, polyphase True Peak, 6-band spectral distribution, and M/S correlation.',
      'Never invent unmeasured metrics. Cite the exact LUFS, dBTP, LRA, and tilt numbers provided.',
      'Return ONLY valid JSON with keys: {"headline": string, "observations": string[], "actionableSteps": string[]}.',
    ].join(' '),
    userPrompt: JSON.stringify({
      trackName: req.trackName,
      archetype: baseline.archetype,
      targetLufs: req.targetLufs,
      ceilingDbtp: req.ceilingDbtp,
      source: req.source,
      renderedMaster: req.renderedMaster,
    }),
  });

  if (
    llm &&
    typeof llm.json.headline === 'string' &&
    Array.isArray(llm.json.observations) &&
    Array.isArray(llm.json.actionableSteps) &&
    llm.json.observations.length > 0 &&
    llm.json.actionableSteps.length > 0
  ) {
    return {
      provider: llm.provider,
      modelLabel: llm.modelLabel,
      archetype: baseline.archetype,
      headline: llm.json.headline.slice(0, 220),
      observations: llm.json.observations.slice(0, 5).map((s) => String(s).slice(0, 380)),
      actionableSteps: llm.json.actionableSteps.slice(0, 5).map((s) => String(s).slice(0, 380)),
      complianceVerdict: baseline.complianceVerdict,
      privacyNotice: `Audio PCM never leaves your browser; numeric BS.1770/FFT summary metrics were analyzed via ${llm.modelLabel}.`,
    };
  }

  return baseline;
}

export async function generateMasteringChatReply(
  req: MasteringChatRequest,
  creds?: CustomAiCredentials
): Promise<MasteringChatResponse> {
  // 1. Always run SonicForge's deterministic natural-language DSP solver first
  // so parameter patches are mathematically bounded & ready even if LLM focuses on commentary.
  const ownTurn = solveNaturalLanguageMasteringCopilot({
    prompt: req.prompt,
    trackName: req.trackName,
    currentParams: req.currentParams as unknown as MasteringChainParams,
    source: req.source,
    master: req.renderedMaster,
    codecAudits: req.codecAudits,
  });

  const llm = await runMultiProviderJsonLlm({
    preferEngine: req.preferEngine,
    creds,
    systemPrompt: [
      'You are SonicForge Pro AI Co-Pilot, an expert mastering engineer.',
      'Answer the user prompt concisely (2-5 sentences) citing their REAL measured LUFS, True Peak dBTP, LRA, Spectral Tilt, Stereo Correlation, and Codec Overshoot.',
      'If patchItems are provided in dspActionsPrepared, explain why those exact EQ/Stabilizer/Multiband/Limiter changes help their track.',
      'Return ONLY valid JSON: {"reply": string}.',
    ].join(' '),
    userPrompt: JSON.stringify({
      userPrompt: req.prompt,
      trackName: req.trackName,
      archetype: ownTurn.archetype,
      sourceMetrics: req.source,
      masterMetrics: req.renderedMaster,
      codecAudits: req.codecAudits,
      dspActionsPrepared: ownTurn.patchItems,
      recentHistory: req.history?.slice(-4),
    }),
  });

  if (llm && typeof llm.json.reply === 'string' && llm.json.reply.trim().length > 15) {
    return {
      provider: llm.provider,
      modelLabel: llm.modelLabel,
      archetype: ownTurn.archetype,
      reply: llm.json.reply.trim().slice(0, 1400),
      patchItems: ownTurn.patchItems,
      updatedParams: ownTurn.updatedParams,
      privacyNotice: `Audio PCM stays 100% in your browser; co-pilot response powered by ${llm.modelLabel} + SonicForge DSP Patch Solver.`,
    };
  }

  return {
    provider: 'sonicforge_own_ai',
    modelLabel: ownTurn.modelLabel,
    archetype: ownTurn.archetype,
    reply: ownTurn.reply,
    patchItems: ownTurn.patchItems,
    updatedParams: ownTurn.updatedParams,
    privacyNotice:
      '100% self-contained SonicForge Acoustic Neural-Heuristic Engine — zero external API calls required.',
  };
}
