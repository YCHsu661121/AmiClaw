const http = require('http');
const https = require('https');

const targetBase = new URL(process.env.OLLAMA_TARGET || 'http://ai:11434');
const listenHost = process.env.OLLAMA_PROXY_HOST || '127.0.0.1';
const listenPort = Number(process.env.OLLAMA_PROXY_PORT || '11434');
const targetKind = (process.env.OLLAMA_TARGET_KIND || 'auto').toLowerCase();

function getClient(url) {
  return url.protocol === 'https:' ? https : http;
}

function readJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = getClient(url);
    const req = client.request(
      url,
      {
        method: 'GET',
        headers: {
          ...headers,
          host: url.host,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Upstream ${url.pathname} failed with ${res.statusCode}: ${body}`));
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Failed to parse upstream JSON from ${url.pathname}: ${error.message}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.end();
  });
}

function getModelId(model) {
  return model.model || model.name || model.id || '';
}

function normalizeModels(models, sourceKind) {
  return models.map((model) => ({
    ...model,
    slug: getModelId(model),
    display_name: model.name || model.id || model.model || getModelId(model),
    description: sourceKind === 'ollama'
      ? 'Ollama model exposed through a local Codex compatibility shim.'
      : 'OpenAI-compatible model exposed through a local Codex compatibility shim.',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    ],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 100,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: '',
    model_messages: {
      instructions_template: '',
      instructions_variables: {
        personality_default: '',
        personality_friendly: '',
        personality_pragmatic: '',
      },
    },
    supports_reasoning_summaries: true,
    default_reasoning_summary: 'none',
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    truncation_policy: {
      mode: 'tokens',
      limit: 10000,
    },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: model.details?.context_length || model.max_model_len || 32768,
    max_context_window: model.details?.context_length || model.max_model_len || 32768,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: Array.isArray(model.capabilities) && model.capabilities.includes('vision')
      ? ['text', 'image']
      : (Array.isArray(model.modalities) && model.modalities.includes('image') ? ['text', 'image'] : ['text']),
    supports_search_tool: true,
  }));
}

async function loadModelSource(req) {
  const ollamaModelsUrl = new URL('/api/tags', targetBase);
  const openAiModelsUrl = new URL('/v1/models', targetBase);

  if (targetKind === 'ollama') {
    const tagsPayload = await readJson(ollamaModelsUrl, req.headers);
    return { sourceKind: 'ollama', upstreamPayload: tagsPayload, models: Array.isArray(tagsPayload.models) ? tagsPayload.models : [] };
  }

  if (targetKind === 'vllm' || targetKind === 'openai' || targetKind === 'openai-compatible') {
    const modelsPayload = await readJson(openAiModelsUrl, req.headers);
    return { sourceKind: 'openai', upstreamPayload: modelsPayload, models: Array.isArray(modelsPayload.data) ? modelsPayload.data : [] };
  }

  try {
    const tagsPayload = await readJson(ollamaModelsUrl, req.headers);
    return { sourceKind: 'ollama', upstreamPayload: tagsPayload, models: Array.isArray(tagsPayload.models) ? tagsPayload.models : [] };
  } catch (ollamaError) {
    try {
      const modelsPayload = await readJson(openAiModelsUrl, req.headers);
      return { sourceKind: 'openai', upstreamPayload: modelsPayload, models: Array.isArray(modelsPayload.data) ? modelsPayload.data : [] };
    } catch (openAiError) {
      const error = new Error(`Unable to load models from ${targetBase.origin} as Ollama or OpenAI-compatible upstream`);
      error.cause = { ollamaError: ollamaError.message, openAiError: openAiError.message };
      throw error;
    }
  }
}

async function handleModels(req, res) {
  try {
    const { sourceKind, upstreamPayload, models } = await loadModelSource(req);
    const normalizedModels = normalizeModels(models, sourceKind);
    const data = normalizedModels.map((model) => ({
      id: getModelId(model),
      object: 'model',
      created: 0,
      owned_by: sourceKind === 'ollama' ? 'ollama' : (model.owned_by || 'openai-compatible'),
    }));

    const payload = {
      ...upstreamPayload,
      models: normalizedModels,
      object: 'list',
      data,
    };

    const body = JSON.stringify(payload);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (error) {
    const body = JSON.stringify({ error: error.message });
    res.writeHead(502, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }
}

function proxyRequest(req, res) {
  const upstreamUrl = new URL(req.url || '/', targetBase);
  const client = getClient(upstreamUrl);
  const proxyHeaders = {
    ...req.headers,
    host: upstreamUrl.host,
  };

  const createUpstreamRequest = (headers, bodyBuffer) => {
    const upstreamReq = client.request(
      upstreamUrl,
      {
        method: req.method,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );

    upstreamReq.on('error', (error) => {
      const body = JSON.stringify({ error: error.message });
      res.writeHead(502, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    });

    if (bodyBuffer) {
      upstreamReq.end(bodyBuffer);
      return;
    }

    req.pipe(upstreamReq);
  };

  const shouldSanitizeToolChoice =
    req.method === 'POST'
    && typeof req.url === 'string'
    && /^\/v1\/(chat\/completions|responses)(\?|$)/.test(req.url)
    && typeof req.headers['content-type'] === 'string'
    && req.headers['content-type'].toLowerCase().includes('application/json');

  if (!shouldSanitizeToolChoice) {
    createUpstreamRequest(proxyHeaders);
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('error', () => {
    const body = JSON.stringify({ error: 'Failed to read request body' });
    res.writeHead(400, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  });
  req.on('end', () => {
    let bodyBuffer = Buffer.concat(chunks);
    try {
      const parsed = JSON.parse(bodyBuffer.toString('utf8'));
      if (parsed && parsed.tool_choice === 'auto') {
        delete parsed.tool_choice;
        bodyBuffer = Buffer.from(JSON.stringify(parsed));
      }
    } catch {
      // Keep the original payload if it is not valid JSON.
    }

    const headers = {
      ...proxyHeaders,
      'content-length': String(bodyBuffer.length),
    };
    delete headers['transfer-encoding'];

    createUpstreamRequest(headers, bodyBuffer);
  });
}

const server = http.createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);

  if (req.method === 'GET' && (req.url || '').startsWith('/v1/models')) {
    handleModels(req, res);
    return;
  }

  proxyRequest(req, res);
});

server.listen(listenPort, listenHost, () => {
  console.log(`Codex proxy listening on http://${listenHost}:${listenPort} -> ${targetBase.origin} (${targetKind})`);
});