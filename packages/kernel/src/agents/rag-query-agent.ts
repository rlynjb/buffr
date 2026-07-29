// packages/kernel/src/agents/rag-query-agent.ts
import { buildSynthesisInstruction, runAgentLoop } from '../workflow-runtime/run-agent-loop.js';
import { renderPromptTemplate, injectProfile } from './prompt-helpers.js';
import { filterToolsForPolicy } from '../tool-runtime/policy.js';
import { SEARCH_KNOWLEDGE_BASE_TOOL_NAME } from '../retrieval/search-tool.js';
import type { CapabilityTraceSink } from '../tracing.js';
import type { ModelProvider } from '../model-gateway/types.js';
import type { ToolRegistry } from '../tool-runtime/registry.js';
import type { PromptRegistry } from '../prompt-registry/index.js';

export const RAG_QUERY_CAPABILITY_ID = 'rag-query-agent';

const DEFAULT_SYSTEM_TEMPLATE = [
  'You are a personal knowledge assistant.',
  '',
  `Always call the ${SEARCH_KNOWLEDGE_BASE_TOOL_NAME} tool first to retrieve relevant`,
  'passages before answering. Ground every answer in the retrieved chunks and cite',
  'their sources. If the knowledge base does not contain the answer, say so plainly',
  'rather than guessing.',
].join('\n');

const PROFILE_HEADING = '# About the person you are assisting';
const FALLBACK_ANSWER = "I couldn't find anything in the knowledge base to answer that.";

export type RagQueryAgentOptions = {
  model: ModelProvider;
  tools: ToolRegistry;
  profile?: string;
  prompt?: string;
  promptRegistry?: PromptRegistry;
  promptName?: string;
  trace?: CapabilityTraceSink;
  allowedTools?: readonly string[];
};

export class RagQueryAgent {
  private readonly system: string;
  private readonly _promptVersion: string | undefined;

  get promptVersion(): string | undefined {
    return this._promptVersion;
  }

  constructor(private readonly options: RagQueryAgentOptions) {
    let template: string;
    let version: string | undefined;

    if (options.promptRegistry && options.promptName) {
      const entry = options.promptRegistry.get(options.promptName);
      template = entry.template;
      version = entry.version;
    } else {
      template = options.prompt ?? DEFAULT_SYSTEM_TEMPLATE;
    }

    this._promptVersion = version;
    const withProfile = options.profile
      ? injectProfile(template, options.profile, { position: 'start', heading: PROFILE_HEADING })
      : template;
    this.system = renderPromptTemplate(withProfile, {});
  }

  async answer(question: string, runOptions: { signal?: AbortSignal } = {}): Promise<string> {
    const allTools = await this.options.tools.listTools();
    const toolSchemas = filterToolsForPolicy(allTools, {
      capabilityId: RAG_QUERY_CAPABILITY_ID,
      allowedTools: this.options.allowedTools ?? [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],
    });

    const { finalText } = await runAgentLoop({
      capabilityId: RAG_QUERY_CAPABILITY_ID,
      model: this.options.model,
      tools: this.options.tools,
      system: this.system,
      userPrompt: question,
      toolSchemas,
      trace: this.options.trace,
      signal: runOptions.signal,
      maxTurns: 6,
      maxToolCalls: 4,
      synthesisInstruction: buildSynthesisInstruction(
        'Now answer the question directly and concisely, citing the sources you retrieved.',
      ),
    });

    return finalText.trim() || FALLBACK_ANSWER;
  }
}
