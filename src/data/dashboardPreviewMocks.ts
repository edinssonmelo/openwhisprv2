import type { DashboardSessionSummary } from '../types/dashboardSession';

const UX_SPEAKERS = ['Alice', 'Bob', 'Charlie', 'Dana', 'Evan', 'Fatima', 'Gus', 'Hannah', 'Ian', 'Jordan'];

/** Long multi-speaker dialogue for scroll / density UX review in the meeting detail modal. */
function buildLongUxDialogue(lineCount: number): Array<{ speaker: string; text: string }> {
  return Array.from({ length: lineCount }, (_, i) => ({
    speaker: UX_SPEAKERS[i % UX_SPEAKERS.length],
    text:
      `Segment ${i + 1}: we review latency budgets, transcript overflow, and how the companion dock behaves beside a tall dialogue list. ` +
      `Design wants calmer backgrounds in dark mode; product wants copy actions always visible while scrolling; engineering will profile layout thrash ` +
      `once we exceed a few dozen turns. We agree to ship incrementally, capture screenshots at md and lg breakpoints, and file follow-ups for ` +
      `virtualization if real sessions routinely exceed two hundred lines.`,
  }));
}

const LONG_UX_DIALOGUE = buildLongUxDialogue(78);

const EXTRA_MOCK_TITLES = [
  'Security review — local-first storage',
  'Customer call: onboarding friction',
  'Sprint planning — dashboard polish',
  'Incident retro #441 (audio dropouts)',
  'Partnership sync — OEM bundle',
  'Accessibility audit checkpoints',
  'Performance: cold start & Whisper path',
  'Content strategy — release notes',
  'Support triage — macOS Sequoia',
  'Legal: recording consent copy',
  'Growth experiment — trial length',
  'Infrastructure — CI runners',
  'Mobile web spike (deferred)',
  'Research debrief — power users',
  'Pricing sensitivity workshop',
  'Design crit — meeting library cards',
  'Engineering sync — preload IPC',
  'Data retention policy draft',
  'QA sign-off — dark theme regressions',
  'All-hands — Q4 priorities teaser',
] as const;

function extraMockAt(index: number): DashboardSessionSummary {
  const title = EXTRA_MOCK_TITLES[index] ?? `Generated meeting ${index + 1}`;
  const day = 28 - (index % 24);
  const month = 9 - Math.floor(index / 8); /* Sep–Jul spread */
  const year = 2024;
  const createdAt = new Date(year, Math.max(0, month), Math.max(1, day), 10 + (index % 6), 15 * (index % 4), 0).getTime();
  const seed = index * 7;
  const lines = Array.from({ length: 6 + (index % 5) }, (_, j) => ({
    speaker: UX_SPEAKERS[(seed + j) % UX_SPEAKERS.length],
    text:
      `Topic “${title.slice(0, 32)}…” — turn ${j + 1}. We align on owners, dates, and risks. ` +
      `Open questions go to the parking lot; decisions are recorded in the summary line for dashboard cards.`,
  }));

  return {
    id: `mock-extra-${index + 1}`,
    title,
    createdAt,
    durationSeconds: (12 + (index % 9) * 7) * 60,
    transcriptPreview: `Follow-up from ${title}; decisions and parking-lot items captured for the library view.`,
    transcriptText: '',
    refinedText: '',
    source: index % 3 === 0 ? 'mixed' : index % 3 === 1 ? 'mic' : 'system',
    status: index % 4 === 0 ? 'draft' : 'completed',
    dialogueLines: lines,
    refinedSummaryLine:
      `${title}: aligned on next steps, noted two risks, and scheduled a checkpoint for UI validation.`,
    nextStepsLine: index % 2 === 0 ? 'Share notes with stakeholders.' : undefined,
    showTranscribedBadge: index % 3 !== 0,
    accentTag: index % 2 === 0 ? '#7dd3fc' : '#a78bfa',
  };
}

