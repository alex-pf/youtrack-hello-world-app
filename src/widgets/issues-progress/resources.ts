import type {EmbeddableWidgetAPI} from '../../../@types/globals';

// Re-export query assist from hello-world resources for now
// Full resources implementation in Phase 2

export async function queryAssistDataSource(
  host: EmbeddableWidgetAPI,
  params: {query: string; caret: number}
) {
  // Placeholder — will be implemented in Phase 2
  void host;
  return {query: params.query, caret: params.caret, suggestions: []};
}