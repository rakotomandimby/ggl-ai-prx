import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { ApiError, GoogleGenAI } from '@google/genai';
import type {
  ContentListUnion,
  ContentUnion,
  CountTokensConfig,
  CountTokensParameters,
  CountTokensResponse,
  GenerateContentConfig,
  GenerateContentParameters,
  GenerateContentResponse,
  GenerationConfig,
  Tool,
} from '@google/genai';

// 1. Environment Variable Validation (Fail-Fast at Startup)
const GOOGLE_CLOUD_PROJECT = process.env['GOOGLE_CLOUD_PROJECT']?.trim();
const GOOGLE_CLOUD_LOCATION =
  process.env['GOOGLE_CLOUD_LOCATION']?.trim() || 'global';
const CLIENT_TOKEN = process.env['CLIENT_TOKEN']?.trim();
const PORT = Number(process.env['PORT'] ?? '3000');

if (!GOOGLE_CLOUD_PROJECT) {
  console.error(
    'Fatal Error: GOOGLE_CLOUD_PROJECT environment variable is required.'
  );
  process.exit(1);
}

if (!CLIENT_TOKEN) {
  console.error('Fatal Error: CLIENT_TOKEN environment variable is required.');
  process.exit(1);
}

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(
    `Fatal Error: Invalid PORT environment variable "${process.env['PORT'] ?? ''}".`
  );
  process.exit(1);
}

