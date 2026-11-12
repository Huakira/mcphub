import {
  AGGREGATE_SMART_ROUTING_GROUP,
  isAggregateSmartRoutingGroup,
  parseAggregateMetaTool,
  prefixAggregateMetaTool,
  rewriteAggregateMetaDescription,
} from '../../src/utils/aggregateSmartRouting.js';

describe('aggregate smart routing names', () => {
  const groups = ['webfetch', 'websearch_extended', 'notes', 'operations'];

  it('recognizes the reserved route', () => {
    expect(isAggregateSmartRoutingGroup(AGGREGATE_SMART_ROUTING_GROUP)).toBe(true);
    expect(isAggregateSmartRoutingGroup('$smart/webfetch')).toBe(false);
    expect(isAggregateSmartRoutingGroup('$smart')).toBe(false);
  });

  it('matches the longest group name first', () => {
    expect(parseAggregateMetaTool('websearch_extended_search_tools', groups)).toEqual({
      group: 'websearch_extended',
      action: 'search_tools',
    });
    expect(parseAggregateMetaTool('webfetch_call_tool', groups)).toEqual({
      group: 'webfetch',
      action: 'call_tool',
    });
    expect(parseAggregateMetaTool('search_tools', groups)).toBeUndefined();
    expect(parseAggregateMetaTool('webfetch_unknown', groups)).toBeUndefined();
  });

  it('rewrites meta-tool names in descriptions', () => {
    const rewritten = rewriteAggregateMetaDescription(
      'Use search_tools then call_tool. describe_tool is optional.',
      'notes',
    );
    expect(rewritten).toContain('notes_search_tools');
    expect(rewritten).toContain('notes_call_tool');
    expect(rewritten).toContain('notes_describe_tool');
    expect(rewritten.includes('search_tools') && !rewritten.includes('notes_search_tools')).toBe(
      false,
    );
  });

  it('prefixes listed tools', () => {
    expect(prefixAggregateMetaTool('operations', 'call_tool')).toBe('operations_call_tool');
  });
});
