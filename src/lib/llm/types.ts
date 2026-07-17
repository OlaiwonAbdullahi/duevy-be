import { type ConversationTurn } from '../../types/assistant';

/** A chat-completion backend that can be swapped without touching handler code. */
export interface LLMAdapter {
  /** Returns the raw completion text — the caller is responsible for JSON-parsing and validating it. */
  complete(systemPrompt: string, turns: ConversationTurn[]): Promise<string>;
}

export class LLMTimeoutError extends Error {
  constructor(message = 'LLM request timed out') {
    super(message);
    this.name = 'LLMTimeoutError';
  }
}

export class LLMRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMRequestError';
  }
}
