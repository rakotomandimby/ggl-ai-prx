# ggl-ai-prx

A lightweight TypeScript proxy application that bridges **Gemini Enterprise Agent Platform Express Mode** clients with standard **Vertex AI / Gemini Enterprise Agent Platform** environments authenticated via Application Default Credentials (ADC).

## Overview

Applications built for Gemini Enterprise Agent Platform's **Express Mode** only require an API key (`?key=...` or `x-goog-api-key`) and omit the Google Cloud project ID and location from the request path. However, organizations with strict security policies often restrict Express Mode and mandate standard project-and-location-scoped authentication.

`ggl-ai-prx` solves this without requiring changes to client code:

1. **Exposes a 1:1 Express Mode HTTP Interface:** Accepts requests on standard Express Mode endpoints (`/v1/publishers/google/models/{model}:{action}`).
2. **Validates a Local Client Token:** Authenticates the downstream client using a locally defined `CLIENT_TOKEN` (via `?key=` query parameter or `x-goog-api-key` header).
3. **Forwards via Google Cloud ADC:** Uses the official `@google/genai` SDK (`vertexai: true`) configured with `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, and Application Default Credentials (`gcloud auth application-default login`).

## Features

- **1:1 Express Mode Endpoint Mapping:** Supports `/v1` and `/v1beta1` publisher model routes.
- **Supported Model Actions:**
  - `generateContent` (Unary content generation)
  - `streamGenerateContent` (Streaming responses as a JSON array or Server-Sent Events via `?alt=sse`)
  - `countTokens` (Token counting)
- **Full Configuration Passthrough:** Forwards `generationConfig`, `systemInstruction`, `safetySettings`, `tools`, `toolConfig`, `cachedContent`, `labels`, `serviceTier`, `modelArmorConfig`, `continuationToken`, and `generationOutputConfig` / `outputConfig`.
- **Fail-Fast Startup Validation:** Ensures required environment variables are present and valid before accepting traffic.

## Prerequisites

- **Node.js** (v20+ recommended)
- **Google Cloud SDK (`gcloud`)** installed and initialized
- A Google Cloud Project with the Vertex AI API enabled

Authenticate your local environment with Application Default Credentials:

```bash
gcloud init
gcloud auth application-default login
```

## Installation

```bash
npm install
```

## Configuration

The proxy is configured entirely via environment variables at startup:

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `GOOGLE_CLOUD_PROJECT` | **Yes** | — | Google Cloud project ID used for upstream Vertex AI requests. |
| `CLIENT_TOKEN` | **Yes** | — | Locally generated secret token that the client must provide in requests. |
| `GOOGLE_CLOUD_LOCATION` | No | `global` | Google Cloud region/location (e.g., `global`, `us-central1`). |
| `PORT` | No | `3000` | Local TCP port the HTTP server listens on (`1`–`65535`). |

## Running the Application

### Development Mode

Runs the TypeScript source directly using `tsx`:

```bash
export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
export GOOGLE_CLOUD_LOCATION="global"
export CLIENT_TOKEN="A_LOCALLY_GENERATED_KEY"

npm run dev
```

### Production Mode

Compile TypeScript to `dist/` and run with Node.js:

```bash
npm run build
npm start
```

## API Endpoints

```http
POST /v1/publishers/google/models/{model}:{action}
POST /v1beta1/publishers/google/models/{model}:{action}
POST /v1/publishers/{publisher}/models/{model}:{action}
POST /v1beta1/publishers/{publisher}/models/{model}:{action}
```

### Authentication

Provide `CLIENT_TOKEN` using either:
- Query parameter: `?key=${CLIENT_TOKEN}`
- HTTP header: `x-goog-api-key: ${CLIENT_TOKEN}`

## Usage Examples

### 1. Generate Content (`:generateContent`)

```bash
export CLIENT_TOKEN="A_LOCALLY_GENERATED_KEY"
MODEL_ID="gemini-2.5-flash"

curl -X POST \
  -H "Content-Type: application/json" \
  "http://localhost:3000/v1/publishers/google/models/${MODEL_ID}:generateContent?key=${CLIENT_TOKEN}" \
  -d '{
    "contents": [{
      "role": "user",
      "parts": [{
        "text": "How does AI work?"
      }]
    }]
  }'
```

### 2. Stream Generate Content (`:streamGenerateContent`)

**Standard JSON stream:**

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  "http://localhost:3000/v1/publishers/google/models/${MODEL_ID}:streamGenerateContent?key=${CLIENT_TOKEN}" \
  -d '{
    "contents": [{
      "role": "user",
      "parts": [{
        "text": "Write a haiku about cloud computing."
      }]
    }]
  }'
```

**Server-Sent Events (SSE):**

```bash
curl -N -X POST \
  -H "Content-Type: application/json" \
  "http://localhost:3000/v1/publishers/google/models/${MODEL_ID}:streamGenerateContent?alt=sse&key=${CLIENT_TOKEN}" \
  -d '{
    "contents": [{
      "role": "user",
      "parts": [{
        "text": "Write a haiku about cloud computing."
      }]
    }]
  }'
```

### 3. Count Tokens (`:countTokens`)

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  "http://localhost:3000/v1/publishers/google/models/${MODEL_ID}:countTokens?key=${CLIENT_TOKEN}" \
  -d '{
    "contents": [{
      "role": "user",
      "parts": [{
        "text": "How many tokens is this sentence?"
      }]
    }]
  }'
```

