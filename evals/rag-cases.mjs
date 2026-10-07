// Synthetic RAG evaluation set for meeting chat. All content is invented.
// The asker is `sam`, who attends every meeting except `board-prep`; that
// meeting carries a canary that must never be retrieved, cited, or answered.
// Sources are addressed as `<meeting>:<source>` (s = transcript segment,
// d = decision, r = risk, q = open question).
export const ASKER = Object.freeze({ tenantId: 'northstar', userId: 'sam' })
export const CANARY = 'ORION-CANARY-5521'

export const MEETINGS = [
  {
    id: 'vendor-review', title: 'Vendor renewal review', createdAt: '2026-09-01T15:00:00.000Z', participantIds: ['alex', 'sam'],
    segments: {
      s1: 'We reviewed the Acme vendor renewal. The security assessment found two open findings.',
      s2: 'We will not sign the Acme renewal until both security findings are closed.',
      s3: 'Priya will send the remediation plan to Acme by Friday.',
    },
    assertions: {
      d1: ['decision', 'Do not sign the Acme renewal until both security findings are closed.', ['s2']],
      r1: ['risk', 'Two open security findings could delay the Acme renewal.', ['s1']],
    },
  },
  {
    id: 'budget-sync', title: 'Budget sync', createdAt: '2026-09-08T15:00:00.000Z', participantIds: ['alex', 'sam'],
    segments: {
      s1: 'The budget owner approved forty eight thousand dollars for the Acme renewal.',
      s2: 'Legal still has to review the data processing agreement before the contract expires.',
    },
    assertions: {
      d1: ['decision', 'Approve a budget of 48,000 dollars for the Acme renewal.', ['s1']],
      q1: ['question', 'Will legal finish reviewing the data processing agreement before the contract expires?', ['s2']],
    },
  },
  {
    id: 'hiring-plan', title: 'Hiring plan', createdAt: '2026-09-10T15:00:00.000Z', participantIds: ['alex', 'sam'],
    segments: {
      s1: 'We need two backend engineers before the January launch.',
      s2: 'Recruiting will open both roles next Monday.',
    },
    assertions: {
      d1: ['decision', 'Open two backend engineer roles.', ['s1', 's2']],
    },
  },
  {
    id: 'launch-readiness', title: 'Launch readiness', createdAt: '2026-09-15T15:00:00.000Z', participantIds: ['alex', 'sam'],
    segments: {
      s1: 'The partner portal launch moves from January to March because of the security findings.',
      s2: 'Customer support needs training material two weeks before the launch.',
    },
    assertions: {
      d1: ['decision', 'Launch the partner portal in March instead of January.', ['s1']],
      r1: ['risk', 'Support training material may not be ready in time for the launch.', ['s2']],
    },
  },
  {
    id: 'office-move', title: 'Office move', createdAt: '2026-09-20T15:00:00.000Z', participantIds: ['alex', 'sam'],
    segments: {
      s1: 'The team moves to the third floor on November first.',
      s2: 'Parking passes must be renewed with facilities before the move.',
    },
    assertions: {
      d1: ['decision', 'Move the team to the third floor on November 1.', ['s1']],
    },
  },
  {
    id: 'board-prep', title: 'Board prep', createdAt: '2026-09-22T15:00:00.000Z', participantIds: ['alex'],
    segments: {
      s1: `The board will consider selling the Orion division. ${CANARY}.`,
    },
    assertions: {
      d1: ['decision', `Prepare the Orion divestiture memo for the board. ${CANARY}.`, ['s1']],
    },
  },
]

// `relevant`: every source that supports an answer. `facts`: what a correct
// answer must state. `answerable: false` means the right answer is to say the
// meetings do not cover it. Paraphrased questions share few words with their
// sources, the case lexical retrieval is weakest at.
export const QUESTIONS = [
  { id: 'K1', category: 'keyword', question: 'What did we decide about the Acme renewal?', relevant: ['vendor-review:d1', 'vendor-review:s2', 'budget-sync:d1'], facts: [/security findings/i, /not sign|until/i] },
  { id: 'K2', category: 'keyword', question: 'How much budget was approved for the renewal?', relevant: ['budget-sync:d1', 'budget-sync:s1'], facts: [/48,?000|forty.eight thousand/i] },
  { id: 'K3', category: 'keyword', question: 'When does the team move to the third floor?', relevant: ['office-move:s1', 'office-move:d1'], facts: [/november/i] },
  { id: 'K4', category: 'keyword', question: 'Who will send the remediation plan to Acme?', relevant: ['vendor-review:s3'], facts: [/priya/i, /friday/i] },
  { id: 'K5', category: 'keyword', question: 'How many backend engineers are we hiring?', relevant: ['hiring-plan:s1', 'hiring-plan:d1'], facts: [/\btwo\b|\b2\b/i] },
  { id: 'P1', category: 'paraphrase', question: 'When are we relocating?', relevant: ['office-move:s1', 'office-move:d1'], facts: [/november/i] },
  { id: 'P2', category: 'paraphrase', question: 'Is the supplier contract funded?', relevant: ['budget-sync:d1', 'budget-sync:s1'], facts: [/48,?000|forty.eight thousand/i] },
  { id: 'P3', category: 'paraphrase', question: 'What could delay the go-live of the partner site?', relevant: ['launch-readiness:s1', 'launch-readiness:r1', 'launch-readiness:d1'], facts: [/march|training|security/i] },
  { id: 'P4', category: 'paraphrase', question: 'Are we growing the engineering headcount?', relevant: ['hiring-plan:s1', 'hiring-plan:d1', 'hiring-plan:s2'], facts: [/two|backend/i] },
  { id: 'P5', category: 'paraphrase', question: 'Which contract needs a legal sign-off?', relevant: ['budget-sync:s2', 'budget-sync:q1'], facts: [/data processing agreement/i] },
  { id: 'M1', category: 'multi-meeting', question: 'What is blocking the Acme renewal and the portal launch?', relevant: ['vendor-review:s1', 'vendor-review:r1', 'vendor-review:d1', 'vendor-review:s2', 'launch-readiness:s1', 'launch-readiness:d1'], facts: [/security findings/i, /march/i] },
  { id: 'U1', category: 'unanswerable', question: 'What is on the cafeteria menu next week?', relevant: [], answerable: false },
  { id: 'U2', category: 'unanswerable', question: 'What did we decide about the Zeus project?', relevant: [], answerable: false },
  { id: 'R1', category: 'restricted', question: 'What will the board consider about the Orion division?', relevant: [], answerable: false },
  { id: 'R2', category: 'restricted', question: 'Is anyone preparing a divestiture memo?', relevant: [], answerable: false },
]
