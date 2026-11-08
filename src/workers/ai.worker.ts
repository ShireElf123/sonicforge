/// <reference lib="webworker" />

export type BrowserAiWorkerRequest =
  | {
      id: number;
      type: 'preload';
      modelId?: string;
    }
  | {
      id: number;
      type: 'generate';
      modelId?: string;
      systemPrompt: string;
      userPrompt: string;
      maxNewTokens?: number;
    };

export type BrowserAiWorkerResponse =
  | {
      id: number;
      type: 'progress';
      statusText: string;
      pct: number;
    }
  | {
      id: number;
      type: 'ready';
      device: 'webgpu' | 'wasm';
      modelId: string;
    }
  | {
      id: number;
      type: 'generated';
      text: string;
      device: 'webgpu' | 'wasm';
      modelId: string;
    }
  | {
      id: number;
      type: 'error';
      message: string;
    };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const DEFAULT_MODEL = 'HuggingFaceTB/SmolLM2-135M-Instruct';

interface TextGenPipeline {
  (
    messages: Array<{ role: string; content: string }>,
    options?: Record<string, unknown>
  ): Promise<Array<{ generated_text: string | Array<{ role: string; content: string }> }>>;
}

let cachedGenerator: TextGenPipeline | null = null;
let cachedModelId = '';
let cachedDevice: 'webgpu' | 'wasm' = 'wasm';

async function loadTransformersRuntime(): Promise<{
  pipeline: (
    task: string,
    model: string,
    opts?: Record<string, unknown>
  ) => Promise<TextGenPipeline>;
  env: Record<string, unknown>;
}> {
  const cdnUrls = [
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.2',
    'https://esm.sh/@huggingface/transformers@3.4.2',
  ];

  let lastErr: unknown = null;
  for (const url of cdnUrls) {
    try {
      const mod = await import(/* @vite-ignore */ url);
      if (mod && typeof mod.pipeline === 'function') {
        return mod;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('Unable to load @huggingface/transformers runtime from CDN');
}

async function detectPreferredDevice(): Promise<'webgpu' | 'wasm'> {
  try {
    const nav = self.navigator as Navigator & {
      gpu?: { requestAdapter?: () => Promise<unknown> };
    };
    if (nav?.gpu && typeof nav.gpu.requestAdapter === 'function') {
      const adapter = await nav.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch {
    // Fall back to WASM
  }
  return 'wasm';
}

async function ensureGenerator(
  reqId: number,
  modelId: string
): Promise<{ generator: TextGenPipeline; device: 'webgpu' | 'wasm'; modelId: string }> {
  if (cachedGenerator && cachedModelId === modelId) {
    return { generator: cachedGenerator, device: cachedDevice, modelId: cachedModelId };
  }

  ctx.postMessage({
    id: reqId,
    type: 'progress',
    statusText: 'Loading Transformers.js ONNX Web Runtime...',
    pct: 8,
  } satisfies BrowserAiWorkerResponse);

  const { pipeline, env } = await loadTransformersRuntime();
  env.allowLocalModels = false;
  env.useBrowserCache = true;

  const device = await detectPreferredDevice();

  ctx.postMessage({
    id: reqId,
    type: 'progress',
    statusText: `Initializing ${modelId} (${device.toUpperCase()} q4)...`,
    pct: 15,
  } satisfies BrowserAiWorkerResponse);

  const loadWithDevice = async (dev: 'webgpu' | 'wasm'): Promise<TextGenPipeline> =>
    pipeline('text-generation', modelId, {
      dtype: 'q4',
      device: dev,
      progress_callback: (info: {
        status?: string;
        file?: string;
        progress?: number;
      }) => {
        if (typeof info?.progress === 'number') {
          const pct = Math.min(98, Math.max(15, Math.round(15 + info.progress * 0.82)));
          const shortFile = info.file ? info.file.split('/').pop() : 'weights';
          ctx.postMessage({
            id: reqId,
            type: 'progress',
            statusText: `Caching ${shortFile} in browser (${Math.round(info.progress)}%)`,
            pct,
          } satisfies BrowserAiWorkerResponse);
        }
      },
    });

  let gen: TextGenPipeline;
  let actualDevice = device;
  try {
    gen = await loadWithDevice(device);
  } catch {
    if (device === 'webgpu') {
      actualDevice = 'wasm';
      gen = await loadWithDevice('wasm');
    } else {
      throw new Error('Failed to initialize browser ONNX LLM pipeline');
    }
  }

  cachedGenerator = gen;
  cachedModelId = modelId;
  cachedDevice = actualDevice;

  return { generator: gen, device: actualDevice, modelId };
}

ctx.onmessage = async (event: MessageEvent<BrowserAiWorkerRequest>) => {
  const msg = event.data;
  const targetModel = msg.modelId || DEFAULT_MODEL;

  try {
    if (msg.type === 'preload') {
      const { device, modelId } = await ensureGenerator(msg.id, targetModel);
      ctx.postMessage({
        id: msg.id,
        type: 'ready',
        device,
        modelId,
      } satisfies BrowserAiWorkerResponse);
    } else if (msg.type === 'generate') {
      const { generator, device, modelId } = await ensureGenerator(msg.id, targetModel);

      ctx.postMessage({
        id: msg.id,
        type: 'progress',
        statusText: `Running local ${device.toUpperCase()} neural inference...`,
        pct: 99,
      } satisfies BrowserAiWorkerResponse);

      const messages = [
        { role: 'system', content: msg.systemPrompt },
        { role: 'user', content: msg.userPrompt },
      ];

      const out = await generator(messages, {
        max_new_tokens: msg.maxNewTokens ?? 190,
        temperature: 0.25,
        do_sample: true,
        top_p: 0.9,
        return_full_text: false,
      });

      let text = '';
      const first = out?.[0]?.generated_text;
      if (typeof first === 'string') {
        text = first.trim();
      } else if (Array.isArray(first) && first.length > 0) {
        text = String(first[first.length - 1]?.content ?? '').trim();
      }

      ctx.postMessage({
        id: msg.id,
        type: 'generated',
        text,
        device,
        modelId,
      } satisfies BrowserAiWorkerResponse);
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Browser AI worker failed to run inference';
    ctx.postMessage({
      id: msg.id,
      type: 'error',
      message,
    } satisfies BrowserAiWorkerResponse);
  }
};
