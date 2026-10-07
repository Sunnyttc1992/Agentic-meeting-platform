import { createHash } from 'node:crypto'

// Local embeddings for meeting chat retrieval. Vectors come from an embedding
// model served by Ollama on this computer (bge-m3 by default), so meeting text
// is never sent anywhere to be embedded. The endpoint must be a loopback
// address: a configuration pointing elsewhere is refused rather than trusted.
export const DEFAULT_EMBEDDING_MODEL = 'bge-m3'
const BATCH_SIZE = 32
const MAX_EMBED_TEXT = 2000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export function normalizeVector(values) {
  const norm = Math.hypot(...values)
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Embedding vector is empty')
  return values.map((value) => value / norm)
}

// Both vectors are unit length, so the dot product is the cosine similarity.
export function cosineSimilarity(a, b) {
  let sum = 0
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index]
  return sum
}

export const embeddingTextHash = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 32)

export class OllamaEmbedder {
  constructor({ baseUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434', model = process.env.MEETING_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL, fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
    const url = new URL(baseUrl)
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) throw new Error('The embedding service must run on this computer (a loopback http URL)')
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) throw new Error('Invalid embedding model name')
    this.endpoint = new URL('/api/embed', url).toString()
    this.model = model
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
  }

  async embed(texts) {
    const vectors = []
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const input = texts.slice(start, start + BATCH_SIZE).map((text) => String(text).slice(0, MAX_EMBED_TEXT))
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input, truncate: true }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) throw new Error(`Embedding service returned ${response.status}`)
      const embeddings = (await response.json())?.embeddings
      if (!Array.isArray(embeddings) || embeddings.length !== input.length) throw new Error('Embedding service returned an invalid response')
      const dimensions = embeddings[0]?.length
      for (const vector of embeddings) {
        if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every(Number.isFinite)) throw new Error('Embedding service returned an invalid vector')
        vectors.push(normalizeVector(vector))
      }
    }
    return vectors
  }
}
