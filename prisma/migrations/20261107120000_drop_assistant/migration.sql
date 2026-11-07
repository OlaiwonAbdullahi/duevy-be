-- Remove the Duey AI assistant (LLM feature removed from the codebase).
DROP TABLE IF EXISTS "assistant_messages";
DROP TABLE IF EXISTS "assistant_conversations";
DROP TYPE IF EXISTS "AssistantIntent";
DROP TYPE IF EXISTS "AssistantRole";
