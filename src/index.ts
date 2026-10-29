import { GoogleGenAI } from '@google/genai';

const GOOGLE_CLOUD_PROJECT = process.env['GOOGLE_CLOUD_PROJECT'];
const GOOGLE_CLOUD_LOCATION = process.env['GOOGLE_CLOUD_LOCATION'] || 'global';

async function generateContent(
  projectId: string | undefined = GOOGLE_CLOUD_PROJECT,
  location: string = GOOGLE_CLOUD_LOCATION
): Promise<string | undefined> {
  if (!projectId) {
    throw new Error('GOOGLE_CLOUD_PROJECT environment variable is required.');
  }

  const client = new GoogleGenAI({
    vertexai: true,
    project: projectId,
    location: location,
  });

  const response = await client.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: 'How does AI work?',
  });

  console.log(response.text);

  return response.text;
}

generateContent().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

