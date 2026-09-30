declare module "@langchain/playground-agents" {
  export const agent: any;
  export type MathSolution = { problem: string; steps: { explanation: string; latex: string }[]; finalAnswer: string; finalAnswerLatex: string };
  export type GenerativeUISpec = any;
  export type ToolCallFromTool<T> = any;
  const _default: any;
  export default _default;
  export { _default as simpleAgent, _default as toolCallingAgent, _default as reasoningAgent, _default as timeTravelAgent, _default as structuredOutputAgent, _default as asyncIteratorToolsAgent, _default as joinRejoinAgent, _default as deepAgentSubagentCardsAgent, _default as deepAgentTodoListAgent, _default as humanInTheLoopAgent, _default as generativeUIAgent, _default as openuiAgent, _default as headlessToolsAgent, _default as deepAgentIdeAgent, _default as graphExecutionCardsGraph, _default as weatherTool, _default as calculatorTool, _default as searchWebTool, _default as researchTool, _default as deepSearchTool, _default as emailTool };
}
