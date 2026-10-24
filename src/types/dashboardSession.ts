export interface AssistantChatMessage {
  role: 'user' | 'assistant';
  text: string;
  createdAt?: number;
}

export interface MeetingAgentInsight {
  id: string;
  kind: 'decision' | 'action' | 'question' | 'risk';
  title: string;
  detail?: string;
  sourceExcerpt?: string;
  confidence?: 'low' | 'medium' | 'high';
}

export interface MeetingActionItem {
  id: string;
  text: string;
  owner?: string;
  dueDate?: string;
  status?: 'open' | 'done';
  sourceExcerpt?: string;
  confidence?: 'low' | 'medium' | 'high';
}

export interface MeetingAgentMemory {
  status: 'ready' | 'needs-review';
  decisions: MeetingAgentInsight[];
  actionItems: MeetingActionItem[];
  openQuestions: MeetingAgentInsight[];
  risks: MeetingAgentInsight[];
  insights: MeetingAgentInsight[];
  generatedAt?: number;
}

export interface DashboardSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  durationSeconds: number;
  transcriptPreview: string;
  transcriptText: string;
  refinedText?: string;
  source: string;
  status: 'completed' | 'draft';
  /** Structured lines for rich meeting detail modal (optional). */
  dialogueLines?: Array<{ speaker: string; text: string }>;
  refinedSummaryLine?: string;
  /** Full end-of-meeting summary (local AI); list cards use `refinedSummaryLine` / preview. */
  meetingSummary?: string;
  nextStepsLine?: string;
  showTranscribedBadge?: boolean;
  accentTag?: string;
  meetingContext?: string;
  topics?: string[];
  relatedSessionIds?: string[];
  contextSpaceIds?: string[];
  promptProfileId?: string;
  language?: 'es' | 'en';
  chatHistory?: AssistantChatMessage[];
  agentMemory?: MeetingAgentMemory;
  agentInsights?: MeetingAgentInsight[];
  actionItems?: MeetingActionItem[];
  decisions?: MeetingAgentInsight[];
  openQuestions?: MeetingAgentInsight[];
  risks?: MeetingAgentInsight[];
}
