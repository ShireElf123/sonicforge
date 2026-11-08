import type {
  BrowserAiWorkerRequest,
  BrowserAiWorkerResponse,
} from '../workers/ai.worker.js';

export interface BrowserAiStatus {
  state: 'idle' | 'loading' | 'ready' | 'fallback';
  label: string;
  pct: number;
}

interface ChromeLanguageModelSession {
  prompt: (input: string) => Promise<string>;
  destroy?: () => void;
}

interface ChromeLanguageModelFactory {
  availability?: () => Promise<string>;
  capabilities?: () => Promise<{ available?: string }>;
  create: (opts?: { systemPrompt?: string }) => Promise<ChromeLanguageModelSession>;
}

function getChromeBuiltInAi(): ChromeLanguageModelFactory | null {
  const g = globalThis as unknown as {
    LanguageModel?: ChromeLanguageModelFactory;
    ai?: { languageModel?: ChromeLanguageModelFactory };
  };
  return g.LanguageModel ?? g.ai?.languageModel ?? null;
}

class BrowserAiClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<
    number,
    {
      resolve: (res: BrowserAiWorkerResponse) => void;
      reject: (err: Error) => void;
      onProgress?: (statusText: string, pct: number) => void;
    }
  >();

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/ai.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (e: MessageEvent<BrowserAiWorkerResponse>) => {
        const msg = e.data;
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        if (msg.type === 'progress') {
          entry.onProgress?.(msg.statusText, msg.pct);
          return;
        }
        this.pending.delete(msg.id);
        if (msg.type === 'error') {
          entry.reject(new Error(msg.message));
        } else {
          entry.resolve(msg);
        }
      };
    }
    return this.worker;
  }

  async hasChromeBuiltInAi(): Promise<boolean> {
    const api = getChromeBuiltInAi();
    if (!api) return false;
    try {
      if (typeof api.availability === 'function') {
        const avail = await api.availability();
        return avail === 'available' || avail === 'downloadable' || avail === 'readily';
      }
      if (typeof api.capabilities === 'function') {
        const cap = await api.capabilities();
        return cap?.available === 'readily' || cap?.available === 'after-download';
      }
      return true;
    } catch {
      return false;
    }
  }

  async preloadTransformersModel(
    onProgress?: (statusText: string, pct: number) => void
  ): Promise<{ device: 'webgpu' | 'wasm'; modelId: string }> {
    const id = ++this.seq;
    const worker = this.getWorker();
    const res = await new Promise<BrowserAiWorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      const req: BrowserAiWorkerRequest = { id, type: 'preload' };
      worker.postMessage(req);
    });
    if (res.type === 'ready') {
      return { device: res.device, modelId: res.modelId };
    }
    throw new Error('Unexpected worker preload response');
  }

  async generateLocalResponse(
    systemPrompt: string,
    userPrompt: string,
    onProgress?: (statusText: string, pct: number) => void
  ): Promise<{
    text: string;
    engine: 'browser_window_ai' | 'browser_transformers_ai';
    modelLabel: string;
  }> {
    // 1. Prefer Chrome / Edge Built-in Gemini Nano (window.ai / LanguageModel) if ready
    const chromeAi = getChromeBuiltInAi();
    if (chromeAi) {
      try {
        onProgress?.('Using Browser Built-In Hardware AI (window.ai)...', 50);
        const session = await chromeAi.create({ systemPrompt });
        const text = (await session.prompt(userPrompt)).trim();
        session.destroy?.();
        if (text.length > 12) {
          return {
            text,
            engine: 'browser_window_ai',
            modelLabel: 'Browser Built-In AI (Gemini Nano / Prompt API)',
          };
        }
      } catch {
        // Fall through to Transformers.js ONNX WebGPU/WASM worker
      }
    }

    // 2. Run local ONNX LLM in Web Worker via Transformers.js (WebGPU / WASM)
    const id = ++this.seq;
    const worker = this.getWorker();
    const res = await new Promise<BrowserAiWorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      const req: BrowserAiWorkerRequest = {
        id,
        type: 'generate',
        systemPrompt,
        userPrompt,
        maxNewTokens: 180,
      };
      worker.postMessage(req);
    });

    if (res.type === 'generated' && res.text.trim().length > 0) {
      return {
        text: res.text.trim(),
        engine: 'browser_transformers_ai',
        modelLabel: `SmolLM2-135M-Instruct (${res.device.toUpperCase()} q4 Local)`,
      };
    }

    throw new Error('Empty local neural generation');
  }
}

export const browserAiClient = new BrowserAiClient();