/** Demo meetings when the workspace has no saved sessions yet (UI review). */
export const DASHBOARD_PREVIEW_MOCKS: DashboardSessionSummary[] = [
  {
    id: 'mock-ux-long-transcript',
    title: 'UX stress test — very long transcript',
    createdAt: new Date('2024-11-18T16:00:00').getTime(),
    durationSeconds: 94 * 60,
    transcriptPreview:
      'Synthetic long dialogue to validate scrolling, speaker rhythm, and transcript actions in the meeting detail modal.',
    transcriptText: LONG_UX_DIALOGUE.map((l) => `${l.speaker}: ${l.text}`).join('\n\n'),
    refinedText: '',
    source: 'mixed',
    status: 'completed',
    dialogueLines: LONG_UX_DIALOGUE,
    refinedSummaryLine:
      'Stress session for layout: long dialogue list, copy actions, and companion dock beside a tall transcript.',
    nextStepsLine: 'Use this mock with dark mode and md/lg breakpoints before shipping transcript virtualization.',
    showTranscribedBadge: true,
    accentTag: '#4bfbba',
  },
  {
    id: 'mock-alignment',
    title: 'Openwhispr Product Alignment Sync',
    createdAt: new Date('2024-11-12T09:00:00').getTime(),
    durationSeconds: 45 * 60,
    transcriptPreview: 'Q4 roadmap, local engine accuracy, privacy certification.',
    transcriptText: '',
    refinedText: '',
    source: 'mixed',
    status: 'completed',
    dialogueLines: [
      {
        speaker: 'Alice',
        text: "Good morning everyone. Let's start by reviewing the Q4 roadmap and the local transcription accuracy.",
      },
      {
        speaker: 'Bob',
        text: "Sure, Alice. I've updated the sprint goals. We're seeing excellent results with the on-device engine.",
      },
      {
        speaker: 'Charlie',
        text: "Are we still on track for the 'no cloud' privacy certification?",
      },
      {
        speaker: 'Alice',
        text: 'Yes, all data remains local. Next we should lock the documentation for the release notes.',
      },
    ],
    refinedSummaryLine:
      'Discussed Q4 roadmap, sprint goal updates, and local transcription performance. Confirmed progress on privacy certification.',
    nextStepsLine: 'Finalize documentation.',
    showTranscribedBadge: true,
    accentTag: '#4bfbba',
  },
  {
    id: 'mock-design',
    title: 'Design System / Transcript UX',
    createdAt: new Date('2024-11-08T15:30:00').getTime(),
    durationSeconds: 32 * 60,
    transcriptPreview: 'Floating panel density, typography tokens for session view.',
    transcriptText: '',
    refinedText: '',
    source: 'mic',
    status: 'draft',
    dialogueLines: [
      { speaker: 'Maya', text: 'The floating panel feels dense — we should align line height with dashboard tokens.' },
      { speaker: 'Jordan', text: 'Agreed. I will spec Geist 13/18 for transcript body and tighten the control bar to 40px.' },
      { speaker: 'Maya', text: 'Perfect. Please add a pass for scrollbar contrast in the modal stacks.' },
    ],
  },
  {
    id: 'mock-audio',
    title: 'Audio routing diagnostics',
    createdAt: new Date('2024-11-05T11:00:00').getTime(),
    durationSeconds: 18 * 60,
    transcriptPreview: 'Loopback checks, mic levels, display capture path.',
    transcriptText: '',
    refinedText: '',
    source: 'system',
    status: 'completed',
    dialogueLines: [
      { speaker: 'Support', text: 'Can you confirm system audio is routing through the virtual device?' },
      { speaker: 'Alex', text: 'Yes — loopback shows signal. Mic peak is a bit hot at -6 dB.' },
      {
        speaker: 'Support',
        text: 'Drop input gain one step and retest display capture; we should see a clean stereo mix.',
      },
    ],
  },
  {
    id: 'mock-l10n',
    title: 'Spanish LATAM prompt tuning',
    createdAt: new Date('2024-11-01T17:45:00').getTime(),
    durationSeconds: 52 * 60,
    transcriptPreview: 'Context pack updates, glossary for banking terms.',
    transcriptText: '',
    refinedText: '',
    source: 'mixed',
    status: 'completed',
    dialogueLines: [
      { speaker: 'Laura', text: 'Necesitamos un glosario para “tif” y “fideicomiso” en el context pack.' },
      { speaker: 'Diego', text: 'Lo agrego en la versión 2 del pack y marco precedencia sobre el modelo genérico.' },
      { speaker: 'Laura', text: 'Bien. Después corremos el eval con las llamadas de octubre.' },
    ],
  },
  {
    id: 'mock-retro',
    title: 'Weekly retro — Openwhispr v2',
    createdAt: new Date('2024-10-28T10:00:00').getTime(),
    durationSeconds: 28 * 60,
    transcriptPreview: 'Overlay window modes, dashboard solid background follow-ups.',
    transcriptText: '',
    refinedText: '',
    source: 'mic',
    status: 'draft',
    dialogueLines: [
      { speaker: 'Sam', text: 'Wins: overlay hit-testing feels stable after the column selector fix.' },
      { speaker: 'Riley', text: 'Risks: dashboard window size feedback — we should track min resolution on small laptops.' },
      { speaker: 'Sam', text: 'Action: spike a compact layout pass next sprint. I will own the issue.' },
    ],
  },
  ...Array.from({ length: 20 }, (_, i) => extraMockAt(i)),
];