// 2. Upstream SDK Initialization (ADC Authentication)
const aiClient = new GoogleGenAI({
  vertexai: true,
  project: GOOGLE_CLOUD_PROJECT,
  location: GOOGLE_CLOUD_LOCATION,
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50mb' }));

// 3. Downstream Client Authentication Middleware
function authenticateClient(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const queryKey = req.query['key'];
  const headerKey = req.header('x-goog-api-key');

  const providedToken =
    typeof queryKey === 'string'
      ? queryKey
      : typeof headerKey === 'string'
        ? headerKey
        : undefined;

  if (!providedToken || providedToken !== CLIENT_TOKEN) {
    res.status(401).json({
      error: {
        code: 401,
        message: 'Invalid or missing API key.',
        status: 'UNAUTHENTICATED',
      },
    });
    return;
  }

  next();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildGenerateContentConfig(
  body: Record<string, unknown>
): GenerateContentConfig {
  const config: GenerateContentConfig = {
    automaticContinuation: false,
  };

  const generationConfig = body['generationConfig'];
  if (isRecord(generationConfig)) {
    Object.assign(config, generationConfig);
    if (
      generationConfig['modelConfig'] !== undefined &&
      config.modelSelectionConfig === undefined
    ) {
      config.modelSelectionConfig =
        generationConfig['modelConfig'] as NonNullable<
          GenerateContentConfig['modelSelectionConfig']
        >;
    }
  }

  const topLevelConfigKeys = [
    'systemInstruction',
    'safetySettings',
    'tools',
    'toolConfig',
    'cachedContent',
    'labels',
    'serviceTier',
    'modelArmorConfig',
    'continuationToken',
    'generationOutputConfig',
  ] as const;

  for (const key of topLevelConfigKeys) {
    if (body[key] !== undefined) {
      (config as Record<string, unknown>)[key] = body[key];
    }
  }

  if (
    body['outputConfig'] !== undefined &&
    config.generationOutputConfig === undefined
  ) {
    config.generationOutputConfig = body['outputConfig'] as NonNullable<
      GenerateContentConfig['generationOutputConfig']
    >;
  }

  return config;
}

function buildCountTokensConfig(
  body: Record<string, unknown>
): CountTokensConfig | undefined {
  const config: CountTokensConfig = {};
  let hasConfig = false;

  if (body['systemInstruction'] !== undefined) {
    config.systemInstruction = body['systemInstruction'] as ContentUnion;
    hasConfig = true;
  }
  if (body['tools'] !== undefined) {
    config.tools = body['tools'] as Tool[];
    hasConfig = true;
  }
  if (isRecord(body['generationConfig'])) {
    config.generationConfig = body['generationConfig'] as GenerationConfig;
    hasConfig = true;
  }

  return hasConfig ? config : undefined;
}

function serializeGenerateContentResponse(
  response: GenerateContentResponse
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if (response.candidates !== undefined) {
    payload['candidates'] = response.candidates;
  }
  if (response.promptFeedback !== undefined) {
    payload['promptFeedback'] = response.promptFeedback;
  }
  if (response.usageMetadata !== undefined) {
    payload['usageMetadata'] = response.usageMetadata;
  }
  if (response.modelVersion !== undefined) {
    payload['modelVersion'] = response.modelVersion;
  }
  if (response.responseId !== undefined) {
    payload['responseId'] = response.responseId;
  }
  if (response.createTime !== undefined) {
    payload['createTime'] = response.createTime;
  }
  if (response.modelStatus !== undefined) {
    payload['modelStatus'] = response.modelStatus;
  }

  return payload;
}

function serializeCountTokensResponse(
  response: CountTokensResponse
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(response)) {
    if (key !== 'sdkHttpResponse' && value !== undefined) {
      payload[key] = value;
    }
  }

  return payload;
}

function parseUpstreamErrorBody(
  status: number,
  message: string
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(message);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Check if the message embeds a JSON object (e.g. "got status: ... {...}")
    const jsonStart = message.indexOf('{');
    if (jsonStart >= 0) {
      try {
        const embedded: unknown = JSON.parse(message.slice(jsonStart));
        if (isRecord(embedded)) {
          return embedded;
        }
      } catch {
        // Fall through to standard error object
      }
    }
  }

  return {
    error: {
      code: status,
      message,
      status: 'UPSTREAM_ERROR',
    },
  };
}

// 4. Express Mode 1:1 Route Handler
async function handleModelAction(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const modelAction = req.params['modelAction'];
    const publisher = req.params['publisher'] ?? 'google';

    if (typeof modelAction !== 'string' || !modelAction.includes(':')) {
      res.status(400).json({
        error: {
          code: 400,
          message:
            'Invalid model action path. Expected format: /v1/publishers/google/models/{model}:{action}',
          status: 'INVALID_ARGUMENT',
        },
      });
      return;
    }

    const colonIndex = modelAction.lastIndexOf(':');
    const rawModelId = modelAction.slice(0, colonIndex).trim();
    const action = modelAction.slice(colonIndex + 1).trim();

    if (!rawModelId || !action) {
      res.status(400).json({
        error: {
          code: 400,
          message: 'Both model ID and action must be non-empty.',
          status: 'INVALID_ARGUMENT',
        },
      });
      return;
    }

    const model =
      publisher === 'google'
        ? rawModelId
        : `publishers/${String(publisher)}/models/${rawModelId}`;

    if (!isRecord(req.body) || req.body['contents'] === undefined) {
      res.status(400).json({
        error: {
          code: 400,
          message: 'Request body must be a JSON object containing "contents".',
          status: 'INVALID_ARGUMENT',
        },
      });
      return;
    }

    const contents = req.body['contents'] as ContentListUnion;

    if (action === 'generateContent') {
      const config = buildGenerateContentConfig(req.body);
      const params: GenerateContentParameters = {
        model,
        contents,
        config,
      };
      const response = await aiClient.models.generateContent(params);
      res.status(200).json(serializeGenerateContentResponse(response));
      return;
    }

    if (action === 'streamGenerateContent') {
      const config = buildGenerateContentConfig(req.body);
      const params: GenerateContentParameters = {
        model,
        contents,
        config,
      };
      const stream = await aiClient.models.generateContentStream(params);
      const isSse = req.query['alt'] === 'sse';

      if (isSse) {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        for await (const chunk of stream) {
          const payload = serializeGenerateContentResponse(chunk);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
        res.end();
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.write('[');
      let first = true;
      for await (const chunk of stream) {
        const payload = serializeGenerateContentResponse(chunk);
        if (!first) {
          res.write(',');
        }
        res.write(JSON.stringify(payload));
        first = false;
      }
      res.write(']');
      res.end();
      return;
    }

    if (action === 'countTokens') {
      const config = buildCountTokensConfig(req.body);
      const params: CountTokensParameters =
        config !== undefined
          ? { model, contents, config }
          : { model, contents };
      const response = await aiClient.models.countTokens(params);
      res.status(200).json(serializeCountTokensResponse(response));
      return;
    }

    res.status(400).json({
      error: {
        code: 400,
        message: `Unsupported model action "${action}". Supported actions are: generateContent, streamGenerateContent, countTokens.`,
        status: 'INVALID_ARGUMENT',
      },
    });
  } catch (error: unknown) {
    next(error);
  }
}

app.post(
  [
    '/v1/publishers/google/models/:modelAction',
    '/v1beta1/publishers/google/models/:modelAction',
    '/v1/publishers/:publisher/models/:modelAction',
    '/v1beta1/publishers/:publisher/models/:modelAction',
  ],
  authenticateClient,
  handleModelAction
);

// 5. Error Handling Middleware
app.use(
  (error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (res.headersSent) {
      res.end();
      return;
    }

    if (error instanceof ApiError) {
      const status =
        typeof error.status === 'number' &&
        error.status >= 400 &&
        error.status < 600
          ? error.status
          : 502;
      res.status(status).json(parseUpstreamErrorBody(status, error.message));
      return;
    }

    if (
      isRecord(error) &&
      typeof error['status'] === 'number' &&
      error['status'] >= 400 &&
      error['status'] < 600 &&
      typeof error['message'] === 'string'
    ) {
      const status = error['status'];
      res
        .status(status)
        .json(parseUpstreamErrorBody(status, error['message']));
      return;
    }

    console.error('Unhandled proxy error:', error);
    res.status(500).json({
      error: {
        code: 500,
        message:
          error instanceof Error ? error.message : 'Internal proxy error',
        status: 'INTERNAL',
      },
    });
  }
);

app.listen(PORT, () => {
  console.log(
    `Gemini Enterprise Agent Platform Express Mode Proxy listening on http://localhost:${String(PORT)} (project: ${GOOGLE_CLOUD_PROJECT}, location: ${GOOGLE_CLOUD_LOCATION})`
  );
});
