// The redesign's grouped rows in a FlatList that mixes headers and rows: each
// run of rows under one header reads as one card (foundation
// listGroupItemStyle), a divider between rows. The run's ends come from the
// neighbours: a row is first when the item before isn't a row of its section,
// last when the item after isn't.
import { listGroupItemStyle, type ListGroupItemStyle } from '@just-messin-around/expo-foundation/ui/listGroupItem';

type Groupable = { kind: string; section?: string };

/** Whether `items[index]` starts and ends its run of same-section rows. */
export function groupedRowEdges(items: readonly Groupable[], index: number): { first: boolean; last: boolean } {
  const it = items[index];
  const same = (o: Groupable | undefined) => !!o && o.kind === 'row' && o.section === it.section;
  return { first: !same(items[index - 1]), last: !same(items[index + 1]) };
}

/** The row's card edges, from its run's ends. */
export function groupedRowStyle(
  c: { surface: string; border: string; radiusCard?: number },
  edges: { first: boolean; last: boolean },
): ListGroupItemStyle {
  // listGroupItemStyle takes a position in a run: stand in a 1- to 3-row run.
  const i = edges.first ? 0 : 1;
  return listGroupItemStyle(c, i, edges.last ? i + 1 : i + 2);
}
