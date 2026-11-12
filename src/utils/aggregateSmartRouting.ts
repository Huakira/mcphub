export const AGGREGATE_SMART_SEGMENT = '$groups';
export const AGGREGATE_SMART_ROUTING_GROUP = `$smart/${AGGREGATE_SMART_SEGMENT}`;

export const META_TOOL_ACTIONS = ['search_tools', 'describe_tool', 'call_tool'] as const;
export type MetaToolAction = (typeof META_TOOL_ACTIONS)[number];

export const isAggregateSmartRoutingGroup = (group: string | undefined): boolean =>
  group === AGGREGATE_SMART_ROUTING_GROUP;

export const parseAggregateMetaTool = (
  name: string | undefined,
  groups: readonly string[],
): { group: string; action: MetaToolAction } | undefined => {
  if (!name) {
    return undefined;
  }
  const sorted = [...groups].sort((a, b) => b.length - a.length);
  for (const group of sorted) {
    for (const action of META_TOOL_ACTIONS) {
      if (name === `${group}_${action}`) {
        return { group, action };
      }
    }
  }
  return undefined;
};

export const prefixAggregateMetaTool = (group: string, action: string): string =>
  `${group}_${action}`;

export const rewriteAggregateMetaDescription = (description: string, group: string): string =>
  description
    .split('describe_tool')
    .join(`${group}_describe_tool`)
    .split('search_tools')
    .join(`${group}_search_tools`)
    .split('call_tool')
    .join(`${group}_call_tool`);
