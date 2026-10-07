// Test helper: A deterministic stand-in for a real embedding model: related words share a
// concept dimension, so a paraphrase lands near its source.
const CONCEPTS = [
  ['relocat', 'move', 'moving', 'floor', 'office'],
  ['budget', 'fund', 'dollar', 'approv', 'supplier', 'vendor'],
  ['engineer', 'hiring', 'headcount', 'roles', 'recruit'],
  ['launch', 'go-live', 'portal', 'site', 'delay', 'training'],
  ['legal', 'agreement', 'sign-off', 'contract'],
  ['orion', 'board', 'divest'],
]
export function conceptEmbedder({ fail = false } = {}) {
  const embedded = []
  return {
    model: 'fake-concepts',
    embedded,
    embed: async (texts) => {
      if (fail) throw new Error('embedding service down')
      embedded.push(...texts)
      return texts.map((text) => {
        const lower = text.toLowerCase()
        const vector = CONCEPTS.map((words) => words.filter((word) => lower.includes(word)).length)
        vector.push(0.3)
        const norm = Math.hypot(...vector)
        return vector.map((value) => value / norm)
      })
    },
  }
}

