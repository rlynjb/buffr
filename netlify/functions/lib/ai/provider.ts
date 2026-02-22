import { BaseChatModel } from "@langchain/core/language_models/chat_models";

export function getLLM(provider: string): BaseChatModel {
  switch (provider) {
    case "anthropic": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
      // Dynamic import workaround: we import at module level since Netlify bundles
      const { ChatAnthropic } = require("@langchain/anthropic");
      return new ChatAnthropic({
        anthropicApiKey: apiKey,
        modelName: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
        temperature: 0.7,
      });
    }
    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
      const { ChatOpenAI } = require("@langchain/openai");
      return new ChatOpenAI({
        openAIApiKey: apiKey,
        modelName: process.env.OPENAI_MODEL || "gpt-4o",
        temperature: 0.7,
      });
    }
    case "google": {
      const apiKey = process.env.GOOGLE_API_KEY;
      if (!apiKey) throw new Error("GOOGLE_API_KEY not configured");
      const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
      return new ChatGoogleGenerativeAI({
        apiKey,
        modelName: process.env.GOOGLE_MODEL || "gemini-1.5-pro",
        temperature: 0.7,
      });
    }
    case "ollama": {
      const baseUrl = process.env.OLLAMA_BASE_URL;
      if (!baseUrl) throw new Error("OLLAMA_BASE_URL not configured");
      const { ChatOllama } = require("@langchain/ollama");
      return new ChatOllama({
        baseUrl,
        model: process.env.OLLAMA_MODEL || "llama3",
        temperature: 0.7,
      });
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export function getAvailableProviders(): Array<{
  name: string;
  label: string;
  model: string;
}> {
  const providers: Array<{ name: string; label: string; model: string }> = [];

  if (process.env.ANTHROPIC_API_KEY) {
    providers.push({
      name: "anthropic",
      label: "Claude",
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
    });
  }
  if (process.env.OPENAI_API_KEY) {
    providers.push({
      name: "openai",
      label: "GPT",
      model: process.env.OPENAI_MODEL || "gpt-4o",
    });
  }
  if (process.env.GOOGLE_API_KEY) {
    providers.push({
      name: "google",
      label: "Gemini",
      model: process.env.GOOGLE_MODEL || "gemini-1.5-pro",
    });
  }
  if (process.env.OLLAMA_BASE_URL) {
    providers.push({
      name: "ollama",
      label: "Ollama",
      model: process.env.OLLAMA_MODEL || "llama3",
    });
  }

  return providers;
}

export function getDefaultProvider(): string {
  return process.env.DEFAULT_LLM_PROVIDER || "anthropic";
}
